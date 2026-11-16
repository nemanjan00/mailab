// The kvm pane's server side against the fake NanoKVM: auth, Origin checks,
// device binding, MJPEG re-serving, human-only power and input.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WsClient = require("ws");
const labModule = require("../../../lab");
const authModule = require("../../../auth");
const mjpeg = require("../../../utils/mjpeg");
const web = require("../..");
const fake = require("../../../services/nanokvm/__fixtures__/fake-server");

// SOI + SOF0 (16x8) + EOI: enough for the driver to accept it as a frame
const FRAME = Buffer.from("ffd8ffc0000b080008001003012200ffd9", "hex");

const until = (cond, ms) => new Promise((resolve, reject) => {
	const started = Date.now();
	const poll = () => {
		const v = cond();
		if (v) {
			resolve(v);
		} else if (Date.now() - started > (ms || 3000)) {
			reject(new Error("timeout"));
		} else {
			setTimeout(poll, 5);
		}
	};
	poll();
});

const auth = (token) => ({ authorization: "Bearer " + token });

describe("kvm pane proxy", () => {
	let lab;
	let server;
	let kvmServer;
	let port;

	const get = (p, headers) => new Promise((resolve, reject) => {
		const req = http.get({ host: "127.0.0.1", port: port, path: p, headers: Object.assign({ host: "127.0.0.1:" + port }, headers || {}) }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
	});

	const post = (p, body, headers) => new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = http.request({ host: "127.0.0.1", port: port, path: p, method: "POST",
			headers: Object.assign({ "content-type": "application/json", "content-length": Buffer.byteLength(data) }, headers || {}) }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
		req.end(data);
	});

	// read MJPEG frames from the proxy until `count` arrive
	const frames = (token, count) => new Promise((resolve, reject) => {
		const got = [];
		const req = http.get({ host: "127.0.0.1", port: port, path: "/api/kvm/kvm/mjpeg", headers: auth(token) }, (res) => {
			if (res.statusCode !== 200) {
				reject(new Error("HTTP " + res.statusCode));
				return;
			}
			const parser = mjpeg.createParser(mjpeg.boundaryOf(res.headers["content-type"]), (body) => {
				got.push(body);
				if (got.length === count) {
					req.destroy();
					resolve({ frames: got, type: res.headers["content-type"] });
				}
			});
			res.on("data", (c) => parser.push(c));
		});
		req.on("error", () => null);
	});

	const socket = (token, headers) => new Promise((resolve, reject) => {
		const sock = new WsClient("ws://127.0.0.1:" + port + "/ws/kvm/kvm", { headers: Object.assign(token ? auth(token) : {}, headers || {}) });
		const messages = [];
		sock.on("message", (d) => messages.push(JSON.parse(d.toString())));
		sock.on("open", () => until(() => messages.length).then(() => resolve({ sock: sock, messages: messages })));
		sock.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
		sock.on("error", reject);
	});

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-kvm-")), channelCapacity: 100 });
		const a = authModule.create(authModule.parseTokens("alice:a-token:human,viewer:v-token:ro,claude:c-token:rw"));
		server = web.create(lab, { pushIntervalMs: 50, auth: a }).server;
		return lab.restore()
			.then(() => fake.start({ frame: FRAME, chunk: 5, password: "kvm-pw-123" }))
			.then((s) => {
				kvmServer = s;
				return lab.addDevice("kvm", "nanokvm", { host: s.host, password: "kvm-pw-123" });
			})
			.then(() => lab.addDevice("ro_kvm", "nanokvm", { host: kvmServer.host, password: "kvm-pw-123", viewOnly: true }))
			.then(() => lab.addDevice("sim", "sim", {}))
			.then(() => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)))
			.then(() => {
				port = server.address().port;
				return until(() => lab.getDevice("kvm").state === "running" && lab.getDevice("ro_kvm").state === "running");
			});
	});

	afterAll(() => {
		server.close();
		return lab.shutdown().then(() => kvmServer.close());
	});

	test("refuses unauthenticated, cross-origin and non-nanokvm requests", () => {
		return Promise.all([
			get("/api/kvm/kvm/mjpeg"),
			get("/api/kvm/kvm/mjpeg", Object.assign({ origin: "http://evil.example" }, auth("a-token"))),
			get("/api/kvm/kvm/status", Object.assign({ "sec-fetch-site": "cross-site" }, auth("a-token"))),
			get("/api/kvm/sim/mjpeg", auth("a-token")),
			get("/api/kvm/nope/status", auth("a-token"))
		]).then((r) => {
			expect(r.map((x) => x.status)).toEqual([401, 403, 403, 404, 404]);
			r.forEach((x) => {
				expect(x.body).not.toContain("kvm-pw-123");
			});
		});
	});

	test("re-serves the device's MJPEG stream to people and read-only viewers", () => {
		return Promise.all([frames("a-token", 3), frames("v-token", 2)]).then((r) => {
			expect(r[0].type).toMatch(/^multipart\/x-mixed-replace; boundary=/);
			expect(r[0].frames.every((f) => f.equals(FRAME))).toBe(true);
			expect(r[1].frames.length).toBe(2);
		});
	});

	test("status is a read; it reports LEDs without credentials", () => {
		return get("/api/kvm/kvm/status", auth("v-token")).then((r) => {
			expect(r.status).toBe(200);
			const s = JSON.parse(r.body);
			expect(s.leds.power).toBe(true);
			expect(r.body).not.toContain("kvm-pw-123");
		});
	});

	test("power buttons: people only (AI and read-only refused), recorded in the activity", () => {
		return Promise.all([
			post("/api/kvm/kvm/power", { action: "reset" }, auth("c-token")),
			post("/api/kvm/kvm/power", { action: "reset" }, auth("v-token")),
			post("/api/kvm/kvm/power", { action: "reset" }, Object.assign({ origin: "http://evil.example" }, auth("a-token")))
		]).then((r) => {
			expect(r.map((x) => x.status)).toEqual([403, 403, 403]);
			expect(kvmServer.gpio).toEqual([]);
			return post("/api/kvm/kvm/power", { action: "reset" }, auth("a-token"));
		}).then((r) => {
			expect(r.status).toBe(200);
			expect(kvmServer.gpio).toEqual([{ type: "reset", duration: 800 }]);
			expect(lab.getActivity().some((e) => e.tool === "kvm_power" && e.who === "alice")).toBe(true);
		});
	});

	test("input socket: people's HID messages are forwarded, validated", () => {
		kvmServer.hid.length = 0;
		return socket("a-token").then((c) => {
			expect(c.messages[0]).toEqual({ type: "hello", viewOnly: false });
			c.sock.send(Buffer.from("01020004000000000000".slice(0, 18), "hex"));
			c.sock.send(Buffer.from("02010100010001", "hex"));
			// malformed: wrong length, unknown event, text
			c.sock.send(Buffer.from("0100", "hex"));
			c.sock.send(Buffer.from("09000000000000", "hex"));
			c.sock.send("hello");
			return until(() => kvmServer.hidMessages().length >= 2).then(() => until(() => c.messages.some((m) => m.type === "error"))).then(() => {
				expect(kvmServer.hidMessages().map((m) => m.toString("hex"))).toEqual(["010200040000000000", "02010100010001"]);
				c.sock.close();
			});
		});
	});

	test("input socket: AIs, read-only users and view-only devices are view-only; Origin is checked", () => {
		kvmServer.hid.length = 0;
		const roDevice = () => new Promise((resolve) => {
			const sock = new WsClient("ws://127.0.0.1:" + port + "/ws/kvm/ro_kvm", { headers: auth("a-token") });
			sock.on("message", (d) => resolve({ sock: sock, hello: JSON.parse(d.toString()) }));
		});
		return Promise.all([socket("c-token"), socket("v-token"), roDevice(), socket(null), socket("a-token", { origin: "http://evil.example" })]).then((r) => {
			expect(r[0].messages[0]).toEqual({ type: "hello", viewOnly: true });
			expect(r[1].messages[0]).toEqual({ type: "hello", viewOnly: true });
			expect(r[2].hello).toEqual({ type: "hello", viewOnly: true });
			expect(r[3].status).toBe(401);
			expect(r[4].status).toBe(403);
			[r[0].sock, r[1].sock, r[2].sock].forEach((s) => s.send(Buffer.from("010200040000000000", "hex")));
			return new Promise((resolve) => setTimeout(resolve, 200)).then(() => {
				expect(kvmServer.hidMessages()).toEqual([]);
				[r[0].sock, r[1].sock, r[2].sock].forEach((s) => s.close());
			});
		});
	});
});
