const timebase = require("../index");

const mark = (over) => Object.assign({ index: 0, t: 0, rate: 1e6 }, over);

describe("timebase", () => {
	test("origin is the host time of sample index 0", () => {
		expect(timebase.origin(mark({ index: 5000, t: 1.0, rate: 1e6 }))).toBeCloseTo(0.995, 12);
	});

	test("alignIndex maps a pulse seen at the same host instant", () => {
		// the same pulse, stamped at host t = 1.0 on both instruments
		const a = mark({ index: 1000, t: 1.0, rate: 1e6 });
		const b = mark({ index: 4000, t: 1.0, rate: 1e6 });
		expect(timebase.alignIndex(a, b, 1000)).toBe(4000);
		expect(timebase.offsetSeconds(a, b)).toBeCloseTo(0.003, 12);
	});

	test("alignIndex works across different rates", () => {
		const a = mark({ index: 1000, t: 1.0, rate: 1e6 });
		const b = mark({ index: 7000, t: 1.0, rate: 1e7 });
		expect(timebase.alignIndex(a, b, 1000)).toBe(7000);
		expect(timebase.alignIndex(b, a, 7000)).toBe(1000);
	});

	test("alignIndex maps a pulse b sees 3 ms later in real time", () => {
		// pulse reaches b 3 ms after a (e.g. propagation): at t = 1.003, and b's
		// grid puts it at sample 7000 of a 10 MHz stream (origin 1.0023)
		const a = mark({ index: 1000, t: 1.0, rate: 1e6 });
		const b = mark({ index: 7000, t: 1.003, rate: 1e7 });
		// b's sample 7000 happened at host 1.003; on a's grid that is sample 4000
		expect(timebase.alignIndex(b, a, 7000)).toBe(4000);
	});

	test("common-mode stamp error cancels in alignIndex", () => {
		// both stamps quantized into the same 20 ms tick
		const err = 0.0137;
		const a = mark({ index: 1000, t: 1.0 + err, rate: 1e6 });
		const b = mark({ index: 4000, t: 1.0 + err, rate: 1e6 });
		expect(timebase.alignIndex(a, b, 1000)).toBe(4000);
	});

	test("sampleToHost / hostToSample round-trip", () => {
		const m = mark({ index: 5000, t: 1.0, rate: 1e6 });
		expect(timebase.sampleToHost(m, 6000)).toBeCloseTo(1.001, 12);
		expect(timebase.hostToSample(m, 1.001)).toBe(6000);
	});

	test("driftPpm from two mark pairs (positive: a runs fast)", () => {
		// a's clock runs 100 ppm fast: over 10 s of host time it counts 1 ms more
		const a1 = mark({ index: 0, t: 0, rate: 1e6 });
		const a2 = mark({ index: 10001000, t: 10.0, rate: 1e6 });
		const b1 = mark({ index: 0, t: 0, rate: 1e6 });
		const b2 = mark({ index: 10000000, t: 10.0, rate: 1e6 });
		expect(timebase.driftPpm(a1, a2, b1, b2)).toBeCloseTo(100, 6);
		expect(timebase.driftPpm(b1, b2, a1, a2)).toBeCloseTo(-100, 6);
	});

	test("driftPpm rejects unordered mark pairs", () => {
		const m = mark({ index: 0, t: 5, rate: 1e6 });
		expect(() => timebase.driftPpm(m, m, m, m)).toThrow(/ordered/);
	});

	test("assertMark validates shape", () => {
		expect(() => timebase.offsetSeconds(null, mark({}))).toThrow(/not a mark/);
		expect(() => timebase.offsetSeconds(mark({ rate: -1 }), mark({}))).toThrow(/> 0/);
		expect(() => timebase.offsetSeconds(mark({ t: NaN }), mark({}))).toThrow(/finite/);
	});

	test("stated tolerance is the flowgraph tick", () => {
		expect(timebase.TICK_TOLERANCE_S).toBe(0.02);
	});
});
