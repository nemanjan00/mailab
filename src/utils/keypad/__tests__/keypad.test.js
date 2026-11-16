const keypad = require("..");

const type = (entry, keys) => keys.reduce((e, k) => keypad.press(e, k), entry);

describe("keypad", () => {
	test("first digit replaces the shown value", () => {
		expect(type(keypad.open("3.3"), ["5"])).toEqual({ mantissa: "5", fresh: false });
		expect(type(keypad.open("3.3"), ["."])).toEqual({ mantissa: "0.", fresh: false });
	});

	test("digits, point, sign, backspace, clear", () => {
		const entry = type(keypad.open(""), ["1", "2", ".", "5", ".", "0"]);
		expect(entry.mantissa).toBe("12.50");
		expect(type(entry, ["±"]).mantissa).toBe("-12.50");
		expect(type(entry, ["±", "±"]).mantissa).toBe("12.50");
		expect(type(entry, ["back", "back"]).mantissa).toBe("12.");
		expect(type(entry, ["clear"]).mantissa).toBe("");
		expect(type(keypad.open(""), ["±", "."]).mantissa).toBe("-0.");
	});

	test("sign and backspace edit the shown value instead of replacing it", () => {
		expect(type(keypad.open("3.3"), ["±"]).mantissa).toBe("-3.3");
		expect(type(keypad.open("3.3"), ["back", "5"]).mantissa).toBe("3.5");
	});

	test("ignores unknown keys and caps the length", () => {
		const entry = keypad.open("1");
		expect(keypad.press(entry, "x")).toBe(entry);
		expect(keypad.press(entry, "12")).toBe(entry);
		const long = type(keypad.open(""), Array(30).fill("9"));
		expect(long.mantissa.length).toBe(16);
	});
});
