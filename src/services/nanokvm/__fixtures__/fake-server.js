// A fake NanoKVM for tests: the endpoints and messages the driver uses, as
// read from sipeed/NanoKVM (2.5.4) and NanoKVM-Pro sources (see
// src/services/nanokvm). Not a model of the firmware beyond that.
//
// options:
//   username, password     accepted login (default admin / admin)
//   tokenInBody            answer the token in data.token (pre-2.5.1 / Pro) instead of Set-Cookie
//   pro                    no /api/vm/screen and no /api/storage/media/eject (404), /api/stream/* instead
//   frames                 JPEG buffers to stream (cycled through `server.frame`)
//   chunk                  split every MJPEG write into pieces of this many bytes
//   frameIntervalMs        MJPEG frame period (default 30)

const http = require("http");
const randomBytes = require("crypto").randomBytes;
const ws = require("ws");
const cryptojs = require("../../../utils/cryptojs");
const COOKIE = require("..").COOKIE;
const PASSWORD_KEY = require("..").PASSWORD_KEY;

const start = (options) => {
	const o = Object.assign({ username: "admin", password: "admin", frameIntervalMs: 30, chunk: 0, tokenInBody: false, pro: false }, options || {});
	const tokens = new Set();
	const sockets = new Set();
	const fake = {
		frame: o.frame || null,
		requests: [],
		logins: [],
		gpio: [],
		hid: [],
		screen: [],
		mounts: [],
		ejects: 0,
		leds: { pwr: true, hdd: false },
		images: ["/data/debian.iso", "/data/tools/memtest.img"],
		mounted: "",
		streams: 0,
		activeStreams: new Set()
	};

	const json = (res, status, body, headers) => {
		res.writeHead(status, Object.assign({ "content-type": "application/json" }, headers || {}));
		res.end(JSON.stringify(body));
	};
	const ok = (res, data) => json(res, 200, { code: 0, msg: "success", data: data === undefined ? null : data });

	const authed = (req) => {
		const m = new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)").exec(req.headers.cookie || "");
		return Boolean(m && tokens.has(m[1]));
	};

	const readJson = (req) => new Promise((resolve) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
			} catch (_err) {
				resolve({});
			}
		});
	});

	const writeSplit = (res, buf) => {
		if (!o.chunk) {
			res.write(buf);
			return;
		}
		Array.from({ length: Math.ceil(buf.length / o.chunk) }, (_, i) => i).forEach((i) => {
			res.write(buf.subarray(i * o.chunk, (i + 1) * o.chunk));
		});
	};

	const mjpegStream = (req, res) => {
		fake.streams++;
		res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cache-control": "no-cache" });
		const tick = () => {
			if (!fake.frame) {
				return;
			}
			writeSplit(res, Buffer.concat([
				Buffer.from("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + fake.frame.length + "\r\n\r\n"),
				fake.frame,
				Buffer.from("\r\n")
			]));
		};
		tick();
		const timer = setInterval(tick, o.frameIntervalMs);
		fake.activeStreams.add(res);
		req.on("close", () => {
			clearInterval(timer);
			fake.activeStreams.delete(res);
		});
	};

	const routes = {
		"GET /api/vm/info": (req, res) => ok(res, { ips: [], mdns: "kvm.local", image: "v1.4.1", application: "2.5.4", deviceKey: "" }),
		"GET /api/vm/hardware": (req, res) => ok(res, { version: o.pro ? "Desk" : "Beta" }),
		"GET /api/vm/gpio": (req, res) => ok(res, fake.leds),
		"POST /api/vm/gpio": (req, res, body) => {
			fake.gpio.push(body);
			ok(res);
		},
		"GET /api/hid/leds": (req, res) => ok(res, { numLock: true, capsLock: false, scrollLock: false, known: true, updatedAt: "" }),
		"GET /api/storage/image": (req, res) => ok(res, { files: fake.images }),
		"GET /api/storage/image/mounted": (req, res) => ok(res, { file: fake.mounted }),
		"GET /api/storage/cdrom": (req, res) => ok(res, { cdrom: 0 }),
		"POST /api/storage/image/mount": (req, res, body) => {
			fake.mounts.push(body);
			fake.mounted = body.file || "";
			ok(res);
		},
		"POST /api/storage/media/eject": (req, res) => {
			if (o.pro) {
				json(res, 404, "404 page not found");
				return;
			}
			fake.ejects++;
			fake.mounted = "";
			ok(res);
		},
		"POST /api/vm/screen": (req, res, body) => {
			if (o.pro) {
				json(res, 404, "404 page not found");
				return;
			}
			fake.screen.push(body);
			ok(res);
		},
		"POST /api/stream/fps": (req, res, body) => {
			fake.screen.push(Object.assign({ api: "stream" }, body));
			ok(res);
		},
		"POST /api/stream/quality": (req, res, body) => {
			fake.screen.push(Object.assign({ api: "stream" }, body));
			ok(res);
		}
	};

	const server = http.createServer((req, res) => {
		const path = req.url.split("?")[0];
		fake.requests.push(req.method + " " + path);
		if (req.method === "POST" && path === "/api/auth/login") {
			readJson(req).then((body) => {
				const password = (() => {
					try {
						return cryptojs.decrypt(decodeURIComponent(body.password || ""), PASSWORD_KEY);
					} catch (_err) {
						return "";
					}
				})();
				fake.logins.push({ username: body.username, password: password });
				if (body.username !== o.username || password !== o.password) {
					json(res, 200, { code: -2, msg: "invalid username or password", data: null });
					return;
				}
				const token = randomBytes(12).toString("hex");
				tokens.add(token);
				if (o.tokenInBody) {
					ok(res, { token: token });
				} else {
					json(res, 200, { code: 0, msg: "success", data: null }, { "set-cookie": COOKIE + "=" + token + "; Path=/; HttpOnly; SameSite=Strict" });
				}
			});
			return;
		}
		if (!authed(req)) {
			json(res, 401, "unauthorized");
			return;
		}
		if (req.method === "GET" && path === "/api/stream/mjpeg") {
			mjpegStream(req, res);
			return;
		}
		const handler = routes[req.method + " " + path];
		if (!handler) {
			json(res, 404, "404 page not found");
			return;
		}
		readJson(req).then((body) => handler(req, res, body));
	});

	const wss = new ws.Server({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		if (req.url.split("?")[0] !== "/api/ws" || !authed(req)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (client) => {
			sockets.add(client);
			client.send(JSON.stringify({ type: "keyboard_led", data: "{}" }));
			client.on("message", (data, isBinary) => {
				if (isBinary) {
					fake.hid.push(Buffer.from(data));
				}
			});
			client.on("close", () => sockets.delete(client));
		});
	});

	return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)).then(() => Object.assign(fake, {
		port: server.address().port,
		host: "http://127.0.0.1:" + server.address().port,
		// sessions end (password change, token expiry): next requests get 401
		expire: () => tokens.clear(),
		dropSockets: () => sockets.forEach((s) => s.terminate()),
		sockets: () => sockets.size,
		hidMessages: () => fake.hid.filter((m) => m[0] !== 0),
		close: () => {
			sockets.forEach((s) => s.terminate());
			fake.activeStreams.forEach((r) => r.destroy());
			wss.close();
			return new Promise((resolve) => server.close(resolve));
		}
	}));
};

module.exports = {
	start: start
};
