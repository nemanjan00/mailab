// HackRF One wideband spectrum via hackrf_sweep -> trace "spectrum".
// hackrf_sweep lines: date, time, hz_low, hz_high, bin_width, samples, dB...

const spawn = require("child_process").spawn;
const readline = require("readline");

const DEFAULTS = { startMhz: 1, stopMhz: 6000, binWidth: 1000000, lna: 16, vga: 20 };

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	let proc = null;
	let bins = [];
	let lastLow = -1;

	const flush = () => {
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
		bins = [];
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
		// a new sweep starts when the band wraps back around
		if (low < lastLow) {
			flush();
		}
		lastLow = low;
		cells.slice(6).forEach((cell, i) => {
			bins.push([low + (i + 0.5) * width, Number(cell)]);
		});
	};

	const launch = () => {
		const args = [
			"-f", settings.startMhz + ":" + settings.stopMhz,
			"-w", String(settings.binWidth),
			"-l", String(settings.lna),
			"-g", String(settings.vga)
		];
		io.log("hackrf_sweep " + args.join(" "), "tx");
		bins = [];
		lastLow = -1;
		proc = spawn("hackrf_sweep", args);
		readline.createInterface({ input: proc.stdout }).on("line", onLine);
		readline.createInterface({ input: proc.stderr }).on("line", (line) => {
			io.log(line, "stderr");
		});
		proc.on("exit", (code) => {
			io.status("stopped", "hackrf_sweep exited " + code);
		});
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

	return {
		start: () => {
			launch();
			return Promise.resolve();
		},

		stop: kill,

		command: (name, args) => {
			if (name === "configure") {
				Object.assign(settings, args);
				return kill().then(() => {
					launch();
					return settings;
				});
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "hackrf",
	description: "HackRF One wideband sweep (hackrf_sweep): trace \"spectrum\", peak_freq/peak_db",
	options: {
		startMhz: "default 1",
		stopMhz: "default 6000",
		binWidth: "FFT bin width Hz (default 1e6)",
		lna: "LNA gain 0-40 step 8 (default 16)",
		vga: "VGA gain 0-62 step 2 (default 20)"
	},
	commands: {
		configure: "{startMhz, stopMhz, binWidth, lna, vga} restarts the sweep"
	},
	create: create
};
