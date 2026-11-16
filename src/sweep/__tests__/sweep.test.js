const fs = require("fs");
const os = require("os");
const path = require("path");
const labModule = require("../../lab");
const sweep = require("..");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// a flat level: offset + noise of +-1e-9 (sim's "noise" shape), settable via `set`
const LEVELS = [
	{ name: "a", shape: "noise", amp: 1e-9, offset: 0, unit: "V" },
	{ name: "b", shape: "noise", amp: 1e-9, offset: 0, unit: "V" }
];
const setA = { device: "sim", command: "set", args: { signal: "a", key: "offset", value: "$value" } };
const setB = { device: "sim", command: "set", args: { signal: "b", key: "offset", value: "$value" } };

describe("sweep values", () => {
	test("linear, log and list axes", () => {
		expect(sweep.values({ from: 0, to: 1, steps: 5 })).toEqual([0, 0.25, 0.5, 0.75, 1]);
		const log = sweep.values({ from: 1, to: 1000, steps: 4, scale: "log" });
		log.forEach((v, i) => expect(v).toBeCloseTo([1, 10, 100, 1000][i], 6));
		expect(sweep.values({ values: [3, 1, 2] })).toEqual([3, 1, 2]);
		expect(() => sweep.values({ from: 0, to: 1, steps: 0 })).toThrow(/steps/);
		expect(() => sweep.values({ from: 0, to: 1, steps: 3, scale: "log" })).toThrow(/log/);
	});
});

describe("sweep & optimize on the sim driver", () => {
	let lab;

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-sweep-")), channelCapacity: 10000, watchUsb: false });
		return lab.restore().then(() => lab.addDevice("sim", "sim", { rateHz: 200, signals: LEVELS }));
	});

	afterAll(() => lab.shutdown());

	test("1-D sweep tabulates the measured level, stores a value and a trace", () => {
		// no range: refused before touching the device
		expect(() => sweep.sweep(lab, { x: setA, reads: ["sim_a"] }, lab.safety.gate("test"))).toThrow(/axis needs/);
		return sweep.sweep(lab, { name: "s1", x: Object.assign({ from: 0, to: 2, steps: 3 }, setA), reads: ["sim_a"], settleMs: 20, windowMs: 40 }, lab.safety.gate("test"))
			.then((table) => {
				expect(table.columns).toEqual(["x", "sim_a"]);
				expect(table.rows.length).toBe(3);
				table.rows.forEach((row) => expect(row[1]).toBeCloseTo(row[0], 6));
				expect(lab.getValue("s1").value.rows.length).toBe(3);
				const tr = lab.getTrace("s1");
				expect(tr.x).toEqual([0, 1, 2]);
				expect(tr.series[0].label).toBe("sim_a");
			});
	});

	test("2-D sweep over a grid, latest mode", () => {
		return sweep.sweep(lab, {
			name: "grid",
			x: Object.assign({ values: [1, 2] }, setA),
			y: Object.assign({ values: [10, 20] }, setB),
			reads: [{ channel: "sim_a", mode: "latest" }, "sim_b"],
			settleMs: 15,
			windowMs: 40
		}, lab.safety.gate("test")).then((table) => {
			expect(table.columns).toEqual(["x", "y", "sim_a", "sim_b"]);
			expect(table.rows.map((r) => [r[0], r[1]])).toEqual([[1, 10], [2, 10], [1, 20], [2, 20]]);
			table.rows.forEach((r) => {
				expect(r[2]).toBeCloseTo(r[0], 6);
				expect(r[3]).toBeCloseTo(r[1], 6);
			});
			expect(lab.getTrace("grid").series.map((s) => s.label)).toEqual(["sim_a @ y=10", "sim_b @ y=10", "sim_a @ y=20", "sim_b @ y=20"]);
		});
	});

	test("stopWhen ends the sweep early, after runs at the end", () => {
		return sweep.sweep(lab, {
			name: "brownout",
			x: Object.assign({ from: 5, to: 0, steps: 6 }, setA),
			reads: ["sim_a"],
			settleMs: 10,
			windowMs: 30,
			stopWhen: "sim_a < 2.5",
			after: { device: "sim", command: "set", args: { signal: "a", key: "offset", value: 7 } }
		}, lab.safety.gate("test")).then((table) => {
			expect(table.rows.map((r) => r[0])).toEqual([5, 4, 3, 2]);
			expect(table.stopped).toMatchObject({ x: 2 });
			return wait(30);
		}).then(() => {
			expect(lab.channels.latest("sim_a").v).toBeCloseTo(7, 6);
		});
	});

	test("golden-section finds the maximum of an expression", () => {
		return sweep.optimize(lab, {
			name: "peak",
			param: Object.assign({ min: 0, max: 5 }, setA),
			objective: "-(sim_a - 2.7)^2",
			goal: "max",
			maxIterations: 25,
			tolerance: 0.01,
			settleMs: 5,
			windowMs: 20
		}, lab.safety.gate("test")).then((r) => {
			expect(r.best.x).toBeCloseTo(2.7, 1);
			expect(r.evaluations.length).toBeLessThanOrEqual(25);
			expect(lab.getTrace("peak").mode).toBe("scatter");
		});
	});

	test("hill-climb finds the minimum", () => {
		return sweep.optimize(lab, {
			name: "valley",
			param: Object.assign({ min: -4, max: 4 }, setA),
			objective: "abs(sim_a + 1.5)",
			method: "hill",
			start: 3,
			step: 1,
			tolerance: 0.1,
			maxIterations: 40,
			settleMs: 5,
			windowMs: 20
		}, lab.safety.gate("test")).then((r) => {
			expect(r.best.x).toBeCloseTo(-1.5, 1);
			expect(r.converged).toBe(true);
		});
	});

	test("one approval covers the plan; a denial stops before any command", () => {
		lab.safety.setPolicy([{ command: "set", when: "value > 3", reason: "level above 3" }]);
		const commanded = [];
		const original = lab.commandDevice;
		lab.commandDevice = (id, name, args) => {
			commanded.push(args.value);
			return original(id, name, args);
		};
		const run = (approve) => {
			const running = sweep.sweep(lab, { name: "gated", x: Object.assign({ values: [2, 4, 5] }, setA), reads: ["sim_a"], settleMs: 5, windowMs: 20 }, lab.safety.gate("tester"));
			return wait(20).then(() => {
				const pending = lab.safety.listPending();
				expect(pending.length).toBe(1);
				expect(pending[0].reason).toMatch(/2 of 3 steps: level above 3/);
				lab.safety.decide(pending[0].id, approve ? "approved" : "denied", "me");
				return running;
			});
		};
		return run(false)
			.then(() => {
				throw new Error("should have been denied");
			}, (err) => {
				expect(err.message).toMatch(/not approved/);
				expect(commanded).toEqual([]);
				return run(true);
			})
			.then((table) => {
				expect(commanded).toEqual([2, 4, 5]);
				expect(table.rows.length).toBe(3);
				expect(lab.safety.listPending().length).toBe(0);
			})
			.finally(() => {
				lab.commandDevice = original;
				lab.safety.setPolicy(lab.safety.DEFAULT_POLICY);
			});
	});
});
