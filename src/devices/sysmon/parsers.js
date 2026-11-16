// Pure parsers for /proc, hwmon, amdgpu sysfs and nvidia-smi output.

const NVIDIA_FIELDS = ["index", "name", "utilization.gpu", "memory.used", "memory.total", "temperature.gpu", "power.draw"];

/**
 * /proc/stat cpu lines -> {total: {idle, total}, cpus: [{idle, total}]}.
 * idle includes iowait; guest time is already counted in user/nice.
 */
const parseProcStat = (text) => {
	const out = { total: null, cpus: [] };
	text.split("\n").forEach((line) => {
		const m = /^cpu(\d*)\s+(.*)$/.exec(line);
		if (!m) {
			return;
		}
		const f = m[2].trim().split(/\s+/).map(Number);
		// user nice system idle iowait irq softirq steal guest guest_nice
		const total = f.slice(0, 8).reduce((acc, v) => acc + (v || 0), 0);
		const entry = { idle: (f[3] || 0) + (f[4] || 0), total: total };
		if (m[1] === "") {
			out.total = entry;
		} else {
			out.cpus[Number(m[1])] = entry;
		}
	});
	return out;
};

/**
 * Busy percentage between two /proc/stat snapshots.
 */
const cpuLoad = (prev, cur) => {
	const dTotal = cur.total - prev.total;
	const dIdle = cur.idle - prev.idle;
	if (dTotal <= 0) {
		return 0;
	}
	return Math.round(1000 * (dTotal - dIdle) / dTotal) / 10;
};

/**
 * /proc/meminfo -> {MemTotal: kB, MemAvailable: kB, ...}
 */
const parseMeminfo = (text) => {
	const out = {};
	text.split("\n").forEach((line) => {
		const m = /^([A-Za-z0-9_()]+):\s+(\d+)/.exec(line);
		if (m) {
			out[m[1]] = Number(m[2]);
		}
	});
	return out;
};

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Used memory the way free(1)/nvtop count it: total - available.
 */
const memoryUsage = (info) => {
	const total = info.MemTotal || 0;
	let available = info.MemAvailable;
	if (available === undefined) {
		// kernels before 3.14
		available = (info.MemFree || 0) + (info.Buffers || 0) + (info.Cached || 0);
	}
	const used = total - available;
	let swapPercent = null;
	if (info.SwapTotal) {
		swapPercent = round1(100 * (info.SwapTotal - (info.SwapFree || 0)) / info.SwapTotal);
	}
	return {
		totalMiB: round1(total / 1024),
		usedMiB: round1(used / 1024),
		percent: total ? round1(100 * used / total) : 0,
		swapPercent: swapPercent
	};
};

/**
 * One hwmon temperature: millidegrees + optional label -> {label, celsius}.
 */
const hwmonSensor = (n, milli, label) => {
	if (milli === null || milli === undefined || !Number.isFinite(milli)) {
		return null;
	}
	let name = "temp" + n;
	if (label && label.trim()) {
		name = label.trim();
	}
	return { label: name, celsius: milli / 1000 };
};

const symbol = (text) => {
	return String(text).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "x";
};

/**
 * hwmon chips -> {"temp_<chip>_<label>": °C}. Repeated chip names (two DIMM
 * sensors, two xhci controllers) get the hwmon number: temp_spd5118_7_temp1.
 * @param {Array<{hwmon: string, chip: string, sensors: Array<{label: string, celsius: number}>}>} chips
 */
const tempChannels = (chips) => {
	const counts = {};
	chips.forEach((c) => {
		counts[c.chip] = (counts[c.chip] || 0) + 1;
	});
	const out = {};
	chips.forEach((c) => {
		let chip = symbol(c.chip);
		if (counts[c.chip] > 1) {
			chip += "_" + c.hwmon.replace(/^hwmon/, "");
		}
		c.sensors.forEach((s) => {
			out["temp_" + chip + "_" + symbol(s.label)] = s.celsius;
		});
	});
	return out;
};

/**
 * Raw amdgpu sysfs readings -> GPU record.
 * @param {{card: string, busy: number, vramUsed: number, vramTotal: number, tempMilli: number, powerMicro: number}} raw
 */
const amdGpu = (raw) => {
	const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
	let memPercent = null;
	if (has(raw.vramUsed) && has(raw.vramTotal) && raw.vramTotal > 0) {
		memPercent = round1(100 * raw.vramUsed / raw.vramTotal);
	}
	return {
		vendor: "amd",
		id: raw.card,
		name: "amdgpu " + raw.card,
		load: raw.busy,
		memUsedMiB: has(raw.vramUsed) ? round1(raw.vramUsed / 1048576) : null,
		memTotalMiB: has(raw.vramTotal) ? round1(raw.vramTotal / 1048576) : null,
		memPercent: memPercent,
		temp: has(raw.tempMilli) ? raw.tempMilli / 1000 : null,
		power: has(raw.powerMicro) ? round1(raw.powerMicro / 1e6) : null
	};
};

const nvNumber = (text) => {
	const n = Number(String(text).trim());
	if (String(text).trim() === "" || !Number.isFinite(n)) {
		// "[N/A]", "[Not Supported]"
		return null;
	}
	return n;
};

/**
 * `nvidia-smi --query-gpu=<NVIDIA_FIELDS> --format=csv,noheader,nounits`
 */
const parseNvidiaSmi = (text) => {
	return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
		const f = line.split(",").map((s) => s.trim());
		const used = nvNumber(f[3]);
		const total = nvNumber(f[4]);
		let memPercent = null;
		if (used !== null && total) {
			memPercent = round1(100 * used / total);
		}
		return {
			vendor: "nvidia",
			id: f[0],
			name: f[1],
			load: nvNumber(f[2]),
			memUsedMiB: used,
			memTotalMiB: total,
			memPercent: memPercent,
			temp: nvNumber(f[5]),
			power: nvNumber(f[6])
		};
	}).filter((g) => g.name !== undefined);
};

module.exports = {
	NVIDIA_FIELDS: NVIDIA_FIELDS,
	parseProcStat: parseProcStat,
	cpuLoad: cpuLoad,
	parseMeminfo: parseMeminfo,
	memoryUsage: memoryUsage,
	hwmonSensor: hwmonSensor,
	tempChannels: tempChannels,
	amdGpu: amdGpu,
	parseNvidiaSmi: parseNvidiaSmi
};
