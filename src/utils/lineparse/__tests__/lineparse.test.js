const lineparse = require("..");

describe("lineparse", () => {
	test("kv", () => {
		expect(lineparse.parse("kv", "v=3.30 i:0.12 t = -1e-3")).toEqual({ v: 3.3, i: 0.12, t: -0.001 });
	});

	test("csv with and without field names", () => {
		expect(lineparse.parse("csv", "1.5,2,x", ["a", "b", "c"])).toEqual({ a: 1.5, b: 2 });
		expect(lineparse.parse("csv", "1;2")).toEqual({ c0: 1, c1: 2 });
	});

	test("number and raw", () => {
		expect(lineparse.parse("number", " 4.2 ")).toEqual({ value: 4.2 });
		expect(lineparse.parse("number", "hello")).toEqual({});
		expect(lineparse.parse("raw", "anything")).toEqual({});
	});
});
