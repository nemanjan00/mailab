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

describe("math sandbox", () => {
	test("expressions can't redefine units or reach the parser", () => {
		["createUnit(\"V\", \"2 m\", {override: true})", "import({x: 1})", "evaluate(\"1+1\")", "parse(\"x\")",
			"compile(\"x\")", "simplify(\"x+x\")", "derivative(\"x^2\", \"x\")", "resolve(\"x\")"].forEach((expr) => {
			expect(() => math.evaluate(expr, {})).toThrow(/disabled in lab expressions/);
		});
		// units stay intact for everyone
		expect(math.evaluate("1 V + 2 V", {}).text).toBe("3 V");
		expect(() => math.evaluate("to(1 V, m)", {})).toThrow(/Units do not match/);
	});

	test("expressions can't allocate huge matrices", () => {
		["zeros(30000, 30000)", "ones([5000, 5000])", "identity(5000)", "range(1, 1e9)", "range(\"1:1e9\")",
			"random([3000, 3000])", "resize([1], [5000, 5000])",
			"multiply(reshape(range(0, 2000), [2000, 1]), reshape(range(0, 2000), [1, 2000]))",
			"reshape(range(0, 2000), [2000, 1]) .* reshape(range(0, 2000), [1, 2000])",
			"reshape(range(0, 2000), [2000, 1]) + reshape(range(0, 2000), [1, 2000])"].forEach((expr) => {
			expect(() => math.evaluate(expr, {})).toThrow(/result too large/);
		});
	});

	test("normal lab math still works", () => {
		expect(math.evaluate("sum(ones(100, 100))", {}).value).toBe(10000);
		expect(math.evaluate("a .* a + 1", { a: [1, 2, 3] }).value).toEqual([2, 5, 10]);
		expect(math.compile("v * i").evaluate({ v: 2, i: 3 })).toBe(6);
	});
});

describe("beamforming", () => {
	test("array factor peaks at the steering angle and nulls where expected", () => {
		expect(math.evaluate("array_factor(8, 0.5, 20, 20)", {}).value).toBeCloseTo(1);
		// half-wavelength ULA, broadside: first null at asin(1/N * 2) ... = asin(2/8 / 1)? -> asin(0.25)
		expect(math.evaluate("array_factor(8, 0.5, 0, asin(0.25) * 180 / pi)", {}).value).toBeCloseTo(0, 5);
		expect(math.evaluate("array_factor_db(8, 0.5, 0, 0)", {}).value).toBeCloseTo(0);
	});

	test("steering vector has unit-magnitude elements with linear phase", () => {
		const v = math.evaluate("steering(4, 0.5, 30)", {}).value;
		expect(v).toHaveLength(4);
		v.forEach((c) => expect(Math.hypot(c.re, c.im)).toBeCloseTo(1));
		// d sin(30°) = 0.25 wavelength -> pi/2 per element
		expect(Math.atan2(v[1].im, v[1].re)).toBeCloseTo(Math.PI / 2);
	});
});
