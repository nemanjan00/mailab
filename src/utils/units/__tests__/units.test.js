const units = require("..");

describe("choices", () => {
	test("prefix buttons per unit", () => {
		expect(units.choices("V").map((c) => c.label)).toEqual(["mV", "V", "kV"]);
		expect(units.choices("Hz").map((c) => c.label)).toEqual(["Hz", "kHz", "MHz", "GHz"]);
		expect(units.choices("s").map((c) => c.label)).toEqual(["ns", "µs", "ms", "s"]);
		expect(units.choices("A").map((c) => c.label)).toEqual(["µA", "mA", "A"]);
		expect(units.choices("dBm").map((c) => c.label)).toEqual(["dBm"]);
		expect(units.choices("")).toEqual([]);
	});
});

describe("parse", () => {
	test("engineering suffixes without a unit", () => {
		expect(units.parse("2.4G")).toBe(2.4e9);
		expect(units.parse("100m")).toBe(0.1);
		expect(units.parse("1.1m")).toBe(0.0011);
		expect(units.parse("4.7u")).toBe(4.7e-6);
		expect(units.parse("4.7µ")).toBe(4.7e-6);
		expect(units.parse("10k")).toBe(10000);
		expect(units.parse("10K")).toBe(10000);
		expect(units.parse("3meg")).toBe(3e6);
		expect(units.parse("  -12.5 ")).toBe(-12.5);
		expect(units.parse(".5")).toBe(0.5);
		expect(units.parse("1e-3")).toBe(0.001);
		expect(units.parse("2e3k")).toBe(2e6);
	});

	test("with the unit typed out", () => {
		expect(units.parse("2.4 GHz", "Hz")).toBe(2.4e9);
		expect(units.parse("2.4ghz", "Hz")).toBe(2.4e9);
		expect(units.parse("100 mV", "V")).toBe(0.1);
		expect(units.parse("5 ms", "s")).toBe(0.005);
		expect(units.parse("5 s", "s")).toBe(5);
		expect(units.parse("250mA", "A")).toBe(0.25);
		expect(units.parse("-10 dBm", "dBm")).toBe(-10);
		expect(units.parse("-10", "dBm")).toBe(-10);
	});

	test("rejects garbage instead of guessing", () => {
		expect(units.parse("")).toBeNaN();
		expect(units.parse("abc")).toBeNaN();
		expect(units.parse("1.2.3")).toBeNaN();
		expect(units.parse("5 x")).toBeNaN();
		expect(units.parse("100 mA", "V")).toBeNaN();
		expect(units.parse("-10 mdBm", "dBm")).toBeNaN();
		expect(units.parse(undefined)).toBeNaN();
	});
});

describe("split / format / combine", () => {
	test("picks the largest prefix the value reaches", () => {
		expect(units.split(2.4e9, "Hz")).toEqual({ mantissa: "2.4", choice: "GHz" });
		expect(units.split(0.0011, "V")).toEqual({ mantissa: "1.1", choice: "mV" });
		expect(units.split(0.0000005, "V")).toEqual({ mantissa: "0.0005", choice: "mV" });
		expect(units.split(0, "V")).toEqual({ mantissa: "0", choice: "V" });
		expect(units.split(-3.3, "V")).toEqual({ mantissa: "-3.3", choice: "V" });
		expect(units.split(NaN, "s")).toEqual({ mantissa: "", choice: "s" });
	});

	test("format", () => {
		expect(units.format(2.4e9, "Hz")).toBe("2.4 GHz");
		expect(units.format(0.25, "A")).toBe("250 mA");
		expect(units.format(-10, "dBm")).toBe("-10 dBm");
		expect(units.format(5, "")).toBe("5");
		expect(units.format(NaN, "V")).toBe("");
	});

	test("combine round-trips split and parses format", () => {
		[[2.4e9, "Hz"], [433.92e6, "Hz"], [0.0011, "s"], [1e-9, "s"], [0.25, "A"]].forEach((pair) => {
			const parts = units.split(pair[0], pair[1]);
			expect(units.combine(parts.mantissa, parts.choice, pair[1])).toBe(pair[0]);
			expect(units.parse(units.format(pair[0], pair[1]), pair[1])).toBe(pair[0]);
		});
		expect(units.combine("", "V", "V")).toBeNaN();
		expect(units.combine("-", "V", "V")).toBeNaN();
		expect(units.combine("12.", "kV", "V")).toBe(12000);
	});
});
