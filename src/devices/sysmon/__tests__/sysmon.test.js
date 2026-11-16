const fs = require("fs");
const os = require("os");
const path = require("path");
const sysmon = require("..");
const parsers = require("../parsers");

const STAT_A = [
	"cpu  100 0 100 700 100 0 0 0 0 0",
	"cpu0 50 0 50 350 50 0 0 0 0 0",
	"cpu1 50 0 50 350 50 0 0 0 0 0",
	"intr 12345"
].join("\n");
const STAT_B = [
	"cpu  200 0 200 1300 100 0 0 0 0 0",
	"cpu0 150 0 50 650 50 0 0 0 0 0",
	"cpu1 50 0 150 650 50 0 0 0 0 0"
].join("\n");

const MEMINFO = [
	"MemTotal:       63385836 kB",
	"MemFree:         2757512 kB",
	"MemAvailable:   17162588 kB",
	"Buffers:         2208956 kB",
	"Cached:         10264932 kB",
	"SwapTotal:       8388604 kB",
	"SwapFree:        4194302 kB",
	"HugePages_Total:       0"
].join("\n");

// captured from a real RTX 5080 (driver with power.draw), plus an [N/A] row
const NVIDIA_SMI = "0, NVIDIA GeForce RTX 5080, 7, 3362, 16303, 38, 9.73\n1, Tesla K80, [N/A], 0, 11441, 31, [N/A]\n";

const write = (root, rel, text) => {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, text);
};

describe("sysmon parsers", () => {
	test("CPU load from /proc/stat deltas", () => {
		const a = parsers.parseProcStat(STAT_A);
		const b = parsers.parseProcStat(STAT_B);
		expect(a.cpus.length).toBe(2);
		// total: 1000 -> 1800, idle: 800 -> 1400 => busy 200/800
		expect(parsers.cpuLoad(a.total, b.total)).toBe(25);
		expect(parsers.cpuLoad(a.cpus[0], b.cpus[0])).toBe(25);
		expect(parsers.cpuLoad(a.total, a.total)).toBe(0);
	});

	test("memory: total - available, swap", () => {
		const mem = parsers.memoryUsage(parsers.parseMeminfo(MEMINFO));
		expect(mem.totalMiB).toBe(61900.2);
		expect(mem.usedMiB).toBe(45139.9);
		expect(mem.percent).toBe(72.9);
		expect(mem.swapPercent).toBe(50);
	});

	test("hwmon temperature channel names, duplicate chips get the hwmon number", () => {
		const temps = parsers.tempChannels([
			{ hwmon: "hwmon4", chip: "k10temp", sensors: [parsers.hwmonSensor("1", 45250, "Tctl\n"), parsers.hwmonSensor("3", 40000, "Tccd1")] },
			{ hwmon: "hwmon7", chip: "spd5118", sensors: [parsers.hwmonSensor("1", 38000, null)] },
			{ hwmon: "hwmon8", chip: "spd5118", sensors: [parsers.hwmonSensor("1", 39500, null)] },
			{ hwmon: "hwmon1", chip: "r8169_0_900:00", sensors: [parsers.hwmonSensor("1", null, null)].filter(Boolean) }
		]);
		expect(temps).toEqual({
			temp_k10temp_tctl: 45.25,
			temp_k10temp_tccd1: 40,
			temp_spd5118_7_temp1: 38,
			temp_spd5118_8_temp1: 39.5
		});
	});

	test("nvidia-smi CSV, [N/A] fields become null", () => {
		const gpus = parsers.parseNvidiaSmi(NVIDIA_SMI);
		expect(gpus.length).toBe(2);
		expect(gpus[0]).toMatchObject({ vendor: "nvidia", name: "NVIDIA GeForce RTX 5080", load: 7, memUsedMiB: 3362, memTotalMiB: 16303, memPercent: 20.6, temp: 38, power: 9.73 });
		expect(gpus[1]).toMatchObject({ load: null, power: null, memPercent: 0, temp: 31 });
	});

	test("amdgpu sysfs readings", () => {
		const gpu = parsers.amdGpu({ card: "card0", busy: 42, vramUsed: 1073741824, vramTotal: 8589934592, tempMilli: 51000, powerMicro: 35000000 });
		expect(gpu).toMatchObject({ vendor: "amd", load: 42, memUsedMiB: 1024, memTotalMiB: 8192, memPercent: 12.5, temp: 51, power: 35 });
	});
});

describe("sysmon driver on a fixture /proc + /sys tree", () => {
	let root = null;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "sysmon-"));
		write(root, "proc/stat", STAT_A);
		write(root, "proc/meminfo", MEMINFO);
		write(root, "sys/class/hwmon/hwmon0/name", "k10temp\n");
		write(root, "sys/class/hwmon/hwmon0/temp1_input", "45250\n");
		write(root, "sys/class/hwmon/hwmon0/temp1_label", "Tctl\n");
		write(root, "sys/class/drm/card0/device/gpu_busy_percent", "42\n");
		write(root, "sys/class/drm/card0/device/mem_info_vram_used", "1073741824\n");
		write(root, "sys/class/drm/card0/device/mem_info_vram_total", "8589934592\n");
		write(root, "sys/class/drm/card0/device/hwmon/hwmon3/temp1_input", "51000\n");
		write(root, "sys/class/drm/card0/device/hwmon/hwmon3/power1_average", "35000000\n");
		// connector entries and non-amdgpu cards are ignored
		write(root, "sys/class/drm/card0-DP-1/status", "connected\n");
		write(root, "sys/class/drm/card1/device/vendor", "0x10de\n");
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("emits cpu, memory, temperature and GPU channels", () => {
		const samples = {};
		const values = {};
		const cpu = [];
		const io = {
			id: "sysmon",
			sample: (name, v) => {
				samples[name] = v;
				if (name === "cpu") {
					cpu.push(v);
				}
			},
			value: (name, v) => {
				values[name] = v;
			},
			log: () => {},
			setOptions: () => {}
		};
		const dev = sysmon.create({ root: root, nvidia: false, intervalMs: 60000 }, io);
		return dev.start()
			.then(() => {
				expect(samples.cpu).toBeUndefined();
				expect(samples.mem).toBe(72.9);
				expect(samples.temp_k10temp_tctl).toBe(45.25);
				expect(samples.gpu0_load).toBe(42);
				expect(samples.gpu0_mem).toBe(12.5);
				expect(samples.gpu0_temp).toBe(51);
				expect(samples.gpu0_power).toBe(35);
				expect(samples.gpu1_load).toBeUndefined();
				write(root, "proc/stat", STAT_B);
				return dev.command("configure", { intervalMs: 100 });
			})
			.then(() => {
				return new Promise((resolve) => setTimeout(resolve, 250));
			})
			.then(() => {
				// first tick after the change sees A -> B, later ones B -> B
				expect(cpu[0]).toBe(25);
				expect(values.snapshot.gpus.length).toBe(1);
				return dev.stop();
			});
	});

	test("rejects too short intervals", () => {
		const dev = sysmon.create({ root: root, nvidia: false }, { log: () => {}, setOptions: () => {} });
		return expect(dev.command("configure", { intervalMs: 5 })).rejects.toThrow(/minimum/);
	});
});
