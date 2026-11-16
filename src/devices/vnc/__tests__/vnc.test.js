const zlib = require("zlib");
const vnc = require("..");
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

const mockIo = () => {
	const io = { id: "desk", images: [], logs: [], statuses: [], values: [] };
	io.image = (name, data, mime) => io.images.push({ name: name, data: data, mime: mime });
	io.log = (text, level) => io.logs.push({ text: text, level: level });
	io.status = (state, detail) => io.statuses.push({ state: state, detail: detail });
	io.value = (name, value) => io.values.push({ name: name, value: value });
	return io;
};

// IHDR size + inflated scanlines of a PNG
const readPng = (buf) => {
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	const idatLen = buf.readUInt32BE(33);
	return { width: width, height: height, raw: zlib.inflateSync(buf.subarray(41, 41 + idatLen)) };
};

describe("vnc driver", () => {
	let server;
	let io;
	let dev;

	beforeEach(() => {
		return fake.start({ width: 16, height: 8, security: "vnc", password: "pw", name: "dpgm" }).then((s) => {
			server = s;
			server.fb.fill(0);
			io = mockIo();
			dev = vnc.create({ port: server.port, password: "pw" }, io);
			return dev.start();
		}).then(() => until(() => io.statuses.some((s) => s.state === "running"), 2000));
	});

	afterEach(() => {
		return dev.stop().then(() => server.close());
	});

	test("connects, never logs the password, reports status", () => {
		expect(io.logs.map((l) => l.text).join("\n")).not.toContain("pw\"");
		expect(io.logs[0].text).toMatch(/connected to 127.0.0.1:\d+ \(RFB 3.8, security vnc, 16x8 "dpgm"\)/);
		return dev.command("status").then((s) => {
			expect(s).toMatchObject({ connected: true, width: 16, height: 8, name: "dpgm", security: "vnc" });
			expect(JSON.stringify(s)).not.toContain("pw");
		});
	});

	test("screenshot: PNG of the framebuffer (and of a region)", () => {
		server.fill(2, 1, 2, 2, [10, 20, 30]);
		return dev.command("wait_change", { timeoutMs: 2000 })
			.then(() => dev.command("screenshot"))
			.then((res) => {
				expect(res._image.mime).toBe("image/png");
				expect(io.images[io.images.length - 1].name).toBe("screen");
				const img = readPng(Buffer.from(res._image.data, "base64"));
				expect([img.width, img.height]).toEqual([16, 8]);
				// row 1, pixel 2 (filter byte first)
				const at = 1 * (16 * 3 + 1) + 1 + 2 * 3;
				expect(Array.from(img.raw.subarray(at, at + 3))).toEqual([10, 20, 30]);
				return dev.command("screenshot", { region: { x: 2, y: 1, w: 2, h: 2 } });
			})
			.then((res) => {
				const img = readPng(Buffer.from(res._image.data, "base64"));
				expect([img.width, img.height]).toEqual([2, 2]);
				expect(Array.from(img.raw)).toEqual([0, 10, 20, 30, 10, 20, 30, 0, 10, 20, 30, 10, 20, 30]);
			});
	});

	test("type and key send keysyms", () => {
		return dev.command("type", { text: "Hi\n", delayMs: 0 })
			.then(() => dev.command("key", { keys: "ctrl+alt+del", delayMs: 0 }))
			.then(() => until(() => server.events.filter((e) => e.type === "key").length >= 14, 2000))
			.then(() => {
				const keys = server.events.filter((e) => e.type === "key").map((e) => (e.down ? "+" : "-") + e.keysym.toString(16));
				expect(keys).toEqual(["+ffe1", "+48", "-48", "-ffe1", "+69", "-69", "+ff0d", "-ff0d",
					"+ffe3", "+ffe9", "+ffff", "-ffff", "-ffe9", "-ffe3"]);
			});
	});

	test("click and drag send pointer events", () => {
		return dev.command("click", { x: 5, y: 6, button: "right" })
			.then(() => until(() => server.events.filter((e) => e.type === "pointer").length >= 3, 2000))
			.then(() => {
				const p = server.events.filter((e) => e.type === "pointer").map((e) => [e.mask, e.x, e.y]);
				expect(p).toEqual([[0, 5, 6], [4, 5, 6], [0, 5, 6]]);
				return expect(dev.command("click", { x: 99, y: 0 })).rejects.toThrow("above the limit");
			})
			.then(() => dev.command("drag", { from: { x: 0, y: 0 }, to: { x: 10, y: 4 }, steps: 2 }))
			.then(() => {
				const p = server.events.filter((e) => e.type === "pointer").slice(3).map((e) => [e.mask, e.x, e.y]);
				expect(p).toEqual([[0, 0, 0], [1, 0, 0], [1, 5, 2], [1, 10, 4], [0, 10, 4]]);
			});
	});

	test("wait_change: resolves on a change inside the region, times out otherwise", () => {
		const started = dev.command("wait_change", { region: { x: 8, y: 0, w: 8, h: 8 }, timeoutMs: 3000, screenshot: true });
		// outside the region: ignored
		setTimeout(() => server.fill(0, 0, 2, 2, [1, 1, 1]), 30);
		setTimeout(() => server.fill(10, 2, 2, 2, [9, 9, 9]), 120);
		return started
			.then((res) => {
				expect(res.changed).toBe(true);
				expect(res.ms).toBeGreaterThanOrEqual(100);
				expect(res._image.mime).toBe("image/png");
				return dev.command("wait_change", { timeoutMs: 100 });
			})
			.then((res) => {
				expect(res.changed).toBe(false);
			});
	});

	test("view-only devices refuse input", () => {
		const ro = vnc.create({ port: server.port, password: "pw", viewOnly: true }, mockIo());
		return ro.start()
			.then(() => expect(ro.command("type", { text: "x" })).rejects.toThrow("view-only"))
			.then(() => ro.command("screenshot"))
			.then((res) => expect(res.image).toBe("desk_screen"))
			.finally(() => ro.stop());
	});

	test("reconnects after the server drops the connection", () => {
		const before = server.connections();
		server.clients.forEach((c) => c.destroy());
		return until(() => io.statuses.some((s) => s.state === "error"), 2000)
			.then(() => until(() => io.statuses.filter((s) => s.state === "running").length >= 2, 4000))
			.then(() => dev.command("status"))
			.then((s) => {
				expect(before).toBe(1);
				expect(s.reconnects).toBe(1);
				expect(s.connected).toBe(true);
			});
	});
});
