const hidkeys = require("..");

const hex = (reports) => reports.map((r) => r.toString("hex"));

describe("HID keyboard reports", () => {
	test("typing: press + release per character, Shift for capitals and symbols", () => {
		expect(hex(hidkeys.typeReports("aB!\n"))).toEqual([
			"0000040000000000", "0000000000000000",
			"0200050000000000", "0000000000000000",
			"02001e0000000000", "0000000000000000",
			"0000280000000000", "0000000000000000"
		]);
		expect(hidkeys.typeReports("0 9")[0][2]).toBe(0x27);
		expect(() => hidkeys.typeReports("é")).toThrow(/US HID keyboard/);
	});

	test("combos: keys down in order, up in reverse", () => {
		expect(hex(hidkeys.comboReports("ctrl+alt+del"))).toEqual([
			"0100000000000000",
			"0500000000000000",
			"05004c0000000000",
			"0500000000000000",
			"0100000000000000",
			"0000000000000000"
		]);
		expect(hex(hidkeys.comboReports("F10"))).toEqual(["0000430000000000", "0000000000000000"]);
		expect(hex(hidkeys.comboReports("F13"))).toEqual(["0000680000000000", "0000000000000000"]);
		// two combos, array form, ctrl++ = ctrl and plus (the = key)
		const r = hidkeys.comboReports(["shift+tab", "ctrl++"]);
		expect(hex(r)).toEqual([
			"0200000000000000", "02002b0000000000", "0200000000000000", "0000000000000000",
			"0100000000000000", "01002e0000000000", "0100000000000000", "0000000000000000"
		]);
		expect(() => hidkeys.comboReports("ctrl+nosuchkey")).toThrow(/unknown key/);
		expect(() => hidkeys.comboReports("")).toThrow(/no keys/);
	});

	test("raw usages and right-hand modifiers", () => {
		expect(hidkeys.forName("0x4c")).toEqual({ usage: 0x4c });
		expect(hidkeys.forName("rctrl")).toEqual({ modifier: 0x10 });
		expect(hidkeys.forName("A")).toEqual({ usage: 0x04 });
	});
});
