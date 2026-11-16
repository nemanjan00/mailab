const rfb = require("..");
const fake = require("../__fixtures__/fake-server");

const until = (cond, ms) => new Promise((resolve, reject) => {
	const started = Date.now();
	const poll = () => {
		if (cond()) {
			resolve();
		} else if (Date.now() - started > ms) {
			reject(new Error("timeout"));
		} else {
			setTimeout(poll, 5);
		}
	};
	poll();
});

const pixel = (client, x, y) => Array.from(client.framebuffer.subarray((y * client.width + x) * 4, (y * client.width + x) * 4 + 3));

describe("rfb reader", () => {
	test("reads exact byte counts across chunks", () => {
		const r = rfb.createReader();
		const got = r.read(5);
		r.push(Buffer.from([1, 2]));
		r.push(Buffer.from([3, 4, 5, 6]));
		return got.then((b) => {
			expect(Array.from(b)).toEqual([1, 2, 3, 4, 5]);
			expect(Array.from(r.drain())).toEqual([6]);
		});
	});

	test("fails pending reads when the stream ends", () => {
		const r = rfb.createReader();
		const got = r.read(4);
		r.push(Buffer.from([1]));
		r.fail(new Error("closed"));
		return expect(got).rejects.toThrow("closed");
	});

	test("parses versions", () => {
		expect(rfb.parseVersion(Buffer.from("RFB 003.008\n"))).toBe(8);
		expect(rfb.parseVersion(Buffer.from("RFB 003.007\n"))).toBe(7);
		expect(rfb.parseVersion(Buffer.from("RFB 003.003\n"))).toBe(3);
		expect(rfb.parseVersion(Buffer.from("RFB 003.889\n"))).toBe(8);
		expect(() => rfb.parseVersion(Buffer.from("SSH-2.0-xxxx"))).toThrow("not an RFB server");
	});
});

describe("rfb client against a fake server", () => {
	const cases = [
		{ version: 8, security: "none" },
		{ version: 8, security: "vnc", password: "secret" },
		{ version: 7, security: "none" },
		{ version: 7, security: "vnc", password: "secret" },
		{ version: 3, security: "none" },
		{ version: 3, security: "vnc", password: "secret" }
	];

	cases.forEach((c) => {
		test("handshake RFB 3." + c.version + " security " + c.security + ", full Raw update", () => {
			let server = null;
			let client = null;
			return fake.start(Object.assign({ width: 8, height: 4, name: "bench" }, c))
				.then((s) => {
					server = s;
					server.fb.fill(0x40);
					client = rfb.connect({ port: server.port, password: c.password });
					return client.ready;
				})
				.then((info) => {
					expect(info).toMatchObject({ version: "3." + c.version, security: c.security, width: 8, height: 4, name: "bench" });
					return until(() => client.stats().updates >= 1, 2000);
				})
				.then(() => {
					expect(pixel(client, 7, 3)).toEqual([0x40, 0x40, 0x40]);
					expect(server.events.find((e) => e.type === "clientInit").shared).toBe(1);
					const enc = server.events.find((e) => e.type === "encodings");
					expect(enc.list).toEqual([1, 0, -223]);
				})
				.finally(() => {
					if (client) {
						client.close();
					}
					return server && server.close();
				});
		});
	});

	test("wrong password is refused with the server's reason", () => {
		let server = null;
		return fake.start({ version: 8, security: "vnc", password: "secret" })
			.then((s) => {
				server = s;
				return rfb.connect({ port: server.port, password: "nope" }).ready;
			})
			.then(() => {
				throw new Error("should fail");
			}, (err) => {
				expect(err.message).toBe("authentication failed: wrong password");
			})
			.finally(() => server.close());
	});

	test("VNC auth without a password says so", () => {
		let server = null;
		return fake.start({ version: 8, security: "vnc", password: "secret" })
			.then((s) => {
				server = s;
				return rfb.connect({ port: server.port }).ready;
			})
			.then(() => {
				throw new Error("should fail");
			}, (err) => {
				expect(err.message).toMatch("wants a VNC password");
			})
			.finally(() => server.close());
	});

	test("Raw and CopyRect incremental updates, input events", () => {
		let server = null;
		let client = null;
		const updates = [];
		return fake.start({ width: 16, height: 8 })
			.then((s) => {
				server = s;
				client = rfb.connect({ port: server.port });
				client.on("update", (rects) => updates.push(rects));
				return client.ready;
			})
			.then(() => until(() => updates.length >= 1, 2000))
			.then(() => {
				server.fill(1, 1, 3, 2, [255, 0, 0]);
				return until(() => updates.length >= 2, 2000);
			})
			.then(() => {
				expect(updates[1]).toEqual([{ x: 1, y: 1, w: 3, h: 2 }]);
				expect(pixel(client, 2, 2)).toEqual([255, 0, 0]);
				expect(pixel(client, 5, 2)).toEqual([0, 0, 0]);
				// overlapping copy to the right
				server.copy(1, 1, 2, 1, 3, 2);
				return until(() => updates.length >= 3, 2000);
			})
			.then(() => {
				expect(Array.from(client.framebuffer)).toEqual(Array.from(server.fb));
				expect(pixel(client, 4, 2)).toEqual([255, 0, 0]);
				client.key(0xff0d, true);
				client.key(0xff0d, false);
				client.pointer(5, 6, 1);
				client.cutText("hello");
				return until(() => server.events.some((e) => e.type === "cut"), 2000);
			})
			.then(() => {
				expect(server.events.filter((e) => e.type === "key")).toEqual([
					{ type: "key", down: 1, keysym: 0xff0d },
					{ type: "key", down: 0, keysym: 0xff0d }
				]);
				expect(server.events.find((e) => e.type === "pointer")).toEqual({ type: "pointer", mask: 1, x: 5, y: 6 });
				expect(server.events.find((e) => e.type === "cut").text).toBe("hello");
				// one incremental request in flight after each update
				expect(server.events.filter((e) => e.type === "updateRequest" && e.incremental).length).toBeGreaterThanOrEqual(2);
			})
			.finally(() => {
				if (client) {
					client.close();
				}
				return server && server.close();
			});
	});

	test("emits close with an error when the server goes away", () => {
		let server = null;
		const client = { c: null };
		return fake.start({})
			.then((s) => {
				server = s;
				client.c = rfb.connect({ port: server.port });
				return client.c.ready;
			})
			.then(() => {
				const closed = new Promise((resolve) => client.c.on("close", resolve));
				server.close();
				return closed;
			})
			.then((err) => {
				expect(err).toBeTruthy();
			});
	});

	test("connection refused rejects ready", () => {
		return fake.start({}).then((s) => s.close().then(() => s.port)).then((port) => {
			return expect(rfb.connect({ port: port }).ready).rejects.toThrow();
		});
	});
});
