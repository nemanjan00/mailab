const placeholders = require("..");

describe("placeholders", () => {
	test("names lists each channel once", () => {
		expect(placeholders.names("V = {{psu_voltage}}, I = {{ psu_current|2 }}, again {{psu_voltage|1}}"))
			.toEqual(["psu_voltage", "psu_current"]);
		expect(placeholders.names("")).toEqual([]);
		expect(placeholders.names(undefined)).toEqual([]);
	});

	test("fill passes the optional precision", () => {
		const out = placeholders.fill("a={{a}} b={{ b | 2 }} $x={{a|0}}$", (name, precision) => name + ":" + precision);
		expect(out).toBe("a=a:undefined b=b:2 $x=a:0$");
	});

	test("leaves things that aren't placeholders alone", () => {
		const text = "{{1abc}} {{a-b}} {single} {{a|x}} $$\\frac{1}{2}$$";
		expect(placeholders.fill(text, () => "!")).toBe(text);
	});
});
