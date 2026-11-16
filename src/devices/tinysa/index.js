// tinySA / tinySA Ultra spectrum analyzer over its USB serial shell.
// "scan <start> <stop> <points> 3" prints "<freq> <dBm>" lines, then "ch> ".
// TODO: verify on hardware (written from the tinySA shell docs)

const tty = require("../../services/tty");

const PROMPT = "ch> ";
const SCAN_TIMEOUT_MS = 30000;
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
		return shell(command, SCAN_TIMEOUT_MS).then((lines) => {
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

	return {
		start: () => {
			port = tty.acquire(options.path, { baud: options.baud || 115200, owner: io.id });
			return shell("version").then((lines) => {
				io.log("connected: " + lines.join(" "));
				running = options.continuous !== false;
				loop();
			});
		},

		stop: () => {
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
			if (name === "continuous") {
				running = Boolean(args.on);
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
		sweep: "{start, stop, points} single sweep",
		configure: "{start, stop, points} for continuous sweeps",
		continuous: "{on: bool}",
		shell: "{text, timeoutMs} raw shell command (see tinySA shell docs)"
	},
	create: create
};
