// Black Magic Probe (or any GDB RSP target) over its USB serial port.
// Talks the minimal remote serial protocol: monitor commands (qRcmd, e.g.
// swdp_scan/jtag_scan/reset), memory read -> blobs, writes, registers,
// halt/resume/step. Hardware-untested: written against the BMP RSP docs;
// ACK/interrupt details may need tweaks on the bench [HW].

const tty = require("../../services/tty");
const usb = require("../../services/usb");
const gdbrsp = require("../../services/gdbrsp");

const RETRY_MS = 1000;

const hexToText = (hex) => {
	let out = "";
	for (let i = 0; i + 2 <= hex.length; i += 2) {
		out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
	}
	return out;
};
const textToHex = (text) => Buffer.from(text, "latin1").toString("hex");

const create = (options, io) => {
	let path = null;
	let port = null;
	let stopped = false;
	let retry = null;
	let rsp = null;
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
			io.status("waiting", "probe not connected" + (options.match ? " (" + JSON.stringify(options.match) + ")" : ""));
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
		rsp = gdbrsp.createRsp((buf) => port.write(buf), (note) => {
			if (note[0] === "O") {
				io.log(hexToText(note.slice(1)), "rx");
			}
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
		io.log("probe on " + path + " (GDB RSP)", "info");
	};

	const onData = (data) => {
		if (rsp) {
			rsp.onData(data);
		}
	};

	const ensure = () => {
		if (!port || !rsp) {
			throw new Error("not connected");
		}
		return rsp;
	};

	// qRcmd monitor command -> decoded text output (O records)
	const monitor = (text, timeoutMs) => {
		const r = ensure();
		return r.command("qRcmd," + textToHex(text), timeoutMs || 10000).then((reply) => {
			if (reply.indexOf("E") === 0) {
				throw new Error("monitor '" + text + "' failed: " + reply);
			}
			return reply;
		});
	};

	const commands = {
		monitor: (args) => {
			return monitor(String(args.command)).then((reply) => {
				return { reply: reply };
			});
		},

		// scan wrappers: BMP prints targets as text via O records
		scan_swd: () => monitor("swdp_scan", 15000).then(() => ({ ok: true })),
		scan_jtag: () => monitor("jtag_scan", 15000).then(() => ({ ok: true })),
		attach: (args) => monitor("attach " + (args.n || 1)).then(() => ({ ok: true })),
		reset: () => monitor("r").then(() => ({ ok: true })),

		// halt: Ctrl-C interrupt, then the T stop record lands as a reply
		halt: () => {
			const r = ensure();
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("halt timeout (target already halted?)")), 5000);
				const check = () => {
					const notes = r.drainNotifications();
					const stop = notes.find((n) => n[0] === "T" || n === "S");
					if (stop) {
						clearTimeout(timer);
						resolve({ stopped: true, reason: stop });
						return;
					}
					setTimeout(check, 25);
				};
				port.write(Buffer.from([3])); // interrupt
				check();
			});
		},

		resume: () => {
			const r = ensure();
			return r.command("c", 3000).then((reply) => ({ reply: reply }));
		},
		step: () => {
			const r = ensure();
			return r.command("s", 5000).then((reply) => ({ reply: reply }));
		},

		read: (args) => {
			const r = ensure();
			const addr = Number(args.address);
			const count = Number(args.count) || 16;
			const chunks = [];
			const step = 512;
			const readChunk = (off) => {
				return r.command("m" + (addr + off).toString(16) + "," + Math.min(step, count - off).toString(16), 10000).then((reply) => {
					if (reply.indexOf("E") === 0) {
						throw new Error("read failed at 0x" + (addr + off).toString(16) + ": " + reply);
					}
					const buf = Buffer.from(reply, "hex");
					chunks.push(buf);
					return off + buf.length >= count || buf.length < Math.min(step, count - off) ? null : readChunk(off + buf.length);
				});
			};
			return readChunk(0).then(() => {
				const data = Buffer.concat(chunks).slice(0, count);
				const name = args.name || "mem";
				io.blob(name, data);
				return { blob: io.id + "_" + name, bytes: data.length, hex: data.toString("hex") };
			});
		},

		write: (args) => {
			const r = ensure();
			const clean = String(args.hex).replace(/0x/gi, "").replace(/[\s,:]/g, "");
			if (!/^([0-9a-f]{2})*$/i.test(clean)) {
				throw new Error("hex must be pairs of hex digits");
			}
			const data = Buffer.from(clean, "hex");
			const addr = Number(args.address);
			const step = 512;
			const writeChunk = (off) => {
				const part = data.slice(off, off + step);
				return r.command("M" + (addr + off).toString(16) + "," + part.length.toString(16) + ":" + part.toString("hex"), 10000).then((reply) => {
					if (reply !== "OK") {
						throw new Error("write failed at 0x" + (addr + off).toString(16) + ": " + reply);
					}
					return off + part.length >= data.length ? null : writeChunk(off + part.length);
				});
			};
			return writeChunk(0).then(() => ({ ok: true, bytes: data.length }));
		},

		// all registers: g -> concatenated 32-bit words (32-bit target)
		regs: () => {
			const r = ensure();
			return r.command("g", 5000).then((reply) => {
				if (reply.indexOf("E") === 0) {
					throw new Error("regs failed: " + reply);
				}
				const regs = [];
				for (let i = 0; i + 8 <= reply.length; i += 8) {
					regs.push(parseInt(reply.slice(i, i + 8), 16));
				}
				return { regs: regs };
			});
		},

		reg: (args) => {
			const r = ensure();
			const n = Number(args.n);
			if (args.value === undefined) {
				return r.command("p" + n.toString(16), 3000).then((reply) => {
					if (reply.indexOf("E") === 0) {
						throw new Error("reg read failed: " + reply);
					}
					return { n: n, value: parseInt(reply, 16) };
				});
			}
			return r.command("P" + n.toString(16) + "=" + Number(args.value).toString(16).padStart(8, "0"), 3000).then((reply) => {
				if (reply !== "OK") {
					throw new Error("reg write failed: " + reply);
				}
				return { n: n, value: Number(args.value) };
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
	name: "bmp",
	description: "Black Magic Probe (GDB RSP over serial): monitor commands (swdp_scan/jtag_scan/reset), halt/resume/step, memory read -> blobs, writes, registers. Follows the probe by identity and reconnects after replugs",
	options: {
		path: "fixed device node, e.g. /dev/ttyACM0 (or use match)",
		match: "{vid, pid, serial, product, usbPath, interface, byId}: stable identity from uart_ports",
		baud: "baud rate (default 115200)"
	},
	commands: {
		monitor: "{command} raw BMP monitor command (qRcmd)",
		scan_swd: "{} SW-DP target scan", scan_jtag: "{} JTAG target scan",
		attach: "{n?} attach to target n", reset: "{} target reset",
		halt: "{} interrupt the target", resume: "{} continue", step: "{} single step",
		read: "{address, count?, name?} memory -> blob + hex",
		write: "{address, hex} write memory",
		regs: "{} all registers (32-bit words)", reg: "{n, value?} read/write one register",
		status: "{} port, settings"
	},
	create: create
};
