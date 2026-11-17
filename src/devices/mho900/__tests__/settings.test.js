// The MHO900 settings model: schema shape, sync plan and set->SCPI mapping.
// Pure module tests; SCPI headers verified live against an MHO98.

const settings = require("../settings");

describe("mho900 settings schema", () => {
	test("schema has channel/timebase/trigger/acquire/awg sections", () => {
		const s = settings.schema();
		const titles = s.map((x) => x.title);
		expect(titles).toEqual(expect.arrayContaining(["Channel 1", "Channel 4", "Timebase", "Trigger", "Acquire", "AWG 1", "AWG 2"]));
		const ch1 = s.find((x) => x.title === "Channel 1");
		expect(ch1.fields.map((f) => f.key)).toEqual(["on", "scale", "offset", "probe", "coupling", "impedance"]);
		expect(ch1.fields.find((f) => f.key === "scale").unit).toBe("V/div");
		expect(ch1.index).toBe(1);
	});
});

describe("mho900 settings sync plan", () => {
	test("plan covers 4 channels + timebase + trigger + acquire + 2 awg", () => {
		const plan = settings.syncQueries();
		expect(plan.length).toBe(4 * 6 + 3 + 5 + 3 + 2 * 5);
		const paths = plan.map((p) => p.path.join("."));
		expect(paths).toEqual(expect.arrayContaining([
			"ch.1.on", "ch.4.impedance", "timebase.scale", "trigger.level",
			"acquire.memdepth", "awg.1.amp", "awg.2.offset"
		]));
	});

	test("parsers convert unit replies into model values", () => {
		const plan = settings.syncQueries();
		const byPath = {};
		plan.forEach((p) => {
			byPath[p.path.join(".")] = p;
		});
		expect(byPath["ch.1.on"].parse("1")).toBe(true);
		expect(byPath["ch.1.on"].parse("0")).toBe(false);
		expect(byPath["ch.1.scale"].parse("1.000000E-01")).toBeCloseTo(0.1);
		expect(byPath["ch.1.probe"].parse("1.000000E+01")).toBe("10");
		expect(byPath["ch.1.impedance"].parse("FIFTy")).toBe("50");
		expect(byPath["ch.1.impedance"].parse("OMEG")).toBe("1M");
		expect(byPath["timebase.scale"].query).toBe(":TIMebase:MAIN:SCALe?");
		expect(byPath["trigger.sweep"].parse("AUTO")).toBe("AUTO");
		expect(byPath["awg.1.on"].parse("1")).toBe(true);
	});
});

describe("mho900 settings set mapping", () => {
	test("channel writes map to :CHAN<n> commands", () => {
		const writes = settings.buildWrites({ ch: { 1: { scale: 0.1, on: true, probe: 10, coupling: "DC", impedance: "50", offset: -0.5 } } });
		expect(writes.map((w) => w.write)).toEqual([
			":CHAN1:SCALe 0.1",
			":CHAN1:DISPlay ON",
			":CHAN1:PROBe 10",
			":CHAN1:COUPling DC",
			":CHAN1:IMPedance FIFTy",
			":CHAN1:OFFSet -0.5"
		]);
		expect(writes[0].confirm).toBe(":CHAN1:SCALe?");
	});

	test("timebase/trigger/acquire writes", () => {
		const writes = settings.buildWrites({
			timebase: { scale: 0.001, mode: "MAIN" },
			trigger: { mode: "EDGE", sweep: "NORM", source: "CHAN2", slope: "NEG", level: 0.25 },
			acquire: { type: "AVER", averages: 16, memdepth: 100000 }
		});
		const cmds = writes.map((w) => w.write);
		expect(cmds).toContain(":TIMebase:MAIN:SCALe 0.001");
		expect(cmds).toContain(":TIMebase:MODE MAIN");
		expect(cmds).toContain(":TRIGger:MODE EDGE");
		expect(cmds).toContain(":TRIGger:SWEep NORM");
		expect(cmds).toContain(":TRIGger:EDGE:SOURce CHAN2");
		expect(cmds).toContain(":TRIGger:EDGE:SLOPe NEG");
		expect(cmds).toContain(":TRIGger:EDGE:LEVel 0.25");
		expect(cmds).toContain(":ACQuire:TYPE AVER");
		expect(cmds).toContain(":ACQuire:AVERages 16");
		expect(cmds).toContain(":ACQuire:MDEPth 100000");
	});

	test("awg writes and prefix-matched enums", () => {
		const writes = settings.buildWrites({ awg: { 1: { func: "SIN", freq: 1000000, amp: 1, offset: 0, on: true } } });
		expect(writes.map((w) => w.write)).toEqual([
			":SOURce1:FUNCtion SINusoid",
			":SOURce1:FREQuency 1000000",
			":SOURce1:VOLTage:AMPLitude 1",
			":SOURce1:VOLTage:OFFSet 0",
			":SOURce1:OUTPut:STATe ON"
		]);
		// "squ" prefix-matches SQUare
		const squ = settings.buildWrites({ awg: { 2: { func: "squ" } } });
		expect(squ[0].write).toBe(":SOURce2:FUNCtion SQUare");
	});

	test("validation rejects bad values with useful errors", () => {
		expect(() => settings.buildWrites({ ch: { 1: { scale: "abc" } } })).toThrow("expected a number");
		expect(() => settings.buildWrites({ ch: { 1: { scale: 1000 } } })).toThrow("<= 100");
		expect(() => settings.buildWrites({ ch: { 1: { coupling: "XL" } } })).toThrow("must be one of");
		expect(() => settings.buildWrites({ ch: { 1: { nosuch: 1 } } })).toThrow("unknown setting");
		expect(() => settings.buildWrites({ nosuch: { a: 1 } })).toThrow("unknown section");
		expect(() => settings.buildWrites({ ch: 3 })).toThrow("must be an object");
	});

	test("bool coercion and integer rounding", () => {
		const writes = settings.buildWrites({ acquire: { averages: 15.6 }, awg: { 1: { on: 1 } } });
		expect(writes.find((w) => w.path.join(".") === "acquire.averages").value).toBe(16);
		expect(writes.find((w) => w.path.join(".") === "awg.1.on").value).toBe(true);
	});
});
