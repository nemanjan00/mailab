// DeepAce analyzers (KC901K spectrum/VNA, KC908V wideband receiver): the
// vendor frame family shared with the KC9531B power meter
// (src/services/deepace): requests 0xFE 0x01 <code> <len> <payload> <cc16>,
// replies 0xFF 0x01 <code> <status> <len> <body> <cc16>.
//
// The vendor never published the KC901K/KC908V command codes (the KC908
// speaks the same family over a vendor FTD3XX library), so this driver is a
// generic framed transport: `request` sends any hex payload under a fresh
// transaction code and returns the reply body, `trace_f32` additionally
// decodes a little-endian float32 array into a spectrum trace. Command
// semantics stay [HW] until a unit is on the bench.
//
// KC901K: USB-CDC serial (ttyACM/ttyUSB, 115200). KC908V: needs the vendor
// FTD3XX backend — out of reach for a tty driver [HW].

const tty = require("../../services/tty");
const usb = require("../../services/usb");
const deepace = require("../../services/deepace");

const RETRY_MS = 1000;
const DEFAULT_BAUD = 115200;
const TIMEOUT_MS = 5000;

const parseHex = (hex, max) => {
	const clean = String(hex).replace(/0x/gi, "").replace(/[\s,:]/g, "");
	if (!/^([0-9a-f]{2})*$/i.test(clean)) {
		throw new Error("hex must be pairs of hex digits, e.g. \"de ad be ef\"");
	}
	const buf = Buffer.from(clean, "hex");
	if (buf.length > (max || 65535)) {
		throw new Error("payload is " + buf.length + " bytes, max " + (max || 65535));
	}
	return buf;
};

const create = (options, io) => {
	let path = null;
	let port = null;
	let stopped = false;
	let retry = null;
	let pending = new Map(); // code -> {resolve, reject, timer}
	let parser = null;
	let stats = { rxBytes: 0, txBytes: 0, requests: 0, replies: 0, errors: 0 };
	const settings = { baud: Number(options.baud) || DEFAULT_BAUD };

	const resolve = () => {
		if (options.path) {
			return options.path;
		}
		const found = usb.findPort(usb.serialPorts(usb.inventory().buses), options.match || {});
		return found ? found.node : null;
	};

	const onFrame = (frame) => {
		stats.replies++;
		const waiter = pending.get(frame.code);
		if (!waiter) {
			io.log("reply with no pending request, code=0x" + frame.code.toString(16), "warn");
			return;
		}
		clearTimeout(waiter.timer);
		pending.delete(frame.code);
		if (frame.ok) {
			waiter.resolve(frame.body);
		} else {
			stats.errors++;
			waiter.reject(new Error("device rejected request 0x" + frame.code.toString(16) + " (status 0)"));
		}
	};

	const onData = (data) => {
		stats.rxBytes += data.length;
		if (parser) {
			parser.push(data);
		}
	};

	const disconnect = () => {
		if (!port) {
			return Promise.resolve();
		}
		port.off("data", onData);
		port = null;
		return tty.release(path, io.id).then(() => {
			pending.forEach((w) => {
				clearTimeout(w.timer);
				w.reject(new Error("disconnected"));
			});
			pending.clear();
		});
	};

	const connect = () => {
		retry = null;
		if (stopped) {
			return;
		}
		const next = resolve();
		if (!next) {
			io.status("waiting", "analyzer not connected" + (options.match ? " (" + JSON.stringify(options.match) + ")" : ""));
			retry = setTimeout(connect, RETRY_MS);
			return;
		}
		try {
			path = next;
			port = tty.acquire(path, { baud: settings.baud, format: "8N1", flow: "none", owner: io.id });
		} catch (err) {
			port = null;
			io.status("waiting", err.message);
			retry = setTimeout(connect, RETRY_MS);
			return;
		}
		parser = deepace.createParser(onFrame, (reason) => {
			stats.errors++;
			io.log("frame error: " + reason, "warn");
		});
		port.on("data", onData);
		port.on("error", (err) => {
			io.log("disconnected: " + err.message, "warn");
			disconnect().then(() => {
				if (!stopped && !retry) {
					retry = setTimeout(connect, RETRY_MS);
				}
			});
		});
		io.status("running", path + " " + settings.baud);
	};

	const nextCode = () => {
		for (let i = 0; i < 256; i++) {
			const code = Math.floor(Math.random() * 256);
			if (!pending.has(code)) {
				return code;
			}
		}
		throw new Error("too many pending requests");
	};

	// send a framed payload, resolve with the reply body Buffer
	const request = (payload, timeoutMs) => {
		if (!port) {
			return Promise.reject(new Error("not connected"));
		}
		const code = nextCode();
		const frame = deepace.buildFrame(code, payload);
		return new Promise((done, fail) => {
			const timer = setTimeout(() => {
				pending.delete(code);
				stats.errors++;
				fail(new Error("timeout waiting for reply to 0x" + code.toString(16)));
			}, timeoutMs || TIMEOUT_MS);
			pending.set(code, { resolve: done, reject: fail, timer: timer });
			stats.txBytes += frame.length;
			stats.requests++;
			port.write(frame);
		});
	};

	const commands = {
		// generic framed request: hex payload in, {code, ok, hex} out
		request: (args) => {
			const payload = parseHex(args.hex);
			return request(payload, args.timeoutMs).then((body) => {
				return { ok: true, bytes: body.length, hex: body.toString("hex") };
			});
		},

		// same, but the reply body is decoded as little-endian float32 values
		// and published as a trace (e.g. a spectrum sweep)
		trace_f32: (args) => {
			const payload = parseHex(args.hex);
			return request(payload, args.timeoutMs || 30000).then((body) => {
				if (body.length % 4 !== 0) {
					throw new Error("reply is " + body.length + " bytes, not a float32 array");
				}
				const n = body.length / 4;
				const y = new Array(n);
				for (let i = 0; i < n; i++) {
					y[i] = body.readFloatLE(i * 4);
				}
				const f0 = Number(args.startHz) || 0;
				const df = Number(args.stepHz) || 1;
				const x = new Array(n);
				for (let i = 0; i < n; i++) {
					x[i] = f0 + i * df;
				}
				const name = args.name || "sweep";
				io.trace(name, { x: x, xUnit: "Hz", yUnit: args.unit || "", y: y });
				return { trace: name, points: n, spanHz: n > 1 ? (n - 1) * df : 0 };
			});
		},

		status: () => Object.assign({ path: path, connected: Boolean(port), pending: pending.size }, settings, { stats: stats })
	};

	return {
		port: () => (port ? path : null),

		start: () => {
			connect();
			return Promise.resolve();
		},

		stop: () => {
			stopped = true;
			clearTimeout(retry);
			return disconnect();
		},

		command: (name, args) => {
			if (!commands[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		}
	};
};

module.exports = {
	name: "kc901",
	description: "DeepAce RF analyzers (KC901K via USB serial; KC908V needs the vendor FTD3XX backend [HW]): framed request/response, f32 sweep replies -> spectrum trace. Vendor command codes unpublished — generic request until a unit is on the bench",
	options: {
		path: "fixed device node, e.g. /dev/ttyACM0 (or use match)",
		match: "{vid, pid, serial, product, usbPath, interface, byId}: stable identity from uart_ports",
		baud: "baud rate (default 115200)"
	},
	commands: {
		request: "{hex, timeoutMs?} send a framed request, return the reply body as hex",
		trace_f32: "{hex, startHz?, stepHz?, unit?, name?, timeoutMs?} request whose reply is a little-endian float32 array -> spectrum trace",
		status: "{} port, counters"
	},
	create: create
};
