// nRF52840 ESB packet radio bridge (mdp-p906 bridge firmware,
// ~/mdp-p906/bridge/src/main.cpp): a raw serial line protocol at 115200.
// One command per line, replies are single lines:
//   C <ch> <addr5hex> [order]  -> "OK ch=.. addr=.. order=.. ackbit=.. ackmode=.. ackdelay=.. prefix=.. base=.."
//   X <hex32> [rx_ms]          -> "ACK <tries>" | "NOACK", then "RX <hdr>[ DUP] <hex64>" per reply, then "TIMEOUT"
//   L <ms>                     -> "RX ..." lines while listening, then "OK heard <n>"
//   S                          -> "OK rx=<n> dup=<n>" (resets the counters)
//   D <ack_delay_us>           -> "OK ch=.." (config echo)
//   A <ackmode>                -> config echo
//   P <ackbit>                 -> config echo
//   ?                          -> config echo
//   B                          -> "OK bootloader" (then the MCU reboots into UF2)
// Operates on 2.4 GHz ESB (nRF24-compatible enhanced shockburst); the band is
// license-free ISM in every region table, so no extra TX gating is needed.
// The port is found by identity and the driver reconnects across replugs.

const tty = require("../../services/tty");
const usb = require("../../services/usb");

const RETRY_MS = 3000;
const QUERY_TIMEOUT_MS = 30000;
const MAX_PAYLOAD = 32;

const hexDump = (buf) => Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(" ");

const parseHex = (hex, max) => {
	const clean = String(hex).replace(/0x/gi, "").replace(/[\s,:]/g, "");
	if (!/^([0-9a-f]{2})*$/i.test(clean)) {
		throw new Error("hex must be pairs of hex digits, e.g. \"de ad be ef\"");
	}
	const buf = Buffer.from(clean, "hex");
	if (buf.length === 0) {
		throw new Error("empty hex payload");
	}
	if (buf.length > (max || MAX_PAYLOAD)) {
		throw new Error("payload is " + buf.length + " bytes, max " + (max || MAX_PAYLOAD));
	}
	return buf;
};

// "RX 5F DUP 010203..." -> {hdr: 0x5f, dup: true, data: Buffer}
const parseRxLine = (line) => {
	const m = /^RX ([0-9a-f]{2})( DUP)? ([0-9a-f]+)$/i.exec(line.trim());
	if (!m) {
		return null;
	}
	const data = Buffer.from(m[3], "hex");
	return { hdr: parseInt(m[1], 16), dup: Boolean(m[2]), data: data };
};

// config echo line -> object (fields differ per firmware build)
const parseConfigLine = (line) => {
	const m = /^OK ch=(\d+) addr=([0-9a-f]{10}) order=(\d+) ackbit=(\d+) ackmode=(\d+) ackdelay=(\d+) prefix=([0-9a-f]{2}) base=([0-9a-f]{8})$/i.exec(line.trim());
	if (!m) {
		return null;
	}
	return {
		ch: parseInt(m[1], 10),
		addr: m[2].toLowerCase(),
		order: parseInt(m[3], 10),
		ackbit: parseInt(m[4], 10),
		ackmode: parseInt(m[5], 10),
		ackdelay: parseInt(m[6], 10),
		prefix: m[7].toLowerCase(),
		base: m[8].toLowerCase()
	};
};

const create = (options, io) => {
	let path = null;
	let port = null;
	let stopped = false;
	let retry = null;
	let pending = "";
	let waiters = [];
	let queue = Promise.resolve();
	let stats = { rx: 0, dup: 0 };
	let cfg = null;
	const settings = { baud: Number(options.baud) || 115200 };

	const resolve = () => {
		if (options.path) {
			return options.path;
		}
		const found = usb.findPort(usb.serialPorts(usb.inventory().buses), options.match || {});
		return found ? found.node : null;
	};

	const emitPacket = (pkt) => {
		stats.rx++;
		if (pkt.dup) {
			stats.dup++;
		}
		io.log("RX " + pkt.hdr.toString(16).padStart(2, "0") + (pkt.dup ? " DUP" : "") + " " + hexDump(pkt.data), "rx");
		io.sample("rx", stats.rx);
		io.sample("dup", stats.dup);
		io.event("rx", { hdr: pkt.hdr, dup: pkt.dup, data: pkt.data.toString("hex") });
	};

	const onLine = (line) => {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		const rx = parseRxLine(trimmed);
		if (rx) {
			emitPacket(rx);
		} else if (/^OK |^ERR /.test(trimmed)) {
			io.log(trimmed, "rx");
		} else {
			io.log(trimmed, "warn");
		}
		waiters.slice().forEach((w) => w.line(trimmed));
	};

	const onData = (data) => {
		const parts = (pending + data.toString("latin1")).split(/\r\n|\n|\r/);
		pending = parts.pop();
		parts.forEach(onLine);
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
			io.status("waiting", "bridge not connected" + (options.match ? " (" + JSON.stringify(options.match) + ")" : ""));
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

	const send = (line) => {
		if (!port) {
			throw new Error("not connected");
		}
		port.write(Buffer.from(line + "\n", "latin1"));
	};

	// one command at a time: the bridge answers a single line at a time
	const run = (line, opts) => {
		const job = queue.then(() => {
			return new Promise((done, fail) => {
				const lines = [];
				const timeoutMs = (opts && opts.timeoutMs) || QUERY_TIMEOUT_MS;
				const w = {
					line: (l) => {
						lines.push(l);
						if (opts && opts.done && opts.done(l, lines)) {
							finish(null);
						}
					}
				};
				const finish = (err) => {
					clearTimeout(timer);
					waiters = waiters.filter((x) => x !== w);
					if (err) {
						fail(err);
					} else {
						done(lines);
					}
				};
				const timer = setTimeout(() => finish(new Error("timeout waiting for bridge reply to \"" + line + "\", got: " + lines.join(" | "))), timeoutMs);
				waiters.push(w);
				try {
					send(line);
				} catch (err) {
					finish(err);
				}
			});
		});
		// keep the queue alive past a failed command
		queue = job.catch(() => null);
		return job;
	};

	const collectPackets = (lines) => {
		return lines.map(parseRxLine).filter(Boolean);
	};

	const failIfErr = (lines) => {
		const err = lines.find((l) => /^ERR /.test(l));
		if (err) {
			throw new Error(err);
		}
		return lines;
	};

	const commands = {
		configure: (args) => {
			const addr = parseHex(args.addr, 5);
			if (addr.length !== 5) {
				throw new Error("addr must be exactly 5 bytes");
			}
			const ch = Number(args.ch);
			if (!Number.isInteger(ch) || ch < 0 || ch > 125) {
				throw new Error("ch must be 0..125");
			}
			const line = "C " + ch + " " + addr.toString("hex") + (args.order !== undefined ? " " + Number(args.order) : "");
			return run(line, { done: (l) => /^OK ch=|^ERR /.test(l) }).then(failIfErr).then((lines) => {
				const parsed = parseConfigLine(lines[lines.length - 1]);
				if (!parsed) {
					throw new Error("unexpected config reply: " + lines.join(" | "));
				}
				cfg = parsed;
				return parsed;
			});
		},

		// send a payload (hex, <= 32 bytes), wait for the ACK outcome and any
		// replies that arrive in the rx window afterwards
		send: (args) => {
			const payload = parseHex(args.data);
			const rxMs = args.rx_ms === undefined ? 50 : Number(args.rx_ms);
			if (!Number.isFinite(rxMs) || rxMs < 0 || rxMs > 60000) {
				throw new Error("rx_ms must be 0..60000");
			}
			const line = "X " + payload.toString("hex") + " " + rxMs;
			let sawAck = false;
			return run(line, {
				timeoutMs: (args.timeoutMs || 10000) + rxMs,
				done: (l) => {
					if (/^(ACK |NOACK)/.test(l)) {
						sawAck = true;
						return false;
					}
					if (/^RX /.test(l)) {
						// an RX during the X window ends the command (the
						// firmware returns right after printing it)
						return sawAck;
					}
					return /^TIMEOUT|^ERR /.test(l);
				}
			}).then(failIfErr).then((lines) => {
				const ack = lines.find((l) => /^ACK /.test(l));
				const noack = lines.find((l) => /^NOACK/.test(l));
				if (!ack && !noack) {
					throw new Error("no ACK/NOACK in reply: " + lines.join(" | "));
				}
				return { acked: Boolean(ack), tries: ack ? parseInt(ack.split(" ")[1], 10) : null, replies: collectPackets(lines) };
			});
		},

		listen: (args) => {
			const ms = args.ms === undefined ? 1000 : Number(args.ms);
			if (!Number.isFinite(ms) || ms < 1 || ms > 600000) {
				throw new Error("ms must be 1..600000");
			}
			return run("L " + ms, {
				timeoutMs: (args.timeoutMs || QUERY_TIMEOUT_MS) + ms,
				done: (l) => /^OK heard|^ERR /.test(l)
			}).then(failIfErr).then((lines) => {
				const heard = lines.find((l) => /^OK heard /.test(l));
				return { heard: heard ? parseInt(heard.split(" ")[2], 10) : 0, packets: collectPackets(lines) };
			});
		},

		// bridge counters, returned and reset
		stats: () => {
			return run("S", { done: (l) => /^OK rx=|^ERR /.test(l) }).then(failIfErr).then((lines) => {
				const m = /^OK rx=(\d+) dup=(\d+)$/.exec(lines[lines.length - 1].trim());
				if (!m) {
					throw new Error("unexpected stats reply: " + lines.join(" | "));
				}
				return { rx: parseInt(m[1], 10), dup: parseInt(m[2], 10) };
			});
		},

		set_ack: (args) => {
			const parts = [];
			if (args.delay_us !== undefined) {
				const v = Number(args.delay_us);
				if (!Number.isInteger(v) || v < 0 || v > 100000) {
					throw new Error("delay_us must be 0..100000");
				}
				parts.push("D " + v);
			}
			if (args.mode !== undefined) {
				parts.push("A " + (Number(args.mode) & 1));
			}
			if (args.bit !== undefined) {
				parts.push("P " + (Number(args.bit) & 1));
			}
			if (!parts.length) {
				throw new Error("nothing to set (delay_us?/mode?/bit?)");
			}
			return parts.reduce((p, line) => p.then(() => {
				return run(line, { done: (l) => /^OK ch=|^ERR /.test(l) });
			}), Promise.resolve()).then(failIfErr).then(() => commands.config());
		},

		config: () => {
			return run("?", { done: (l) => /^OK ch=|^ERR /.test(l) }).then(failIfErr).then((lines) => {
				const parsed = parseConfigLine(lines[lines.length - 1]);
				if (!parsed) {
					throw new Error("unexpected config reply: " + lines.join(" | "));
				}
				cfg = parsed;
				return parsed;
			});
		},

		bootloader: () => {
			return run("B", { done: (l) => /^OK bootloader|^ERR /.test(l) }).then(failIfErr).then(() => ({ ok: true, note: "bridge rebooted into UF2 DFU" }));
		},

		status: () => Object.assign({ path: path, connected: Boolean(port), stats: Object.assign({}, stats) }, settings, { config: cfg })
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
	name: "esb",
	description: "nRF52840 ESB packet radio bridge (mdp-p906 bridge firmware): 2.4 GHz ESB TX/RX with auto-ACK, listen windows, per-packet RX events. Follows the adapter by identity and reconnects after replugs",
	options: {
		path: "fixed device node, e.g. /dev/ttyACM0 (or use match)",
		match: "{vid, pid, serial, product, usbPath, interface, byId}: stable identity from uart_ports",
		baud: "baud rate (default 115200, fixed by the firmware)"
	},
	commands: {
		configure: "{ch: 0..125, addr: 5-byte hex, order?} set ESB channel and pipe address, returns the config echo",
		send: "{data: hex <= 32B, rx_ms?: reply window (default 50)} transmit with auto-retry; returns {acked, tries, replies: [{hdr, dup, data}]}",
		listen: "{ms: window (default 1000)} receive packets; returns {heard, packets}",
		stats: "{} bridge rx/dup counters (returned and reset)",
		set_ack: "{delay_us?, mode?, bit?} ACK timing/mode/noack-bit tweaks",
		config: "{} query the bridge config echo",
		bootloader: "{} reboot into UF2 DFU",
		status: "{} port, config, counters"
	},
	create: create,
	_test: { parseHex: parseHex, parseRxLine: parseRxLine, parseConfigLine: parseConfigLine, hexDump: hexDump }
};
