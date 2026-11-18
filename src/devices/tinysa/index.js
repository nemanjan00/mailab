// tinySA / tinySA Ultra spectrum analyzer over its USB serial shell.
// "scan <start> <stop> <points> 3" prints "<freq> <dBm>" lines, then "ch> ".
// TODO: verify on hardware (written from the tinySA shell docs)

const tty = require("../../services/tty");
const parseSwitch = require("../../utils/args").parseSwitch;

const PROMPT = "ch> ";
const SCAN_TIMEOUT_MS = 30000;
const RETRY_MS = 2000;
const DEFAULTS = { start: 1e6, stop: 800e6, points: 450 };

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	let port = null;
	let running = false;
	let busy = Promise.resolve();

	// serialize shell commands
	const shell = (text, timeoutMs) => {
		const run = busy.then(() => {
			const reply = tty.collect(port, (buf) => {
				return buf.toString("latin1").endsWith(PROMPT);
			}, timeoutMs || 2000);
			port.write(text + "\r");
			return reply;
		}).then((buf) => {
			// drop the echoed command and the prompt
			return buf.toString("latin1").split(/\r?\n/).slice(1).filter((line) => {
				return line && line !== PROMPT.trim() && !line.startsWith(PROMPT);
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
			port = tty.acquire(options.path, { baud: options.baud || 115200, owner: io.id });
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
			tty.release(options.path, io.id).catch(() => {}).then(() => {
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
			return tty.release(options.path, io.id);
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
