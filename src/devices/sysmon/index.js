// System monitor (nvtop-like): CPU load, memory, hwmon temperatures, AMD GPUs
// (amdgpu sysfs) and NVIDIA GPUs (nvidia-smi). Channels: <id>_cpu, <id>_mem,
// <id>_gpu0_load, <id>_gpu0_temp, <id>_temp_k10temp_tctl, ...
// GPUs are numbered AMD first (by DRM card), then NVIDIA (by nvidia-smi index).

const fs = require("fs");
const path = require("path");
const execFile = require("child_process").execFile;
const parseNumber = require("../../utils/args").parseNumber;
const parseSwitch = require("../../utils/args").parseSwitch;
const parsers = require("./parsers");

const DEFAULTS = { intervalMs: 1000, root: "/", nvidia: true, temps: true, perCore: false };
const MIN_INTERVAL_MS = 100;
const NVIDIA_SMI = "nvidia-smi";
const NVIDIA_TIMEOUT_MS = 5000;

const readText = (file) => {
	return fs.promises.readFile(file, "utf8").catch(() => {
		return null;
	});
};

const readNumber = (file) => {
	return readText(file).then((text) => {
		if (text === null) {
			return null;
		}
		const n = Number(text.trim());
		if (Number.isFinite(n)) {
			return n;
		}
		return null;
	});
};

const listDir = (dir) => {
	return fs.promises.readdir(dir).catch(() => {
		return [];
	});
};

/**
 * Read every hwmon chip's temperatures.
 * @returns {Promise<Array<{hwmon: string, chip: string, sensors: Array<{label: string, celsius: number}>}>>}
 */
const readHwmon = (root) => {
	const base = path.join(root, "sys/class/hwmon");
	return listDir(base).then((entries) => {
		const dirs = entries.filter((e) => /^hwmon\d+$/.test(e)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
		return Promise.all(dirs.map((dir) => {
			const full = path.join(base, dir);
			return Promise.all([readText(path.join(full, "name")), listDir(full)]).then((res) => {
				const inputs = res[1].filter((f) => /^temp\d+_input$/.test(f));
				return Promise.all(inputs.map((input) => {
					const n = input.slice(4, -6);
					return Promise.all([readNumber(path.join(full, input)), readText(path.join(full, "temp" + n + "_label"))]).then((r) => {
						return parsers.hwmonSensor(n, r[0], r[1]);
					});
				})).then((sensors) => {
					return { hwmon: dir, chip: (res[0] || dir).trim(), sensors: sensors.filter(Boolean) };
				});
			});
		}));
	});
};

/**
 * AMD GPUs: DRM cards whose device exposes gpu_busy_percent (amdgpu).
 */
const readAmdGpus = (root) => {
	const base = path.join(root, "sys/class/drm");
	return listDir(base).then((entries) => {
		const cards = entries.filter((e) => /^card\d+$/.test(e)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
		return Promise.all(cards.map((card) => {
			const dev = path.join(base, card, "device");
			return readNumber(path.join(dev, "gpu_busy_percent")).then((busy) => {
				if (busy === null) {
					return null;
				}
				return Promise.all([
					readNumber(path.join(dev, "mem_info_vram_used")),
					readNumber(path.join(dev, "mem_info_vram_total")),
					listDir(path.join(dev, "hwmon"))
				]).then((r) => {
					const hw = r[2].find((e) => /^hwmon\d+$/.test(e));
					const hwFiles = hw ? path.join(dev, "hwmon", hw) : null;
					const extra = hwFiles ? Promise.all([
						readNumber(path.join(hwFiles, "temp1_input")),
						readNumber(path.join(hwFiles, "power1_average")),
						readNumber(path.join(hwFiles, "power1_input"))
					]) : Promise.resolve([null, null, null]);
					return extra.then((e) => {
						return parsers.amdGpu({
							card: card,
							busy: busy,
							vramUsed: r[0],
							vramTotal: r[1],
							tempMilli: e[0],
							powerMicro: e[1] !== null ? e[1] : e[2]
						});
					});
				});
			});
		})).then((gpus) => gpus.filter(Boolean));
	});
};

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	let timer = null;
	let prevStat = null;
	let nvidiaOk = settings.nvidia !== false;
	let nvidiaBusy = false;
	let lastNvidia = [];
	let latest = {};
	let ticking = false;

	const readNvidia = () => {
		if (!nvidiaOk || nvidiaBusy) {
			return Promise.resolve(lastNvidia);
		}
		nvidiaBusy = true;
		return new Promise((resolve) => {
			execFile(NVIDIA_SMI, ["--query-gpu=" + parsers.NVIDIA_FIELDS.join(","), "--format=csv,noheader,nounits"], { timeout: NVIDIA_TIMEOUT_MS }, (err, stdout) => {
				nvidiaBusy = false;
				if (err) {
					if (err.code === "ENOENT") {
						nvidiaOk = false;
					} else {
						io.log("nvidia-smi: " + err.message.trim(), "warn");
					}
					resolve([]);
					return;
				}
				lastNvidia = parsers.parseNvidiaSmi(stdout);
				resolve(lastNvidia);
			});
		});
	};

	const emitGpu = (n, gpu) => {
		const prefix = "gpu" + n + "_";
		if (gpu.load !== null) {
			io.sample(prefix + "load", gpu.load, { unit: "%" });
		}
		if (gpu.memUsedMiB !== null) {
			io.sample(prefix + "mem_used", gpu.memUsedMiB, { unit: "MiB" });
		}
		if (gpu.memPercent !== null) {
			io.sample(prefix + "mem", gpu.memPercent, { unit: "%" });
		}
		if (gpu.temp !== null) {
			io.sample(prefix + "temp", gpu.temp, { unit: "°C" });
		}
		if (gpu.power !== null) {
			io.sample(prefix + "power", gpu.power, { unit: "W" });
		}
	};

	const tick = () => {
		const root = settings.root;
		return Promise.all([
			readText(path.join(root, "proc/stat")),
			readText(path.join(root, "proc/meminfo")),
			settings.temps !== false ? readHwmon(root) : Promise.resolve([]),
			readAmdGpus(root),
			readNvidia()
		]).then((r) => {
			const snap = { t: Date.now() };
			if (r[0] !== null) {
				const stat = parsers.parseProcStat(r[0]);
				if (prevStat) {
					snap.cpu = parsers.cpuLoad(prevStat.total, stat.total);
					io.sample("cpu", snap.cpu, { unit: "%" });
					if (settings.perCore) {
						stat.cpus.forEach((c, i) => {
							if (prevStat.cpus[i]) {
								io.sample("cpu" + i, parsers.cpuLoad(prevStat.cpus[i], c), { unit: "%" });
							}
						});
					}
				}
				prevStat = stat;
			}
			if (r[1] !== null) {
				const mem = parsers.memoryUsage(parsers.parseMeminfo(r[1]));
				snap.mem = mem;
				io.sample("mem", mem.percent, { unit: "%" });
				io.sample("mem_used", mem.usedMiB, { unit: "MiB" });
				if (mem.swapPercent !== null) {
					io.sample("swap", mem.swapPercent, { unit: "%" });
				}
			}
			const temps = parsers.tempChannels(r[2]);
			snap.temps = temps;
			Object.keys(temps).forEach((name) => {
				io.sample(name, temps[name], { unit: "°C" });
			});
			const gpus = r[3].concat(r[4]);
			snap.gpus = gpus;
			gpus.forEach((gpu, n) => {
				emitGpu(n, gpu);
			});
			latest = snap;
			io.value("snapshot", snap);
			return snap;
		});
	};

	const loop = () => {
		if (ticking) {
			return;
		}
		ticking = true;
		tick().catch((err) => {
			io.log("sysmon: " + err.message, "warn");
		}).then(() => {
			ticking = false;
		});
	};

	const configure = (a) => {
		if (a.intervalMs !== undefined) {
			settings.intervalMs = parseNumber(a.intervalMs, "intervalMs", { min: MIN_INTERVAL_MS, unit: "ms" });
		}
		if (a.perCore !== undefined) {
			settings.perCore = parseSwitch(a.perCore, "perCore");
		}
		io.setOptions({ intervalMs: settings.intervalMs, perCore: settings.perCore });
		schedule();
		return { intervalMs: settings.intervalMs, perCore: settings.perCore };
	};

	const schedule = () => {
		clearInterval(timer);
		timer = setInterval(loop, settings.intervalMs);
	};

	return {
		start: () => {
			settings.intervalMs = parseNumber(settings.intervalMs, "intervalMs", { min: MIN_INTERVAL_MS, unit: "ms" });
			return tick().then((snap) => {
				io.log("monitoring: " + (snap.gpus || []).length + " GPU(s), " + Object.keys(snap.temps || {}).length + " temperature sensor(s), every " + settings.intervalMs + " ms");
				schedule();
			});
		},

		stop: () => {
			clearInterval(timer);
			timer = null;
			return Promise.resolve();
		},

		command: (name, args) => {
			const a = args || {};
			if (name === "snapshot") {
				return Promise.resolve(latest);
			}
			if (name === "configure") {
				return Promise.resolve().then(() => configure(a));
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "sysmon",
	description: "System monitor (nvtop-like): CPU load, memory, hwmon temperatures, AMD (sysfs) and NVIDIA (nvidia-smi) GPU load/VRAM/temp/power",
	options: {
		intervalMs: "sampling interval (default 1000, min 100)",
		perCore: "also emit <id>_cpu0.. per core (default false)",
		temps: "hwmon temperatures as <id>_temp_<chip>_<label> (default true)",
		nvidia: "query nvidia-smi when present (default true)",
		root: "filesystem root for /proc and /sys (default \"/\"; for tests or a mounted target)"
	},
	commands: {
		snapshot: "latest readings (also value <id>_snapshot)",
		configure: "{intervalMs, perCore}"
	},
	create: create
};
