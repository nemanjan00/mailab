// USB-to-UART consoles (ttyUSB / ttyACM: FTDI incl. Tigard port A, CP210x,
// CH340, CDC-ACM). The port is found by a stable identity (vid/pid/serial,
// USB path, interface, by-id link) so the device follows the adapter across
// re-enumeration, and it waits / reconnects while the adapter is unplugged.
// Lines go to the log as "rx" (classifier, notifications, terminal pane);
// raw bytes can be captured into a blob.

const tty = require("../../services/tty");
const usb = require("../../services/usb");
const lineparse = require("../../utils/lineparse");

const RETRY_MS = 1000;
const FLUSH_MS = 150;
const QUERY_TIMEOUT_MS = 1000;
const CAPTURE_MAX = 16 * 1024 * 1024;
const EOL = { lf: "\n", crlf: "\r\n", cr: "\r", none: "" };
const DISPLAYS = ["text", "hex"];

// CSI / OSC escape sequences from colored consoles (built from char codes:
// no-control-regex forbids literal ESC / BEL in patterns)
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]", "g");
const OSC = new RegExp(ESC + "\\][^" + BEL + "]*(" + BEL + "|" + ESC + "\\\\)", "g");
const stripAnsi = (text) => text.replace(CSI, "").replace(OSC, "");

const hexDump = (buf) => Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(" ");

const parseHex = (hex) => {
	const clean = String(hex).replace(/0x/gi, "").replace(/[\s,:]/g, "");
	if (!/^([0-9a-f]{2})*$/i.test(clean)) {
		throw new Error("hex must be pairs of hex digits, e.g. \"de ad be ef\"");
	}
	return Buffer.from(clean, "hex");
};

/**
 * Split incoming text into complete lines; returns {lines, rest}.
 */
const splitLines = (text) => {
	const parts = text.split(/\r\n|\n|\r/);
	return { lines: parts.slice(0, -1), rest: parts[parts.length - 1] };
};

const create = (options, io) => {
	const settings = {
		baud: Number(options.baud) || 115200,
		format: options.format || "8N1",
		flow: options.flow || "none",
		eol: EOL[options.eol] !== undefined ? options.eol : "lf",
		display: DISPLAYS.indexOf(options.display) !== -1 ? options.display : "text"
	};
	let path = null;
	let port = null;
	let stopped = false;
	let retry = null;
	let pending = "";
	let flushTimer = null;
	let capture = null;
	let waiters = [];
	const stats = { rxBytes: 0, txBytes: 0, connects: 0 };

	const resolve = () => {
		if (options.path) {
			return options.path;
		}
		const found = usb.findPort(usb.serialPorts(usb.inventory().buses), options.match || {});
		return found ? found.node : null;
	};

	const emitLine = (line) => {
		const clean = stripAnsi(line);
		if (!clean.trim()) {
			return;
		}
		io.log(clean, "rx");
		waiters.forEach((w) => w.line(clean));
		if (options.parser) {
			const values = lineparse.parse(options.parser, clean.trim(), options.fields);
			const t = Date.now();
			Object.keys(values).forEach((field) => io.sample(field, values[field], { t: t, unit: (options.units || {})[field] }));
		}
	};

	const flush = () => {
		flushTimer = null;
		// prompts ("login: ", "=> ") never end in a newline
		if (pending) {
			const partial = pending;
			pending = "";
			emitLine(partial);
		}
	};

	const onData = (data) => {
		stats.rxBytes += data.length;
		// web terminals get the bytes untouched (colors, cursor movement)
		if (io.term) {
			io.term(data);
		}
		if (capture && capture.size < CAPTURE_MAX) {
			capture.chunks.push(data);
			capture.size += data.length;
		}
		if (settings.display === "hex") {
			io.log(hexDump(data), "rx");
			waiters.forEach((w) => w.line(hexDump(data)));
			return;
		}
		const split = splitLines(pending + data.toString("latin1"));
		pending = split.rest;
		split.lines.forEach(emitLine);
		clearTimeout(flushTimer);
		flushTimer = pending ? setTimeout(flush, FLUSH_MS) : null;
	};

	const disconnect = () => {
		if (!port) {
			return Promise.resolve();
		}
		port.off("data", onData);
		port = null;
		return tty.release(path, io.id);
	};

	const connect = () => {
		retry = null;
		if (stopped) {
			return;
		}
		const next = resolve();
		if (!next) {
			io.status("waiting", "adapter not connected" + (options.match ? " (" + JSON.stringify(options.match) + ")" : ""));
			retry = setTimeout(connect, RETRY_MS);
			return;
		}
		try {
			path = next;
			port = tty.acquire(path, { baud: settings.baud, format: settings.format, flow: settings.flow, owner: io.id });
		} catch (err) {
			port = null;
			io.status("waiting", err.message);
			retry = setTimeout(connect, RETRY_MS);
			return;
		}
		stats.connects++;
		port.on("data", onData);
		port.on("error", (err) => {
			// unplugged (EIO): drop the port and look for the adapter again
			io.log("disconnected: " + err.message, "warn");
			disconnect().then(() => {
				if (!stopped && !retry) {
					retry = setTimeout(connect, RETRY_MS);
				}
			});
		});
		io.status("running", path + " " + settings.baud + " " + settings.format);
		if (stats.connects > 1) {
			io.log("reconnected on " + path, "info");
		}
	};

	const send = (buf) => {
		if (!port) {
			throw new Error("not connected");
		}
		stats.txBytes += buf.length;
		port.write(buf);
	};

	const writeText = (text, eol) => {
		const ending = EOL[eol === undefined ? settings.eol : eol];
		if (ending === undefined) {
			throw new Error("eol must be lf, crlf, cr or none");
		}
		io.log(String(text), "tx");
		send(Buffer.from(String(text) + ending, "latin1"));
	};

	const commands = {
		write: (args) => {
			writeText(args.text === undefined ? "" : args.text, args.eol);
			return { ok: true };
		},

		// keystrokes from a web terminal: sent as is, not logged per key (the
		// target echoes them back)
		write_raw: (args) => {
			const buf = Buffer.from(String(args.data || ""), "base64");
			send(buf);
			return { ok: true, bytes: buf.length };
		},

		write_hex: (args) => {
			const buf = parseHex(args.hex);
			io.log(hexDump(buf), "tx");
			send(buf);
			return { ok: true, bytes: buf.length };
		},

		query: (args) => {
			const until = args.until ? new RegExp(args.until) : null;
			return new Promise((done) => {
				const lines = [];
				const w = {
					line: (line) => {
						lines.push(line);
						if (until && until.test(line)) {
							finish();
						}
					}
				};
				const finish = () => {
					clearTimeout(timer);
					waiters = waiters.filter((x) => x !== w);
					done({ lines: lines, matched: Boolean(until && lines.some((l) => until.test(l))) });
				};
				const timer = setTimeout(finish, args.timeoutMs || QUERY_TIMEOUT_MS);
				waiters.push(w);
				try {
					writeText(args.text === undefined ? "" : args.text, args.eol);
				} catch (err) {
					clearTimeout(timer);
					waiters = waiters.filter((x) => x !== w);
					throw err;
				}
			});
		},

		set: (args) => {
			const next = Object.assign({}, settings);
			["baud", "format", "flow", "eol", "display"].forEach((k) => {
				if (args[k] !== undefined) {
					next[k] = k === "baud" ? Number(args[k]) : args[k];
				}
			});
			tty.sttyArgs(next);
			if (EOL[next.eol] === undefined || DISPLAYS.indexOf(next.display) === -1) {
				throw new Error("eol: lf|crlf|cr|none, display: text|hex");
			}
			if (port && (next.baud !== settings.baud || next.format !== settings.format || next.flow !== settings.flow)) {
				tty.configure(path, next);
			}
			Object.assign(settings, next);
			io.setOptions({ baud: settings.baud, format: settings.format, flow: settings.flow, eol: settings.eol, display: settings.display });
			if (port) {
				io.status("running", path + " " + settings.baud + " " + settings.format);
			}
			return commands.status();
		},

		capture_start: () => {
			capture = { chunks: [], size: 0, t: Date.now() };
			return { ok: true };
		},

		capture_stop: (args) => {
			if (!capture) {
				throw new Error("no capture running");
			}
			const data = Buffer.concat(capture.chunks);
			const name = args.name || "capture";
			capture = null;
			io.blob(name, data);
			return { blob: io.id + "_" + name, bytes: data.length };
		},

		status: () => Object.assign({ path: path, connected: Boolean(port), capturing: Boolean(capture) }, settings, stats)
	};

	return {
		// the node in use (it follows the adapter), for the USB tree / uart_ports
		port: () => (port ? path : null),

		start: () => {
			connect();
			return Promise.resolve();
		},

		stop: () => {
			stopped = true;
			clearTimeout(retry);
			clearTimeout(flushTimer);
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
	name: "uart",
	description: "USB-to-UART console (ttyUSB/ttyACM: FTDI, Tigard port A, CP210x, CH340, CDC-ACM). Follows the adapter by identity and reconnects after replugs",
	options: {
		path: "fixed device node, e.g. /dev/ttyUSB0 (or use match)",
		match: "{vid, pid, serial, product, usbPath, interface, byId}: stable identity from uart_ports (Tigard UART = 0403:6010 interface 0)",
		baud: "baud rate (default 115200)",
		format: "data bits, parity, stop bits: 8N1 (default), 7E1, 8O2, ...",
		flow: "none (default) | rtscts | xonxoff",
		eol: "line ending for writes: lf (default) | crlf | cr | none",
		display: "text (default) | hex: how received bytes are logged",
		parser: "optional: kv | csv | number, to turn lines into channels",
		fields: "column names for csv parser",
		units: "{field: unit}"
	},
	commands: {
		write: "{text, eol?} send text",
		write_hex: "{hex} send raw bytes, e.g. \"de ad be ef\"",
		write_raw: "{data} send base64 bytes as is (web terminal keystrokes; not logged)",
		query: "{text, timeoutMs?, until?} send, return lines received until the regex `until` matches or the timeout",
		set: "{baud?, format?, flow?, eol?, display?} change settings live",
		capture_start: "{} start recording raw received bytes",
		capture_stop: "{name?} stop recording, store the bytes as a blob (blob_analyze / kaitai work on it)",
		status: "{} port, settings, byte counters"
	},
	create: create,
	_test: { stripAnsi: stripAnsi, parseHex: parseHex, splitLines: splitLines, hexDump: hexDump }
};
