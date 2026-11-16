const keysym = require("..");

const flat = (events) => events.map((e) => (e.down ? "+" : "-") + e.keysym.toString(16));

describe("keysym", () => {
	test("characters and control characters", () => {
		expect(keysym.forChar("a")).toBe(0x61);
		expect(keysym.forChar("\n")).toBe(0xff0d);
		expect(keysym.forChar("\t")).toBe(0xff09);
		expect(keysym.forChar("é")).toBe(0xe9);
		expect(keysym.forChar("€")).toBe(0x01000000 + 0x20ac);
		expect(() => keysym.forChar("\x01")).toThrow("control character");
	});

	test("named keys", () => {
		expect(keysym.forName("F10")).toBe(0xffc7);
		expect(keysym.forName("f1")).toBe(0xffbe);
		expect(keysym.forName("Enter")).toBe(0xff0d);
		expect(keysym.forName("del")).toBe(0xffff);
		expect(keysym.forName("0xff1b")).toBe(0xff1b);
		expect(keysym.forName("x")).toBe(0x78);
		expect(() => keysym.forName("hyper")).toThrow("unknown key");
	});

	test("typing sends Shift for capitals and symbols", () => {
		expect(flat(keysym.typeEvents("aB!\n"))).toEqual(["+61", "-61", "+ffe1", "+42", "-42", "-ffe1", "+ffe1", "+21", "-21", "-ffe1", "+ff0d", "-ff0d"]);
	});

	test("combos press in order, release in reverse", () => {
		expect(flat(keysym.comboEvents("ctrl+alt+del"))).toEqual(["+ffe3", "+ffe9", "+ffff", "-ffff", "-ffe9", "-ffe3"]);
		expect(flat(keysym.comboEvents("alt+f4"))).toEqual(["+ffe9", "+ffc1", "-ffc1", "-ffe9"]);
		expect(flat(keysym.comboEvents("alt+f x"))).toEqual(["+ffe9", "+66", "-66", "-ffe9", "+78", "-78"]);
		expect(flat(keysym.comboEvents(["ctrl++"]))).toEqual(["+ffe3", "+2b", "-2b", "-ffe3"]);
		expect(() => keysym.comboEvents("")).toThrow("no keys");
	});
});
