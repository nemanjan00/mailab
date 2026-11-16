const scpi = require("..");

describe("scpi framing", () => {
	test("text replies complete on newline", () => {
		expect(scpi.isComplete(Buffer.from("1.23"))).toBe(false);
		expect(scpi.isComplete(Buffer.from("1.23\n"))).toBe(true);
	});

	test("IEEE definite-length blocks", () => {
		const block = Buffer.concat([Buffer.from("#15"), Buffer.from([1, 2, 3, 4, 5]), Buffer.from("\n")]);
		expect(scpi.isComplete(block.slice(0, 6))).toBe(false);
		expect(scpi.isComplete(block)).toBe(true);
		expect(Array.from(scpi.unwrap(block))).toEqual([1, 2, 3, 4, 5]);
	});
});
