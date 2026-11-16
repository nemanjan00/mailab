const math = require("..");

describe("math", () => {
	test("lab helpers", () => {
		expect(math.evaluate("rms(x)", { x: [3, -3, 3, -3] }).value).toBeCloseTo(3);
		expect(math.evaluate("vpp(x)", { x: [1, 5, -2] }).value).toBe(7);
		expect(math.evaluate("w2dbm(0.001)", {}).value).toBeCloseTo(0);
		expect(math.evaluate("dbm2w(30)", {}).value).toBeCloseTo(1);
		expect(math.evaluate("db([10, 100])", {}).value).toEqual([10, 20]);
	});

	test("fft results are plain data", () => {
		const result = math.evaluate("max(mag(fft(x)))", { x: [1, 0, -1, 0] });
		expect(result.value).toBeCloseTo(2);
	});

	test("compile reports inputs", () => {
		const compiled = math.compile("psu_v * psu_i");
		expect(compiled.inputs).toEqual(["psu_v", "psu_i"]);
		expect(compiled.evaluate({ psu_v: 5, psu_i: 0.5 })).toBe(2.5);
	});

	test("tex", () => {
		expect(math.tex("sqrt(x)")).toContain("\\sqrt");
	});
});
