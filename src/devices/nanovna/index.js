// NanoVNA-H / H4 / compatible clones over the original shell protocol: a
// line-based command console on USB CDC (prompt "ch> "). sweep/scan/data
// -> S11 & S21 logmag/phase traces; calibration state via `cal`; sweep
// range + points. Markers are client-side (the trace pane's marker feature
// reads from the trace). Hardware-untested: written against the NanoVNA
// shell command set [HW].

const tty = require("../../services/tty");
const usb = require("../../services/usb");

const RETRY_MS = 1000;
const DEFAULTS = { start: 50e3, stop: 900e6, points: 101 };
const PROMPT = "ch> ";

const db = (re, im) => 10 * Math.log10(re * re + im * im + 1e-30);
const deg = (re, im) => Math.atan2(im, re) * 180 / Math.PI;

// complex a / b
const div = (are, aim, bre, bim) => {
	const d = bre * bre + bim * bim || 1e-30;
	return [(are * bre + aim * bim) / d, (aim * bre - are * bim) / d];
};

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	let path = null;
	let port = null;
	let stopped = false;
	let retry = null;
	const stats = { sweeps: 0 };

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
			io.status("waiting", "NanoVNA not connected" + (options.match ? " (" + JSON.stringify(options.match) + ")" : ""));
			retry = setTimeout(connect, RETRY_MS);
			return;
		}
		try {
			path = next;
			port = tty.acquire(path, { baud: Number(options.baud) || 115200, format: "8N1", flow: "none", owner: io.id });
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
		io.status("running", path + " shell");
		io.log("connected, waiting for the ch> prompt...", "info");
		ping().then(() => {
			io.log("shell ready", "info");
		}, (err) => {
			io.log("no prompt: " + err.message, "warn");
		});
	};

	// one command -> its output lines (echo + prompt stripped), with the
	// port's interleaved traffic ignored via the exclusive chain
	let chain = Promise.resolve();
	const exclusive = (fn) => {
		const job = chain.then(fn);
		chain = job.catch(() => null);
		return job;
	};

	let buf = "";
	let waiter = null;
	const onData = (data) => {
		buf += data.toString("latin1");
		if (waiter) {
			const i = buf.lastIndexOf(PROMPT);
			if (i !== -1) {
				const out = buf.slice(0, i);
				buf = buf.slice(i + PROMPT.length);
				const w = waiter;
				waiter = null;
				clearTimeout(w.timer);
				w.resolve(out);
			}
		} else {
			// async output (sweep progress): log whole lines
			const nl = buf.lastIndexOf("\n");
			if (nl !== -1) {
				buf.slice(0, nl).split("\n").forEach((line) => {
					if (line.trim()) {
						io.log(line.trim(), "rx");
					}
				});
				buf = buf.slice(nl + 1);
			}
		}
	};

	// send a line, collect output until the next prompt
	const talk = (line, timeoutMs) => {
		return exclusive(() => {
			return new Promise((resolve, reject) => {
				if (!port) {
					reject(new Error("not connected"));
					return;
				}
				waiter = {
					resolve: resolve,
					timer: setTimeout(() => {
						waiter = null;
						reject(new Error("timeout waiting for '" + PROMPT + "' after: " + line));
					}, timeoutMs || 30000)
				};
				io.log("> " + line, "tx");
				port.write(Buffer.from(line + "\r\n", "latin1"));
			});
		});
	};

	// output -> lines, echo stripped (the console echoes the command)
	const linesOf = (out, line) => {
		return out.split("\n").map((s) => s.replace(/\r$/, "").trim()).filter((l) => l && l !== line.trim());
	};

	const ping = () => talk("info", 5000).then(() => null, () => null);

	// "re im" pairs -> {freq[], logmag[], phase[]}
	const parseData = (lines, freqs) => {
		const out = [];
		lines.forEach((l) => {
			const m = /^(-?[\d.eE+]+)\s+(-?[\d.eE+]+)$/.exec(l);
			if (m) {
				out.push([Number(m[1]), Number(m[2])]);
			}
		});
		const n = Math.min(out.length, freqs.length);
		return {
			freq: freqs.slice(0, n),
			re: out.slice(0, n).map((p) => p[0]),
			im: out.slice(0, n).map((p) => p[1])
		};
	};

	const frequencies = (points) => {
		const start = Number(settings.start);
		const stop = Number(settings.stop);
		const step = (stop - start) / Math.max(1, points - 1);
		const out = [];
		for (let i = 0; i < points; i++) {
			out.push(Math.round(start + step * i));
		}
		return out;
	};

	const commands = {
		info: () => {
			return talk("info", 10000).then((out) => {
				const lines = linesOf(out, "info");
				io.log(lines.join(" | "), "rx");
				return { lines: lines, version: lines[0] || "" };
			});
		},

		cal: () => {
			return talk("cal", 10000).then((out) => {
				const lines = linesOf(out, "cal");
				return { lines: lines, calibrated: lines.some((l) => /cal/i.test(l) && !/no|off|none/i.test(l)) };
			});
		},

		// set the sweep plan; scan executes it and data 0/1 fetches the traces
		sweep: (args) => {
			if (args.start !== undefined) {
				settings.start = Number(args.start);
			}
			if (args.stop !== undefined) {
				settings.stop = Number(args.stop);
			}
			if (args.points !== undefined) {
				settings.points = Math.max(2, Math.min(2001, Math.round(Number(args.points))));
			}
			const steps = [
				talk("sweep start " + Math.round(settings.start)),
				talk("sweep stop " + Math.round(settings.stop)),
				talk("sweep points " + settings.points)
			];
			return steps.reduce((p, step) => p.then(() => step), Promise.resolve()).then(() => {
				return { start: settings.start, stop: settings.stop, points: settings.points };
			});
		},

		// run the sweep, publish S11 + S21 traces (logmag + phase)
		scan: () => {
			const points = settings.points;
			const freqs = frequencies(points);
			return talk("scan " + Math.round(settings.start) + " " + Math.round(settings.stop) + " " + points, 120000)
				.then(() => talk("data 0", 30000))
				.then((out) => parseData(linesOf(out, "data 0"), freqs))
				.then((s11raw) => {
					return talk("data 1", 30000).then((out2) => {
						return { s11: s11raw, s21: parseData(linesOf(out2, "data 1"), freqs) };
					});
				})
				.then((pair) => {
					const n = Math.min(pair.s11.freq.length, pair.s21.freq.length);
					const f = pair.s11.freq.slice(0, n);
					const xs = f.map((hz) => hz / 1e6); // MHz
					const s11db = [];
					const s11ph = [];
					const s21db = [];
					const s21ph = [];
					for (let i = 0; i < n; i++) {
						const [r, x] = div(pair.s21.re[i], pair.s21.im[i], pair.s11.re[i], pair.s11.im[i]);
						s11db.push(db(pair.s11.re[i], pair.s11.im[i]));
						s11ph.push(deg(pair.s11.re[i], pair.s11.im[i]));
						s21db.push(db(r, x));
						s21ph.push(deg(r, x));
					}
					io.trace("s11", {
						x: xs, xUnit: "MHz",
						series: [{ label: "S11 dB", y: s11db }, { label: "S11 phase", y: s11ph, axis: "right" }]
					});
					io.trace("s21", {
						x: xs, xUnit: "MHz",
						series: [{ label: "S21 dB", y: s21db }, { label: "S21 phase", y: s21ph, axis: "right" }]
					});
					stats.sweeps++;
					return { points: n, start: f[0], stop: f[n - 1], traces: ["s11", "s21"] };
				});
		},

		// raw complex data of the last sweep (chan 0=S11, 1=S21)
		data: (args) => {
			const ch = args.channel === 1 ? 1 : 0;
			return talk("data " + ch, 30000).then((out) => {
				const pairs = parseData(linesOf(out, "data " + ch), frequencies(settings.points));
				return { channel: ch, points: pairs.freq.length, re: pairs.re, im: pairs.im, freq: pairs.freq };
			});
		},

		status: () => ({ path: path, connected: Boolean(port), settings: settings, stats: stats })
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
			if (port) {
				port.off("data", onData);
			}
			return disconnect();
		},
		command: (name, args) => {
			if (!commands[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		},
		_onData: onData // test seam: feed bytes like the port would
	};
};

module.exports = {
	name: "nanovna",
	description: "NanoVNA-H / H4 / clones (original shell protocol, text console on USB CDC): sweep range + points, scan -> S11/S21 logmag+phase traces, calibration state, raw complex data. Follows the adapter and reconnects",
	options: {
		path: "fixed device node (or use match)",
		match: "{vid, pid, serial, ...}: stable identity from uart_ports",
		baud: "console baud (default 115200)",
		start: "sweep start in Hz (default 50k)",
		stop: "sweep stop in Hz (default 900M)",
		points: "sweep points (default 101)"
	},
	commands: {
		info: "{} version/board info",
		cal: "{} calibration state",
		sweep: "{start?, stop?, points?} set the sweep plan",
		scan: "{} run the sweep; S11 + S21 traces (logmag dB + phase, S21 referenced)",
		data: "{channel: 0|1} raw complex pairs of the last sweep",
		status: "{} port, sweep plan, counters"
	},
	create: create,
	_test: { db: db, deg: deg, div: div }
};
