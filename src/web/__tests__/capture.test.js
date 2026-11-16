// Browser capture over the UI WebSocket: identity decides who may push media.

const fs = require("fs");
const os = require("os");
const path = require("path");
const ws = require("ws");
const labModule = require("../../lab");
const authModule = require("../../auth");
const web = require("..");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16), Buffer.from([0xff, 0xd9])]);

describe("capture over /ws", () => {
	let lab;
	let server;
	let port;

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-ws-")), channelCapacity: 1000 });
		const auth = authModule.create(authModule.parseTokens("alice:a1:rw,viewer:v1:ro"));
		server = web.create(lab, { pushIntervalMs: 50, auth: auth }).server;
		return lab.restore().then(() => new Promise((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				port = server.address().port;
				resolve();
			});
		}));
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	// open a socket and collect messages; wait(type) resolves with the next one of that type
	const open = (token) => new Promise((resolve, reject) => {
		const socket = new ws("ws://127.0.0.1:" + port + "/ws", { headers: { authorization: "Bearer " + token } });
		const seen = [];
		const waiters = [];
		socket.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			seen.push(msg);
			waiters.filter((w) => w.type === msg.type).forEach((w) => {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve(msg);
			});
		});
		socket.on("open", () => resolve({
			socket: socket,
			send: (msg) => socket.send(JSON.stringify(msg)),
			wait: (type) => new Promise((res) => waiters.push({ type: type, resolve: res }))
		}));
		socket.on("error", reject);
	});

	test("unauthenticated sockets are refused", () => {
		return expect(open("nope")).rejects.toThrow(/401/);
	});

	test("ro tokens can't push media", () => {
		return open("v1").then((c) => {
			const error = c.wait("capture_error");
			c.send({ type: "capture_start", device: "tablet", ref: 3, cam: { fps: 1 } });
			return error.then((msg) => {
				expect(msg).toMatchObject({ device: "tablet", ref: 3 });
				expect(msg.error).toMatch(/read-only/);
				expect(() => lab.getDevice("tablet")).toThrow(/unknown device/);
				c.socket.close();
			});
		});
	});

	test("garbage is answered with an error, not a crash", () => {
		return open("a1").then((c) => {
			const error = c.wait("capture_error");
			c.send("not json at all");
			return error.then((msg) => {
				expect(msg.error).toMatch(/unknown capture message/);
				c.socket.close();
			});
		});
	});

	test("rw browser streams a frame; closing the tab stops the device", () => {
		return open("a1").then((c) => {
			const started = c.wait("capture_started");
			c.send({ type: "capture_start", device: "tablet", ref: 1, cam: { fps: 1 } });
			return started
				.then((msg) => {
					expect(msg.device).toBe("tablet");
					expect(lab.describeDevice("tablet")).toMatchObject({ driver: "browser", state: "running" });
					const image = new Promise((resolve) => lab.events.once("image", resolve));
					c.send({ type: "capture_frame", device: "tablet", mime: "image/jpeg", data: JPEG.toString("base64") });
					return image;
				})
				.then((e) => {
					expect(e.name).toBe("tablet_frame");
					// an MCP-side snapshot reaches this socket
					const ask = c.wait("capture_snapshot");
					const result = lab.commandDevice("tablet", "snapshot", { timeout: 2000 });
					return ask.then((msg) => {
						c.send({ type: "capture_frame", device: "tablet", mime: "image/jpeg", data: JPEG.toString("base64"), request: msg.request });
						return result;
					});
				})
				.then((result) => {
					expect(result.bytes).toBe(JPEG.length);
					const stopped = new Promise((resolve) => {
						const check = () => {
							if (lab.describeDevice("tablet").state === "stopped") {
								lab.events.removeListener("state", check);
								resolve();
							}
						};
						lab.events.on("state", check);
					});
					c.socket.close();
					return stopped;
				})
				.then(() => {
					expect(lab.describeDevice("tablet").detail).toMatch(/disconnected/);
				});
		});
	});
});
