// HackRF One wideband spectrum via hackrf_sweep -> trace "spectrum".
// hackrf_sweep lines: date, time, hz_low, hz_high, bin_width, samples, dB...
// TX path: `transmit {blob|path, freqHz, rate, gain, seconds, format}` streams IQ
// through hackrf_transfer (repeat mode). The shared TX policy (src/txpolicy)
// gates band / gain / duration and tracks a TX session before this runs.

const spawn = require("child_process").spawn;
const readline = require("readline");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULTS = { startMhz: 1, stopMhz: 6000, binWidth: 1000000, lna: 16, vga: 20 };

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	let proc = null;
	let bins = [];
	let maxLow = -1;

	const flush = (keep) => {
		if (!bins.length) {
			return;
		}
		const sorted = bins.sort((a, b) => {
			return a[0] - b[0];
		});
		const x = sorted.map((bin) => {
			return bin[0];
		});
		const y = sorted.map((bin) => {
			return bin[1];
		});
		io.trace("spectrum", { x: x, xUnit: "Hz", yUnit: "dB", series: [{ label: "dB", y: y }] });
		const peak = y.indexOf(Math.max.apply(null, y));
		io.sample("peak_freq", x[peak], { unit: "Hz" });
		io.sample("peak_db", y[peak], { unit: "dB" });
		if (!keep) {
			// a wrap starts a fresh pass; a timer flush only publishes the
			// pass accumulated so far (waterfall rows show it filling in)
			bins = [];
		}
	};

	const onLine = (line) => {
		const cells = line.split(",").map((cell) => {
			return cell.trim();
		});
		if (cells.length < 7) {
			return;
		}
		const low = Number(cells[2]);
		const width = Number(cells[4]);
		// a new sweep pass wraps back below the highest band seen so far
		// (a single-band span repeats the same low, so low < maxLow is the
		// only reliable wrap signal)
		if (low < maxLow) {
			flush(false);
		}
		if (low > maxLow) {
			maxLow = low;
		}
		cells.slice(6).forEach((cell, i) => {
			bins.push([low + (i + 0.5) * width, Number(cell)]);
		});
	};

	const normalize = (args) => {
		const s = Object.assign({}, args);
		if (s.binWidth === undefined && s.binWidthMhz !== undefined) {
			s.binWidth = Number(s.binWidthMhz) * 1e6;
		}
		if (s.binWidth === undefined && s.binWidthKhz !== undefined) {
			s.binWidth = Number(s.binWidthKhz) * 1e3;
		}
		delete s.binWidthMhz;
		delete s.binWidthKhz;
		if (s.binWidth !== undefined) {
			s.binWidth = Math.max(20e3, Math.min(5e6, Number(s.binWidth) || settings.binWidth));
		}
		["startMhz", "stopMhz", "lna", "vga"].forEach((key) => {
			if (s[key] !== undefined) {
				s[key] = Number(s[key]);
			}
		});
		return s;
	};

	let flushTimer = null;
	const launch = () => {
		let select = [];
		if (settings.serial) {
			select = ["-d", String(settings.serial)];
		}
		const args = select.concat([
			"-f", settings.startMhz + ":" + settings.stopMhz,
			"-w", String(settings.binWidth),
			"-l", String(settings.lna),
			"-g", String(settings.vga)
		]);
		io.log("hackrf_sweep " + args.join(" "), "tx");
		bins = [];
		maxLow = -1;
		proc = spawn("hackrf_sweep", args);
		const mine = proc;
		readline.createInterface({ input: proc.stdout }).on("line", onLine);
		readline.createInterface({ input: proc.stderr }).on("line", (line) => {
			io.log(line, "stderr");
		});
		proc.on("exit", (code) => {
			// only the live process may change the status: a configure()
			// relaunch kills the old one, whose exit must not mark us stopped
			if (proc === mine) {
				proc = null;
				io.status("stopped", "hackrf_sweep exited " + code);
			}
		});
		io.status("running", "sweep " + settings.startMhz + "–" + settings.stopMhz + " MHz, "
			+ Math.round(settings.binWidth / 1e3) + " kHz bins");
		// also flush on a timer so partial passes (and single-band spans)
		// reach the UI without waiting for a full wrap — each flush is one
		// waterfall row
		// publish at most once per second while a pass is still building, and
		// the complete spectrum on every pass wrap — each publish is one
		// waterfall row
		flushTimer = setInterval(() => {
			flush(true);
		}, 1000);
	};

	const kill = () => {
		if (flushTimer) {
			clearInterval(flushTimer);
			flushTimer = null;
		}
		if (!proc) {
			return Promise.resolve();
		}
		const old = proc;
		proc = null;
		return new Promise((resolve) => {
			old.once("exit", resolve);
			old.kill();
		});
	};

	let txProc = null;
	let txTimer = null;
	let txFile = null;

	const toCs8 = (bytes, format) => {
		if (format === "cs8") {
			return Buffer.from(bytes);
		}
		const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
		const out = Buffer.alloc(f32.length);
		for (let i = 0; i < f32.length; i++) {
			const v = Math.max(-1, Math.min(1, f32[i])) * 127;
			out[i] = v < 0 ? Math.ceil(v) : Math.floor(v);
		}
		return out;
	};

	const killTx = (reason) => {
		if (txTimer) {
			clearTimeout(txTimer);
			txTimer = null;
		}
		if (!txProc) {
			return Promise.resolve({ stopped: false });
		}
		const old = txProc;
		txProc = null;
		return new Promise((resolve) => {
			old.once("exit", (code) => {
				resolve({ stopped: true, reason: reason, exit: code });
			});
			old.kill();
		}).then((result) => {
			io.log("TX ended: " + (reason || "stopped") + " (exit " + result.exit + ")", "tx");
			return result;
		});
	};

	const transmit = (args) => {
		const freqHz = Number(args.freqHz);
		if (!Number.isFinite(freqHz) || freqHz <= 0) {
			return Promise.reject(new Error("freqHz is required (Hz)"));
		}
		const gain = Number(args.gain || 20);
		const rate = Number(args.rate || 2000000);
		const format = args.format || "cf32";
		const seconds = Number(args.seconds || 0);
		return killTx("new transmit").then(() => {
			return args.blob ? Promise.resolve(io.getBlob(String(args.blob))) : fs.promises.readFile(String(args.path));
		}).then((raw) => {
			const iq = toCs8(raw, format);
			if (!iq.length) {
				throw new Error("empty IQ payload");
			}
			txFile = path.join(os.tmpdir(), "mailab-hackrf-tx-" + Date.now() + ".cs8");
			return fs.promises.writeFile(txFile, iq);
		}).then(() => {
			const txArgs = [
				"-t", txFile,
				"-f", String(Math.round(freqHz)),
				"-x", String(Math.round(gain)),
				"-s", String(Math.round(rate)),
				"-R"
			];
			if (settings.serial) {
				txArgs.push("-d", String(settings.serial));
			}
			io.log("hackrf_transfer " + txArgs.join(" "), "tx");
			txProc = spawn("hackrf_transfer", txArgs);
			readline.createInterface({ input: txProc.stdout }).on("line", (line) => {
				io.log(line, "tx");
			});
			readline.createInterface({ input: txProc.stderr }).on("line", (line) => {
				io.log(line, "stderr");
			});
			txProc.on("exit", (code) => {
				if (txTimer) {
					clearTimeout(txTimer);
					txTimer = null;
				}
				txProc = null;
				if (txFile) {
					fs.promises.unlink(txFile).catch(() => {});
					txFile = null;
				}
				io.log("hackrf_transfer exited " + code, "tx");
			});
			if (seconds > 0) {
				txTimer = setTimeout(() => {
					killTx("time cap " + seconds + " s").catch(() => {});
				}, seconds * 1000);
				txTimer.unref();
			}
			return { started: true, freqHz: freqHz, gain: gain, rate: rate, seconds: seconds, format: format };
		});
	};

	return {
		start: () => {
			launch();
			return Promise.resolve();
		},

		stop: () => {
			return killTx("device stop").then(() => {
				return kill();
			});
		},

		command: (name, args) => {
			if (name === "configure") {
				Object.assign(settings, normalize(args || {}));
				return kill().then(() => {
					launch();
					return settings;
				});
			}
			if (name === "transmit") {
				return transmit(args || {});
			}
			if (name === "transmit_stop") {
				return killTx("transmit_stop");
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "hackrf",
	description: "HackRF One wideband sweep (hackrf_sweep): trace \"spectrum\", peak_freq/peak_db",
	options: {
		serial: "board serial (hackrf_info) when several HackRFs are connected",
		startMhz: "default 1",
		stopMhz: "default 6000",
		binWidth: "FFT bin width Hz (default 1e6)",
		lna: "LNA gain 0-40 step 8 (default 16)",
		vga: "VGA gain 0-62 step 2 (default 20)"
	},
	commands: {
		configure: "{startMhz, stopMhz, binWidth, lna, vga} restarts the sweep",
		transmit: "{blob (IQ blob) | path (file on the server), freqHz, rate (default 2e6), gain (0-47 dB, default 20), seconds (0 = until transmit_stop), format cf32|cs8 (default cf32)} TX: streams the IQ through hackrf_transfer -R; gated by the shared TX policy (band / gain cap / approval / auto-stop)",
		transmit_stop: "stop the running transmit"
	},
	create: create
};
