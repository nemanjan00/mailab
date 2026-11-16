const fs = require("fs");
const os = require("os");
const path = require("path");
const rtlPower = require("..");
const csv = require("../csv");

// rtl_power -f 88M:92M:1M -i 1 - (format per rtl_power.c; 2 hops per sweep)
const FIXTURE = [
	"2026-11-16, 22:10:01, 88000000, 90000000, 1000000.00, 4096, -40.5, -38.25",
	"2026-11-16, 22:10:01, 90000000, 92000000, 1000000.00, 4096, -20.0, nan",
	"2026-11-16, 22:10:02, 88000000, 90000000, 1000000.00, 4096, -41.0, -39.0",
	"2026-11-16, 22:10:02, 90000000, 92000000, 1000000.00, 4096, -22.0, -30.5"
];

describe("rtl_power CSV", () => {
	test("parses a hop line, nan bins become null", () => {
		expect(csv.parseLine(FIXTURE[1])).toEqual({
			key: "2026-11-16 22:10:01", low: 90e6, high: 92e6, step: 1e6, samples: 4096, db: [-20, null]
		});
		expect(csv.parseLine("garbage")).toBeNull();
		expect(csv.parseLine("Found 1 device(s):")).toBeNull();
	});

	test("assembles hops into sweeps (stop reached, timestamp change)", () => {
		const sweeps = [];
		const asm = csv.sweepAssembler({ stop: 92e6, bin: 1e6 }, (s) => sweeps.push(s));
		const feed = csv.lineSplitter(asm.push);
		const text = FIXTURE.join("\n") + "\n";
		feed(Buffer.from(text.slice(0, 50)));
		feed(Buffer.from(text.slice(50)));
		expect(sweeps.length).toBe(2);
		expect(sweeps[0]).toEqual({ t: "2026-11-16 22:10:01", x: [88e6, 89e6, 90e6], y: [-40.5, -38.25, -20] });
		expect(sweeps[1].x).toEqual([88e6, 89e6, 90e6, 91e6]);
	});

	test("without a stop, a new timestamp ends the sweep", () => {
		const sweeps = [];
		const asm = csv.sweepAssembler(null, (s) => sweeps.push(s));
		FIXTURE.forEach(asm.push);
		expect(sweeps.length).toBe(1);
		asm.flush();
		expect(sweeps.length).toBe(2);
	});
});

describe("rtl_power arguments", () => {
	test("rtl_power and soapy_power command lines", () => {
		expect(rtlPower._buildArgs({ tool: "rtl_power", start: "88M", stop: "108M", bin: "10k", interval: 2, gain: 30 }).args)
			.toEqual(["-f", "88000000:108000000:10000", "-i", "2", "-g", "30", "-"]);
		expect(rtlPower._buildArgs({ tool: "soapy_power", start: 433e6, stop: "435M", bin: "1k", interval: 1, device: "driver=rtlsdr" }).args)
			.toEqual(["-f", "433000000:435000000", "-B", "1000", "-t", "1", "-c", "-F", "rtl_power", "-d", "driver=rtlsdr"]);
	});

	test("rejects bad input", () => {
		expect(() => rtlPower._buildArgs({ tool: "rtl_power", start: "88M; rm -rf /", stop: "108M", bin: "10k", interval: 1 })).toThrow(/frequency/);
		expect(() => rtlPower._buildArgs({ tool: "rtl_power", start: "108M", stop: "88M", bin: "10k", interval: 1 })).toThrow(/above/);
		expect(() => rtlPower._buildArgs({ tool: "sh", start: "88M", stop: "108M", bin: "10k", interval: 1 })).toThrow(/tool/);
		expect(() => rtlPower._buildArgs({ tool: "soapy_power", start: "88M", stop: "108M", bin: "10k", interval: 1, device: "-x" })).toThrow(/device/);
	});
});

describe("rtl_power driver with a fake tool", () => {
	test("publishes the spectrum trace and peak", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtlpower-"));
		const fake = path.join(dir, "rtl_power");
		fs.writeFileSync(fake, "#!/bin/sh\ncat <<'EOF'\n" + FIXTURE.slice(0, 2).join("\n") + "\nEOF\nexec sleep 5\n", { mode: 0o755 });
		const traces = {};
		const samples = {};
		const io = {
			trace: (name, data) => {
				traces[name] = data;
			},
			sample: (name, v) => {
				samples[name] = v;
			},
			log: () => {},
			status: () => {},
			setOptions: () => {}
		};
		const dev = rtlPower.create({ path: fake, start: "88M", stop: "92M", bin: "1M", offset: -10 }, io);
		return dev.start()
			.then(() => new Promise((resolve) => setTimeout(resolve, 300)))
			.then(() => {
				expect(traces.spectrum).toMatchObject({ xUnit: "Hz", yUnit: "dBm", mode: "line", x: [88e6, 89e6, 90e6] });
				expect(traces.spectrum.series[0].y).toEqual([-50.5, -48.25, -30]);
				expect(samples.peak_freq).toBe(90e6);
				expect(samples.peak_dbm).toBe(-30);
				return dev.stop();
			})
			.then(() => {
				fs.rmSync(dir, { recursive: true, force: true });
			});
	});
});
