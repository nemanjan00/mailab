const expr = require("..");

describe("offset expressions", () => {
	test("literals in every radix", () => {
		expect(expr.evaluate("4096")).toBe(4096);
		expect(expr.evaluate("0x1000")).toBe(4096);
		expect(expr.evaluate("0X1F")).toBe(31);
		expect(expr.evaluate("1000h")).toBe(4096);
		expect(expr.evaluate("0b1010")).toBe(10);
		expect(expr.evaluate("0o17")).toBe(15);
		expect(expr.evaluate("0x1_0000")).toBe(65536);
	});

	test("precedence and operators", () => {
		expect(expr.evaluate("0x1000+4*3")).toBe(4108);
		expect(expr.evaluate("(1+2)*3")).toBe(9);
		expect(expr.evaluate("1 << 4 | 1")).toBe(17);
		expect(expr.evaluate("0xff & ~0xf")).toBe(0xf0);
		expect(expr.evaluate("7 / 2")).toBe(3);
		expect(expr.evaluate("7 % 4")).toBe(3);
		expect(expr.evaluate("-5 + 10")).toBe(5);
		expect(expr.evaluate("0x10 ^ 0x11")).toBe(1);
		expect(expr.evaluate("256 >> 4")).toBe(16);
	});

	test("variables", () => {
		const vars = { end: 0x10000, cur: 0x20, base: 0x08000000 };
		expect(expr.evaluate("end-0x100", vars)).toBe(0xff00);
		expect(expr.evaluate("cur + 0x10", vars)).toBe(0x30);
		expect(expr.evaluate("0x08001000 - base", vars)).toBe(0x1000);
		expect(() => expr.evaluate("nope", vars)).toThrow(/unknown name: nope/);
		expect(() => expr.evaluate("constructor", {})).toThrow(/unknown name/);
	});

	test("64-bit exact via BigInt", () => {
		expect(expr.evaluateBig("0xffffffffffffffff + 1")).toBe(1n << 64n);
		expect(expr.evaluateBig("1 << 63")).toBe(1n << 63n);
		expect(() => expr.evaluate("1 << 60")).toThrow(/too large/);
	});

	test("errors", () => {
		expect(() => expr.evaluate("")).toThrow(/empty/);
		expect(() => expr.evaluate("1 +")).toThrow(/unexpected end/);
		expect(() => expr.evaluate("(1")).toThrow(/missing \)/);
		expect(() => expr.evaluate("1 2")).toThrow(/unexpected/);
		expect(() => expr.evaluate("1 / 0")).toThrow(/division by zero/);
		expect(() => expr.evaluate("1 << 100")).toThrow(/shift out of range/);
		expect(() => expr.evaluate("2 $ 3")).toThrow(/unexpected/);
		expect(() => expr.evaluate("x".repeat(300))).toThrow(/longer than/);
		expect(() => expr.evaluate("(".repeat(40) + "1" + ")".repeat(40))).toThrow(/nested too deeply/);
		expect(() => expr.evaluate("Math.max(1)")).toThrow();
	});
});
