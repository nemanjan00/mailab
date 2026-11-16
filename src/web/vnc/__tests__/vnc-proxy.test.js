const fs = require("fs");
const os = require("os");
const path = require("path");
const WsClient = require("ws");
const labModule = require("../../../lab");
const authModule = require("../../../auth");
const rfb = require("../../../services/rfb");
const web = require("../..");
const proxy = require("..");
const fake = require("../../../services/rfb/__fixtures__/fake-server");

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

// what a browser gets when the upgrade is refused: the HTTP status
const refused = (url, headers) => new Promise((resolve, reject) => {
	const sock = new WsClient(url, { headers: headers || {} });
	sock.on("unexpected-response", (_req, res) => resolve(res.statusCode));
	sock.on("open", () => {
		sock.close();
		reject(new Error("connected"));
	});
	sock.on("error", () => null);
});

// a noVNC stand-in: the client half of the handshake over the WebSocket
const browser = (url, headers) => {
	const reader = rfb.createReader();
	const sock = new WsClient(url, { headers: headers });
	sock.on("message", (data) => reader.push(Buffer.from(data)));
	sock.on("close", () => reader.fail(new Error("closed")));
	const send = (b) => sock.send(b);
	return new Promise((resolve, reject) => {
		sock.on("open", resolve);
		sock.on("error", reject);
	})
		.then(() => rfb.handshake(reader, send, {}))
		.then((info) => ({ sock: sock, info: info, reader: reader, send: send }));
};

const keyEvent = (keysym) => {
	const b = Buffer.alloc(8);
	b[0] = 4;
	b[1] = 1;
	b.writeUInt32BE(keysym, 4);
	return b;
};

const updateRequest = () => Buffer.from([3, 0, 0, 0, 0, 0, 0, 16, 0, 8]);

describe("vnc websocket proxy", () => {
	let lab;
	let server;
	let vncServer;
	let base;

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-vnc-")), channelCapacity: 100 });
		const auth = authModule.create(authModule.parseTokens("alice:a-token:human,viewer:v-token:ro"));
		server = web.create(lab, { pushIntervalMs: 50, auth: auth }).server;
		return lab.restore()
			.then(() => fake.start({ width: 16, height: 8, security: "vnc", password: "s3cret", name: "dpgm" }))
			.then((s) => {
				vncServer = s;
				return lab.addDevice("desk", "vnc", { port: vncServer.port, password: "s3cret" });
			})
			.then(() => lab.addDevice("sim", "sim", {}))
			.then(() => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)))
			.then(() => {
				base = "ws://127.0.0.1:" + server.address().port;
			});
	});

	afterAll(() => {
		server.close();
		return lab.shutdown().then(() => vncServer.close());
	});

	test("refuses unauthenticated clients, other origins and non-vnc targets", () => {
		const ok = { authorization: "Bearer a-token" };
		return refused(base + "/ws/vnc/desk")
			.then((code) => {
				expect(code).toBe(401);
				return refused(base + "/ws/vnc/desk", { authorization: "Bearer wrong" });
			})
			.then((code) => {
				expect(code).toBe(401);
				return refused(base + "/ws/vnc/desk", Object.assign({ origin: "http://evil.example" }, ok));
			})
			.then((code) => {
				expect(code).toBe(403);
				return refused(base + "/ws/vnc/nope", ok);
			})
			.then((code) => {
				expect(code).toBe(404);
				// an existing device of another driver is not a target either
				return refused(base + "/ws/vnc/sim", ok);
			})
			.then((code) => {
				expect(code).toBe(404);
				return refused(base + "/ws/vnc/127.0.0.1:22", ok);
			})
			.then((code) => {
				expect(code).toBe(404);
				return refused(base + "/ws/other", ok);
			})
			.then((code) => expect(code).toBe(404));
	});

	test("the main /ws push socket still works next to the proxy", () => {
		const sock = new WsClient(base + "/ws", { headers: { authorization: "Bearer a-token" } });
		return new Promise((resolve, reject) => {
			sock.on("message", (data) => resolve(JSON.parse(data)));
			sock.on("error", reject);
		}).then((msg) => {
			expect(msg.type).toBe("state");
			// the password is masked in what browsers see
			expect(msg.state.devices.find((d) => d.id === "desk").options.password).toBe("***");
			sock.close();
		});
	});

	test("authenticates server-side (security None to the browser) and relays input for writers", () => {
		const before = vncServer.events.length;
		return browser(base + "/ws/vnc/desk", { authorization: "Bearer a-token" })
			.then((b) => {
				expect(b.info).toMatchObject({ version: "3.8", security: "none", width: 16, height: 8, name: "dpgm" });
				b.send(updateRequest());
				b.send(keyEvent(0x61));
				return until(() => vncServer.events.slice(before).some((e) => e.type === "key"), 2000)
					.then(() => b.reader.read(4))
					.then((head) => {
						// a full Raw update came through the relay
						expect(head[0]).toBe(0);
						expect(head.readUInt16BE(2)).toBe(1);
						expect(vncServer.events.slice(before).find((e) => e.type === "key").keysym).toBe(0x61);
						b.sock.close();
					});
			});
	});

	test("read-only users are view-only: input is dropped, updates pass", () => {
		const before = vncServer.events.length;
		return browser(base + "/ws/vnc/desk", { authorization: "Bearer v-token" })
			.then((b) => {
				b.send(keyEvent(0x62));
				b.send(Buffer.from([5, 1, 0, 1, 0, 1]));
				b.send(updateRequest());
				return until(() => vncServer.events.slice(before).some((e) => e.type === "updateRequest"), 2000)
					.then(() => {
						const seen = vncServer.events.slice(before).map((e) => e.type);
						expect(seen).not.toContain("key");
						expect(seen).not.toContain("pointer");
						b.sock.close();
					});
			});
	});

	test("unknown client messages close the connection", () => {
		return browser(base + "/ws/vnc/desk", { authorization: "Bearer a-token" })
			.then((b) => new Promise((resolve) => {
				b.sock.on("close", resolve);
				b.send(Buffer.from([99, 0, 0, 0]));
			}));
	});
});

describe("client message parser", () => {
	const parse = (bytes) => {
		const r = rfb.createReader();
		r.push(Buffer.from(bytes));
		return proxy.readClientMessage(r);
	};

	test("sizes and input classification", () => {
		return Promise.all([
			parse([2, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0]),
			parse([5, 0x81, 0, 1, 0, 2, 0]),
			parse([6, 0, 0, 0, 0, 0, 0, 2, 104, 105]),
			parse([255, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 30])
		]).then((msgs) => {
			expect(msgs.map((m) => [m.type, m.input, m.bytes.length])).toEqual([[2, false, 12], [5, true, 7], [6, true, 10], [255, true, 12]]);
		});
	});

	test("rejects oversized clipboard and unknown types", () => {
		return expect(parse([6, 0, 0, 0, 0x10, 0, 0, 0])).rejects.toThrow("clipboard too large")
			.then(() => expect(parse([7])).rejects.toThrow("unsupported client message type 7"));
	});
});
