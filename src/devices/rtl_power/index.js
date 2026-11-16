// Wideband power sweeps with rtl_power (RTL-SDR) or soapy_power (any
// SoapySDR device) as a child process. Their CSV ("date, time, Hz low,
// Hz high, Hz step, samples, dB, dB, ...") is assembled into one sweep and
// published as trace <id>_spectrum, plus <id>_peak_freq / <id>_peak_dbm.
// Levels are uncalibrated dB(FS-ish) unless `offset` is set; the trace label
// says dBm to match the other spectrum sources.
// TODO: verify on hardware (no RTL-SDR attached when this was written;
// soapy_power arguments from its README, not run).

const spawn = require("child_process").spawn;
const parseNumber = require("../../utils/args").parseNumber;
const csv = require("./csv");

const DEFAULTS = { tool: "rtl_power", start: "88M", stop: "108M", bin: "10k", interval: 1, gain: null, offset: 0, mode: "line" };
const MODES = ["line", "step", "scatter"];
const MAX_STDERR_LINES = 50;
const KILL_TIMEOUT_MS = 3000;

/**
 * "88M", "2.4G", "100k", 88000000 -> Hz.
 */
const parseFreq = (value, name) => {
	if (typeof value === "number") {
		return parseNumber(value, name, { min: 0 });
	}
	const m = /^\s*(\d+(?:\.\d+)?)\s*([kMG]?)\s*(?:Hz)?\s*$/.exec(String(value));
	if (!m) {
		throw new Error(name + " must be a frequency like 88M, 433.92M or 100k, got " + JSON.stringify(value));
	}
	const mult = { "": 1, k: 1e3, M: 1e6, G: 1e9 }[m[2]];
	return Number(m[1]) * mult;
};

/**
 * Validated tool arguments.
 * @param {{tool: string, start: *, stop: *, bin: *, interval: *, gain: *, device: *, ppm: *, crop: *}} s
 */
const buildArgs = (s) => {
	const start = parseFreq(s.start, "start");
	const stop = parseFreq(s.stop, "stop");
	const bin = parseFreq(s.bin, "bin");
	if (stop <= start) {
		throw new Error("stop must be above start");
	}
	if (bin <= 0 || bin > stop - start) {
		throw new Error("bin must be > 0 and below the span");
	}
	const interval = parseNumber(s.interval, "interval", { min: 0.1, max: 3600, unit: "s" });
	const range = Math.round(start) + ":" + Math.round(stop);
	let args;
	if (s.tool === "soapy_power") {
		args = ["-f", range, "-B", String(Math.round(bin)), "-t", String(interval), "-c", "-F", "rtl_power"];
		if (s.device !== undefined && s.device !== null && s.device !== "") {
			// SoapySDR device string, e.g. "driver=hackrf"
			if (!/^[A-Za-z0-9_=,.:]+$/.test(String(s.device))) {
				throw new Error("device must be a SoapySDR device string like driver=rtlsdr");
			}
			args.push("-d", String(s.device));
		}
	} else if (s.tool === "rtl_power") {
		args = ["-f", range + ":" + Math.round(bin), "-i", String(interval)];
		if (s.device !== undefined && s.device !== null && s.device !== "") {
			args.push("-d", String(parseNumber(s.device, "device", { min: 0, max: 255 })));
		}
		if (s.ppm) {
			args.push("-p", String(Math.round(parseNumber(s.ppm, "ppm", { min: -1000, max: 1000 }))));
		}
		if (s.crop !== undefined && s.crop !== null) {
			args.push("-c", String(parseNumber(s.crop, "crop", { min: 0, max: 1 })));
		}
	} else {
		throw new Error("tool must be rtl_power or soapy_power");
	}
	if (s.gain !== undefined && s.gain !== null && s.gain !== "") {
		args.push("-g", String(parseNumber(s.gain, "gain", { min: 0, max: 100, unit: "dB" })));
	}
	if (s.tool === "rtl_power") {
		args.push("-");
	}
	return { args: args, start: start, stop: stop, bin: bin };
};

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	let proc = null;
	let stopping = false;
	let sweeps = 0;
	let last = null;

	const publish = (sweep) => {
		const y = sweep.y.map((v) => v + (Number(settings.offset) || 0));
		sweeps++;
		io.trace("spectrum", { x: sweep.x, xUnit: "Hz", yUnit: "dBm", mode: settings.mode, series: [{ label: "dBm", y: y }] });
		if (y.length) {
			const peak = y.indexOf(Math.max.apply(null, y));
			io.sample("peak_freq", sweep.x[peak], { unit: "Hz" });
			io.sample("peak_dbm", y[peak], { unit: "dBm" });
			last = { t: sweep.t, points: y.length, peak: { hz: sweep.x[peak], dbm: y[peak] } };
		}
	};

	const launch = () => {
		const built = buildArgs(settings);
		if (MODES.indexOf(settings.mode) === -1) {
			throw new Error("mode must be one of " + MODES.join(", "));
		}
		const binPath = settings.path || settings.tool;
		io.log(binPath + " " + built.args.join(" "), "tx");
		const assembler = csv.sweepAssembler({ stop: built.stop, bin: built.bin }, publish);
		const lines = csv.lineSplitter(assembler.push);
		let stderrLines = 0;
		stopping = false;
		proc = spawn(binPath, built.args);
		proc.stdout.on("data", lines);
		proc.stderr.on("data", (data) => {
			if (stderrLines < MAX_STDERR_LINES) {
				stderrLines++;
				io.log(data.toString().trim(), "stderr");
			}
		});
		proc.on("error", (err) => {
			io.status("error", binPath + ": " + err.message);
		});
		proc.on("exit", (code) => {
			assembler.flush();
			proc = null;
			if (!stopping) {
				io.status("error", binPath + " exited " + code);
			}
		});
	};

	const kill = () => {
		if (!proc) {
			return Promise.resolve();
		}
		const old = proc;
		stopping = true;
		return new Promise((resolve) => {
			// SIGINT lets rtl_power release the dongle cleanly; SIGKILL if it hangs
			const force = setTimeout(() => {
				old.kill("SIGKILL");
			}, KILL_TIMEOUT_MS);
			old.once("exit", () => {
				clearTimeout(force);
				resolve();
			});
			old.kill("SIGINT");
		});
	};

	return {
		start: () => {
			return Promise.resolve().then(launch);
		},

		stop: () => {
			return kill();
		},

		command: (name, args) => {
			const a = args || {};
			if (name === "configure") {
				const next = Object.assign({}, settings, a);
				// validate before touching the running sweep
				buildArgs(next);
				return kill().then(() => {
					Object.assign(settings, a);
					io.setOptions(a);
					launch();
					return settings;
				});
			}
			if (name === "status") {
				return Promise.resolve({ running: Boolean(proc), sweeps: sweeps, last: last, settings: settings });
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "rtl_power",
	description: "Wideband power sweep via rtl_power (RTL-SDR) or soapy_power: trace <id>_spectrum (Hz vs dB), <id>_peak_freq, <id>_peak_dbm",
	options: {
		tool: "rtl_power (default) or soapy_power",
		path: "tool binary path (default: tool name on PATH)",
		start: "start frequency, e.g. 88M (Hz or k/M/G suffix)",
		stop: "stop frequency, e.g. 108M",
		bin: "bin size, e.g. 10k",
		interval: "integration interval per sweep in seconds (default 1)",
		gain: "tuner gain dB (default auto)",
		device: "rtl_power: device index; soapy_power: SoapySDR device string (driver=rtlsdr)",
		ppm: "rtl_power: frequency correction",
		crop: "rtl_power: crop fraction of each hop 0..1",
		offset: "dB added to every bin (calibration; levels are uncalibrated otherwise)",
		mode: "trace mode line|step|scatter (default line)"
	},
	commands: {
		configure: "{start, stop, bin, interval, gain, device, offset, mode, tool} restarts the sweep",
		status: "running, sweep count, last peak"
	},
	create: create,
	_buildArgs: buildArgs,
	_parseFreq: parseFreq
};
