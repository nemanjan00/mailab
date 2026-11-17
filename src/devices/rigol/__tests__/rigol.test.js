// RIGOL Web Control driver: input injection against a fake ws:// control
// server (the 9002 protocol: JSON touch/key frames).

const WS = require("ws");
const rigol = require("..");

const fakeIo = () => {
	const io = { id: "rg1", logs: [] };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = () => {};
	return io;
};

describe("rigol driver", () => {
	let server = null;
	let frames = null;
	let port = null;

	beforeEach(() => new Promise((resolve) => {
		frames = [];
		server = new WS.Server({ port: 0 }, () => {
			port = server.address().port;
			server.on("connection", (sock) => {
				sock.on("message", (d) => frames.push(JSON.parse(String(d))));
			});
			resolve();
		});
	}));

	afterEach(() => new Promise((resolve) => {
		server.close(resolve);
	}));

	const make = () => rigol.create({ host: "127.0.0.1", controlPort: port }, fakeIo());

	test("tap sends down+up at the native coordinates (default dom dialect)", () => {
		const dev = make();
		return dev.start()
			.then(() => dev.command("tap", { x: 512, y: 300 }))
			.then(() => new Promise((r) => setTimeout(r, 200)))
			.then(() => {
				expect(frames).toEqual([
					{ type: "onmousedown", downDelta: null, clientX: 512, clientY: 300 },
					{ type: "onmouseup", downDelta: 120, clientX: 512, clientY: 300 }
				]);
			})
			.then(() => dev.stop());
	});

	test("the rigol dialect is still available for CONTROL_KEY_* frames", () => {
		const dev = rigol.create({ host: "127.0.0.1", controlPort: port, dialect: "rigol" }, fakeIo());
		return dev.start()
			.then(() => dev.command("tap", { x: 7, y: 9 }))
			.then(() => new Promise((r) => setTimeout(r, 200)))
			.then(() => {
				expect(frames[0]).toEqual({ type: "CONTROL_KEY_DOWN", downDelta: 0, clientX: 7, clientY: 9 });
			})
			.then(() => dev.stop());
	});

	test("touch states, keys and swipes map to the protocol", () => {
		const dev = make();
		return dev.start()
			.then(() => dev.command("touch", { state: "move", x: 10, y: 20 }))
			.then(() => dev.command("key", { name: "back" }))
			.then(() => dev.command("swipe", { from_x: 0, from_y: 0, to_x: 100, to_y: 0, steps: 2 }))
			.then(() => new Promise((r) => setTimeout(r, 300)))
			.then(() => {
				expect(frames[0]).toEqual({ type: "onmousemove", downDelta: null, clientX: 10, clientY: 20 });
				expect(frames[1]).toEqual({ type: "CONTROL_BACK" });
				const types = frames.slice(2).map((f) => f.type);
				expect(types).toEqual(["onmousedown", "onmousemove", "onmousemove", "onmouseup"]);
				const last = frames[frames.length - 1];
				expect([last.clientX, last.clientY]).toEqual([100, 0]);
			})
			.then(() => dev.stop());
	});

	test("rejects bad state/name/coordinates before connecting", () => {
		const dev = make();
		return dev.start().then(() => {
			expect(dev.command("touch", { state: "poke", x: 1, y: 1 })).rejects.toThrow("state");
			expect(dev.command("key", { name: "f1" })).rejects.toThrow("name");
			expect(dev.command("tap", { x: -5, y: 1 })).rejects.toThrow("coordinates");
			expect(frames).toEqual([]);
			return dev.stop();
		});
	});

	test("status reports urls and link state", () => {
		const dev = make();
		return dev.start()
			.then(() => dev.command("status", {}))
			.then((s) => {
				expect(s.videoUrl).toBe("ws://127.0.0.1:9001");
				expect(s.controlUrl).toBe("ws://127.0.0.1:" + port);
				expect(s.webUrl).toBe("http://127.0.0.1/control.html");
				expect(s.controlOpen).toBe(false); // lazy: opens on first send
			})
			.then(() => dev.stop());
	});

	test("dom dialect (MHO98) sends onmouse* with null downDelta", () => {
		const dev = rigol.create({ host: "127.0.0.1", controlPort: port, dialect: "dom" }, fakeIo());
		return dev.start()
			.then(() => dev.command("tap", { x: 14, y: 569 }))
			.then(() => new Promise((r) => setTimeout(r, 200)))
			.then(() => {
				expect(frames).toEqual([
					{ type: "onmousedown", downDelta: null, clientX: 14, clientY: 569 },
					{ type: "onmouseup", downDelta: 120, clientX: 14, clientY: 569 }
				]);
				return dev.command("touch", { state: "move", x: 1, y: 2 });
			})
			.then(() => new Promise((r) => setTimeout(r, 150)))
			.then(() => {
				expect(frames[2]).toEqual({ type: "onmousemove", downDelta: null, clientX: 1, clientY: 2 });
			})
			.then(() => dev.stop());
	});

	test("requires a host", () => {
		expect(() => rigol.create({}, fakeIo())).toThrow("host");
	});
});
