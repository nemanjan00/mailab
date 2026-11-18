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
	let proc = null;
	let bins = [];
	let passes = 0;
	const seenLows = new Set();

	const flush = (keep) => {
		if (!bins.length) {
			return;
		}
		passes++;
		io.sample("sweeps", passes, { unit: "pass" });
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
		// hackrf_sweep rotates the first band of each pass, so lows are not
		// monotonic — a pass boundary is a band we already saw this pass
		if (seenLows.has(low)) {
			flush(false);
			seenLows.clear();
		}
		seenLows.add(low);
		cells.slice(6).forEach((cell, i) => {
			bins.push([low + (i + 0.5) * width, Number(cell)]);
		});
		// safety valve for very wide spans (a pass can take minutes): publish
		// mid-pass rather than never; normal spans wait for the wrap so every
		// row is a complete, stitched spectrum
		if (bins.length > 4000) {
			flush(false);
			seenLows.clear();
		}
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
			s.binWidth = Math.max(5e3, Math.min(5e6, Number(s.binWidth) || settings.binWidth));
		}
		["startMhz", "stopMhz", "lna", "vga"].forEach((key) => {
			if (s[key] !== undefined) {
				s[key] = Number(s[key]);
			}
		});
		return s;
	};
	const settings = Object.assign({}, DEFAULTS, normalize(options || {}));

	// the settings-model contract (settings pane): schema + set + a
	// published <id>_settings value
	const SCHEMA = [{ key: "sweep", title: "Sweep", fields: [
		{ key: "startMhz", label: "start", type: "number", unit: "MHz" },
		{ key: "stopMhz", label: "stop", type: "number", unit: "MHz" },
		{ key: "binWidthKhz", label: "bin width", type: "number", unit: "kHz" },
		{ key: "lna", label: "LNA gain", type: "enum", options: ["0", "8", "16", "24", "32", "40"] },
		{ key: "vga", label: "VGA gain", type: "number", unit: "dB" }
	] }];
	const model = () => {
		return { sweep: {
			startMhz: settings.startMhz,
			stopMhz: settings.stopMhz,
			binWidthKhz: settings.binWidth / 1e3,
			lna: String(settings.lna),
			vga: settings.vga
		} };
	};
	const publish = () => {
		io.value("settings", model());
	};

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
		seenLows.clear();
		proc = spawn("hackrf_sweep", args);
		const mine = proc;
		readline.createInterface({ input: proc.stdout }).on("line", onLine);
		readline.createInterface({ input: proc.stderr }).on("line", (line) => {
			// progress spam ("N total sweeps completed, R sweeps/second") would
			// fill the console pane — one summary per launch, real errors always
			if (/total sweeps completed/.test(line)) {
				return;
			}
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
		// one row per complete sweep pass (see the 4000-bin valve in onLine
		// for very wide spans); no timer flush — partial passes made the
		// spectrum appear to slide in frequency
	};

	const kill = () => {
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
	// the sweep and TX share one radio: TX pauses the sweep, and the sweep
	// resumes when the transmission ends (unless the device is stopping)
	let wantSweep = true;

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
			// hand the radio over: the sweep must release the device first
			return kill().then(() => {
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
					if (wantSweep && !proc) {
					// hand the radio back to the sweep
						launch();
					}
				});
				if (seconds > 0) {
					txTimer = setTimeout(() => {
						killTx("time cap " + seconds + " s").catch(() => {});
					}, seconds * 1000);
					txTimer.unref();
				}
				return { started: true, freqHz: freqHz, gain: gain, rate: rate, seconds: seconds, format: format };
			});
		});
	};

	return {
		start: () => {
			launch();
			publish();
			return Promise.resolve();
		},

		stop: () => {
			wantSweep = false;
			return killTx("device stop").then(() => {
				return kill();
			});
		},

		command: (name, args) => {
			if (name === "configure" || name === "set") {
				Object.assign(settings, normalize((name === "set" && args && args.sweep) ? args.sweep : args || {}));
				return kill().then(() => {
					launch();
					publish();
					return settings;
				});
			}
			if (name === "settings_schema") {
				return Promise.resolve(SCHEMA);
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
		binWidth: "FFT bin width Hz (default 1e6; aliases binWidthKhz/binWidthMhz; hackrf_sweep quantizes, ~5 kHz-5 MHz)",
		lna: "LNA gain 0-40 step 8 (default 16)",
		vga: "VGA gain 0-62 step 2 (default 20)"
	},
	commands: {
		configure: "{startMhz, stopMhz, binWidth, lna (0-40 dB, step 8), vga (0-62 dB, step 2)} restarts the sweep; sweeps channel counts passes — read it twice to know a fresh sweep landed",
		transmit: "{blob (IQ blob) | path (file on the server), freqHz, rate (default 2e6), gain (0-47 dB, default 20), seconds (0 = until transmit_stop), format cf32|cs8 (default cf32)} TX: streams the IQ through hackrf_transfer -R; gated by the shared TX policy (band / gain cap / approval / auto-stop)",
		transmit_stop: "stop the running transmit"
	},
	create: create
};
