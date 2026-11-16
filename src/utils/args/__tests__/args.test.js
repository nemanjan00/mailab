const args = require("..");

describe("parseSwitch", () => {
	test("accepts booleans and on/off/true/false strings", () => {
		expect(args.parseSwitch(true)).toBe(true);
		expect(args.parseSwitch(false)).toBe(false);
		expect(args.parseSwitch("on")).toBe(true);
		expect(args.parseSwitch(" OFF ")).toBe(false);
		expect(args.parseSwitch("false")).toBe(false);
	});

	test("rejects everything else instead of coercing", () => {
		[undefined, null, 0, 1, "", "no", "0", {}, []].forEach((value) => {
			expect(() => {
				args.parseSwitch(value, "on");
			}).toThrow(/on must be true\/false/);
		});
	});
});

describe("parseNumber", () => {
	test("range checks", () => {
		expect(args.parseNumber("3.3", "volts", { min: 0, max: 30 })).toBe(3.3);
		expect(() => {
			args.parseNumber(45, "volts", { min: 0, max: 30, unit: "V" });
		}).toThrow("volts 45 V is above the limit 30 V");
		expect(() => {
			args.parseNumber(-1, "volts", { min: 0 });
		}).toThrow(/below the minimum/);
		expect(() => {
			args.parseNumber("abc", "volts");
		}).toThrow(/must be a number/);
		expect(() => {
			args.parseNumber("", "volts");
		}).toThrow(/must be a number/);
	});
});
