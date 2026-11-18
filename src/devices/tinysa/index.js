// tinySA / tinySA Ultra spectrum analyzer over its USB serial shell.
// "scan <start> <stop> <points> 3" prints "<freq> <dBm>" lines, then "ch> ".
//
// The port uses a plain non-blocking fd + a read poll, not tty.ReadStream:
// on the lab host a ReadStream on the USB CDC device wedged the whole node
// event loop (listener alive but never accepting) within a minute.

const fs = require("fs");
const { EventEmitter } = require("events");
const execFileSync = require("child_process").execFileSync;
const parseSwitch = require("../../utils/args").parseSwitch;

const PROMPT = "ch> ";
const SCAN_TIMEOUT_MS = 30000;
const RETRY_MS = 2000;
const DEFAULTS = { start: 1e6, stop: 800e6, points: 450 };

// raw serial port: O_NONBLOCK fd, explicit poll-read, no tty streams
const openPort = (path, baud) => {
	const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
	execFileSync("stty", ["-F", path, "raw", "-echo", "-hupcl", String(baud)]);
	const port = new EventEmitter();
	port.path = path;
	port.fd = fd;
	port.isOpen = true;
	port.write = (data) => {
		if (!port.isOpen) {
			return false;
		}
		try {
			fs.writeSync(fd, data);
			return true;
		} catch (_err) {
			return false;
		}
	};
	const chunk = Buffer.alloc(4096);
	port.poll = setInterval(() => {
		if (!port.isOpen) {
			return;
		}
		let n;
		try {
			n = fs.readSync(fd, chunk, 0, chunk.length, null);
		} catch (err) {
			if (err.code === "EAGAIN") {
				return;
			}
			port.isOpen = false;
			port.emit("error", err);
			return;
		}
		if (n > 0) {
			port.emit("data", chunk.slice(0, n));
		}
	}, 10);
	port.close = () => {
		port.isOpen = false;
		clearInterval(port.poll);
		try {
			fs.closeSync(fd);
		} catch (_err) {
			// already gone
		}
		return Promise.resolve();
	};
	return port;
};

// collect until `done(buffer)` or timeout (same contract as services/tty)
const collect = (port, done, timeoutMs) => {
	return new Promise((resolve, reject) => {
		let acc = Buffer.alloc(0);
		const finish = (err) => {
			clearTimeout(timer);
			port.off("data", onData);
			if (err) {
				err.partial = acc;
				reject(err);
			} else {
				resolve(acc);
			}
		};
		const onData = (data) => {
			acc = Buffer.concat([acc, data]);
			if (done(acc)) {
				finish();
			}
		};
		const timer = setTimeout(() => {
			finish(new Error("serial timeout on " + port.path));
		}, timeoutMs);
		port.on("data", onData);
	});
};

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	let port = null;
	let running = false;
	let busy = Promise.resolve();

	// serialize shell commands; a timed-out command leaves the device
	// streaming (e.g. a slow scan) — drain before the next command so its
	// reply isn't polluted by trailing output
	const shell = (text, timeoutMs) => {
		const run = busy.then(() => {
			const reply = collect(port, (buf) => {
				return buf.toString("latin1").endsWith(PROMPT);
			}, timeoutMs || 2000);
			port.write(text + "\r");
			return reply;
		}).then((buf) => {
			// drop the echoed command and the prompt
			return buf.toString("latin1").split(/\r?\n/).slice(1).filter((line) => {
				return line && line !== PROMPT.trim() && !line.startsWith(PROMPT);
			});
		}, (err) => {
			const drain = collect(port, (buf) => {
				return buf.toString("latin1").endsWith(PROMPT);
			}, 1500).catch(() => Buffer.alloc(0));
			return drain.then(() => {
				throw err;
			});
		});
		busy = run.catch(() => {
			return null;
		});
		return run;
	};

	const sweep = (args) => {
		const s = Object.assign({}, settings, args);
		const command = "scan " + Math.round(s.start) + " " + Math.round(s.stop) + " " + s.points + " 3";
		// scan time scales with 1/RBW: at the narrowest RBW a wide sweep can
		// run for minutes — give the shell a budget derived from it
		const rbwKhz = Number(s.rbwKhz) || Number(s.rbw) || 850;
		const spanRatio = Math.max(1, (s.stop - s.start) / 1e6);
		const timeoutMs = Math.max(SCAN_TIMEOUT_MS, Math.min(600000, s.points * Math.min(rbwKhz, 850) * 4 * spanRatio));
		return shell(command, timeoutMs).then((lines) => {
			const rows = lines.map((line) => {
				return line.trim().split(/\s+/).map(Number);
			}).filter((row) => {
				return row.length >= 2 && !Number.isNaN(row[0]);
			});
			const x = rows.map((row) => {
				return row[0];
			});
			const y = rows.map((row) => {
				return row[1];
			});
			io.trace("spectrum", { x: x, xUnit: "Hz", yUnit: "dBm", series: [{ label: "dBm", y: y }] });
			const peak = y.indexOf(Math.max.apply(null, y));
			io.sample("peak_freq", x[peak], { unit: "Hz" });
			io.sample("peak_dbm", y[peak], { unit: "dBm" });
			return { points: x.length, peak: { hz: x[peak], dbm: y[peak] } };
		});
	};

	const loop = () => {
		if (!running) {
			return;
		}
		sweep({})
			.catch((err) => {
				io.log("sweep failed: " + err.message, "warn");
			})
			.then(() => {
				setTimeout(loop, settings.intervalMs || 0);
			});
	};

	let stopped = false;
	let retry = null;

	// connect with retry: the MCU can take seconds to boot after a reset
	// (or answer nothing while a previous slow scan drains), and a failed
	// handshake must not leave the device permanently error-ed
	const connect = () => {
		retry = null;
		if (stopped) {
			return;
		}
		try {
			port = openPort(options.path, options.baud || 115200);
		} catch (err) {
			io.status("waiting", err.message);
			retry = setTimeout(connect, RETRY_MS);
			return;
		}
		shell("version", 8000).then((lines) => {
			io.log("connected: " + lines.join(" "));
			io.status("running", options.path);
			running = options.continuous !== false;
			loop();
		}, (err) => {
			io.log("handshake failed: " + err.message + " — retrying", "warn");
			port = null;
			port.close().then(() => {
				if (!stopped && !retry) {
					retry = setTimeout(connect, RETRY_MS);
				}
			});
			return null;
		});
	};

	return {
		start: () => {
			stopped = false;
			connect();
			return Promise.resolve();
		},

		stop: () => {
			stopped = true;
			clearTimeout(retry);
			running = false;
			if (!port) {
				return Promise.resolve();
			}
			return port.close();
		},

		command: (name, args) => {
			if (name === "sweep") {
				return sweep(args || {});
			}
			if (name === "configure") {
				Object.assign(settings, args);
				return Promise.resolve(settings);
			}
			if (name === "rbw") {
				// resolution bandwidth in kHz (the tinySA shell unit), 0.2..850 or auto
				const v = args.khz !== undefined ? String(args.khz) : "auto";
				if (v !== "auto") {
					const n = Number(v);
					if (!Number.isFinite(n) || n < 0.2 || n > 850) {
						return Promise.reject(new Error("rbw khz must be 0.2..850 or auto"));
					}
				}
				return shell("rbw " + v, 15000).then((lines) => {
					return { lines: lines };
				});
			}
			if (name === "continuous") {
				running = parseSwitch(args.on, "on");
				loop();
				return Promise.resolve({ running: running });
			}
			if (name === "shell") {
				return shell(args.text, args.timeoutMs).then((lines) => {
					return { lines: lines };
				});
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "tinysa",
	description: "tinySA / tinySA Ultra spectrum analyzer: trace \"spectrum\", peak_freq/peak_dbm channels",
	options: {
		path: "serial port (required)",
		start: "Hz (default 1e6)",
		stop: "Hz (default 800e6)",
		points: "default 450",
		continuous: "sweep continuously (default true)",
		intervalMs: "pause between sweeps"
	},
	commands: {
		sweep: "{start, stop, points, rbwKhz?} single sweep; the shell timeout scales with the RBW budget",
		rbw: "{khz: 0.2..850 | auto} resolution bandwidth in kHz (the tinySA shell unit) — narrow RBW is what reveals the true noise floor",
		configure: "{start, stop, points} for continuous sweeps",
		continuous: "{on: bool}",
		shell: "{text, timeoutMs} raw shell command (see tinySA shell docs)"
	},
	create: create
};
