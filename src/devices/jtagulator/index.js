// JTAGulator: UART/JTAG/SWD pin enumeration tool, interactive text menu on
// serial (115200). The driver sends menu lines and collects the transcript
// until the output goes idle; convenience wrappers drive the common scans.
// Hardware-untested: written against the JTAGulator v1.11 menu structure;
// menu letters may differ per FW [HW].

const tty = require("../../services/tty");
const usb = require("../../services/usb");

const RETRY_MS = 1000;
const IDLE_MS = 250;

const create = (options, io) => {
	let path = null;
	let port = null;
	let stopped = false;
	let retry = null;
	const settings = { baud: Number(options.baud) || 115200 };

	const resolve = () => {
		if (options.path) {
			return options.path;
		}
		const found = usb.findPort(usb.serialPorts(usb.inventory().buses), options.match || {});
		return found ? found.node : null;
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
			io.status("waiting", "JTAGulator not connected" + (options.match ? " (" + JSON.stringify(options.match) + ")" : ""));
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

	let transcript = "";
	let idleTimer = null;
	let waiter = null;
	const onData = (data) => {
		const text = data.toString("latin1");
		transcript += text;
		if (io.term) {
			io.term(data);
		}
		if (waiter) {
			const w = waiter;
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				waiter = null;
				w.resolve(transcript);
			}, w.idleMs);
		} else if (transcript.length > 65536) {
			transcript = transcript.slice(-16384);
		}
	};

	// send menu lines one by one, settle between them, return the transcript
	// collected from just before the first line until the output goes idle
	const menu = (lines, idleMs) => {
		if (!port) {
			return Promise.reject(new Error("not connected"));
		}
		if (waiter) {
			return Promise.reject(new Error("a menu session is already running"));
		}
		const list = (Array.isArray(lines) ? lines : [lines]).map(String);
		return new Promise((resolve, reject) => {
			transcript = "";
			waiter = { resolve: resolve, reject: reject, idleMs: idleMs || IDLE_MS };
			list.reduce((p, line) => {
				return p.then(() => {
					io.log("> " + line, "tx");
					port.write(Buffer.from(line + "\r\n", "latin1"));
					return new Promise((r) => setTimeout(r, 60));
				});
			}, Promise.resolve()).then(() => {
				idleTimer = setTimeout(() => {
					const w = waiter;
					waiter = null;
					w.resolve(transcript);
				}, waiter ? waiter.idleMs : IDLE_MS);
			}, (err) => {
				waiter = null;
				clearTimeout(idleTimer);
				reject(err);
			});
		});
	};

	// convenience wrappers over the classic menu letters [HW]
	const commands = {
		menu: (args) => menu(args.lines, args.idleMs),

		// voltage target reference ("V" menu item)
		voltage: () => menu(["V"]).then((out) => {
			const m = /([0-9.]+)\s*V/.exec(out);
			return { text: out, volts: m ? parseFloat(m[1]) : null };
		}),

		// JTAG chain scan on a channel range, e.g. {from: 1, to: 8}
		jtag_scan: (args) => {
			const range = (args.from || 1) + "-" + (args.to || 8);
			return menu(["J", range]).then((out) => {
				return { text: out, idcodes: (out.match(/\b[0-9a-f]{8}\b/gi) || []) };
			});
		},

		// IDCODE-only scan, e.g. {from: 1, to: 8}
		idcode_scan: (args) => {
			const range = (args.from || 1) + "-" + (args.to || 8);
			return menu(["I", range]).then((out) => {
				return { text: out, idcodes: (out.match(/\b[0-9a-f]{8}\b/gi) || []) };
			});
		},

		// UART passthrough pin detection, e.g. {from: 1, to: 8, baud: 115200}
		uart_scan: (args) => {
			const range = (args.from || 1) + "-" + (args.to || 8);
			return menu(["U", range, String(args.baud || 115200)]).then((out) => {
				return { text: out };
			});
		},

		status: () => ({ path: path, connected: Boolean(port), settings: settings })
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
			clearTimeout(idleTimer);
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
	name: "jtagulator",
	description: "JTAGulator pin-enumeration tool over serial: interactive menu transcripts, voltage readout, JTAG/IDCODE/UART scan wrappers. Follows the adapter by identity and reconnects after replugs",
	options: {
		path: "fixed device node, e.g. /dev/ttyUSB0 (or use match)",
		match: "{vid, pid, serial, product, usbPath, interface, byId}: stable identity from uart_ports",
		baud: "baud rate (default 115200)"
	},
	commands: {
		menu: "{lines: [..], idleMs?} send menu lines, return the transcript until output goes idle",
		voltage: "{} target voltage readout",
		jtag_scan: "{from?, to?} JTAG chain scan over a channel range",
		idcode_scan: "{from?, to?} IDCODE scan over a channel range",
		uart_scan: "{from?, to?, baud?} UART passthrough pin detection",
		status: "{} port, settings"
	},
	create: create
};
