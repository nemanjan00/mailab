const table = require("..");

describe("toNumber", () => {
	test("plain numbers", () => {
		expect(table.toNumber(42)).toBe(42);
		expect(table.toNumber("42")).toBe(42);
		expect(table.toNumber(" -1.5 ")).toBe(-1.5);
		expect(table.toNumber("1e-3")).toBe(0.001);
		expect(table.toNumber(".5")).toBe(0.5);
		expect(table.toNumber("−2")).toBe(-2);
	});

	test("engineering notation with and without a unit", () => {
		expect(table.toNumber("1.2 k")).toBe(1200);
		expect(table.toNumber("1.2k")).toBe(1200);
		expect(table.toNumber("-381.042 mV")).toBe(-0.381042);
		expect(table.toNumber("2.4 GHz")).toBe(2.4e9);
		expect(table.toNumber("4.7 µF")).toBe(4.7e-6);
		expect(table.toNumber("4.7uF")).toBe(4.7e-6);
		expect(table.toNumber("12 fF")).toBe(12e-15);
		expect(table.toNumber("3.300 V")).toBe(3.3);
		expect(table.toNumber("4096 B")).toBe(4096);
		expect(table.toNumber("1.5 kB")).toBe(1500);
	});

	test("units that only look prefixed", () => {
		expect(table.toNumber("-10 dBm")).toBe(-10);
		expect(table.toNumber("1024 pts")).toBe(1024);
		expect(table.toNumber("5 min")).toBe(5);
		expect(table.toNumber("50 %")).toBe(50);
		expect(table.toNumber("20 °C")).toBe(20);
	});

	test("hex", () => {
		expect(table.toNumber("0x1f")).toBe(31);
	});

	test("not numbers", () => {
		expect(table.toNumber("abc")).toBeNaN();
		expect(table.toNumber("ch2")).toBeNaN();
		expect(table.toNumber("12:30:05")).toBeNaN();
		expect(table.toNumber("10.0.0.1")).toBeNaN();
		expect(table.toNumber("1.2 k pts")).toBeNaN();
		expect(table.toNumber("—")).toBeNaN();
		expect(table.toNumber(null)).toBeNaN();
		expect(table.toNumber({})).toBeNaN();
	});
});

describe("compare", () => {
	const sorted = (values) => values.slice().sort(table.compare);

	test("numbers by value, engineering notation included", () => {
		expect(sorted(["1.2 k", "-381.042 mV", "900", "2 M", "0.5"])).toEqual(["-381.042 mV", "0.5", "900", "1.2 k", "2 M"]);
		expect(sorted([10, 9, 100])).toEqual([9, 10, 100]);
	});

	test("strings in natural, case-insensitive order", () => {
		expect(sorted(["ch10", "Ch2", "ch1"])).toEqual(["ch1", "Ch2", "ch10"]);
	});

	test("numbers before strings", () => {
		expect(sorted(["running", "5", "idle"])).toEqual(["5", "idle", "running"]);
	});
});

describe("isBlank", () => {
	test("empty-looking cells", () => {
		expect(table.isBlank(null)).toBe(true);
		expect(table.isBlank(undefined)).toBe(true);
		expect(table.isBlank("")).toBe(true);
		expect(table.isBlank("—")).toBe(true);
		expect(table.isBlank(NaN)).toBe(true);
		expect(table.isBlank(0)).toBe(false);
		expect(table.isBlank("x")).toBe(false);
	});
});

describe("parseFilter / matches", () => {
	const titles = ["id", "driver", "state"];

	test("plain terms, AND-ed and lowercased", () => {
		expect(table.parseFilter("Sim  run", titles)).toEqual([{ column: -1, text: "sim" }, { column: -1, text: "run" }]);
		expect(table.parseFilter("", titles)).toEqual([]);
	});

	test("column terms by exact title or prefix", () => {
		expect(table.parseFilter("state:run", titles)).toEqual([{ column: 2, text: "run" }]);
		expect(table.parseFilter("dr:sim", titles)).toEqual([{ column: 1, text: "sim" }]);
		expect(table.parseFilter("STATE:\"not run\"", titles)).toEqual([{ column: 2, text: "not run" }]);
	});

	test("unknown columns stay plain text", () => {
		expect(table.parseFilter("12:30", titles)).toEqual([{ column: -1, text: "12:30" }]);
	});

	test("quoted phrases", () => {
		expect(table.parseFilter("\"a b\" c", titles)).toEqual([{ column: -1, text: "a b" }, { column: -1, text: "c" }]);
	});

	test("matches", () => {
		const cells = ["psu1", "sim", "running"];
		expect(table.matches(cells, table.parseFilter("SIM", titles))).toBe(true);
		expect(table.matches(cells, table.parseFilter("sim stopped", titles))).toBe(false);
		expect(table.matches(cells, table.parseFilter("state:run", titles))).toBe(true);
		expect(table.matches(cells, table.parseFilter("id:run", titles))).toBe(false);
	});
});

describe("view", () => {
	const rows = [
		{ name: "a_v", latest: "1.2 k" },
		{ name: "b_v", latest: "—" },
		{ name: "c_i", latest: "-381.042 mV" },
		{ name: "d_i", latest: "900" }
	];
	const columns = [
		{ title: "name", raw: (r) => r.name },
		{ title: "latest", raw: (r) => r.latest }
	];
	const names = (list) => list.map((r) => r.name);

	test("unsorted, unfiltered keeps the input", () => {
		expect(table.view(rows, columns, { filter: "", sort: -1, dir: 0 })).toBe(rows);
	});

	test("sorts both ways with blanks last", () => {
		expect(names(table.view(rows, columns, { filter: "", sort: 1, dir: 1 }))).toEqual(["c_i", "d_i", "a_v", "b_v"]);
		expect(names(table.view(rows, columns, { filter: "", sort: 1, dir: -1 }))).toEqual(["a_v", "d_i", "c_i", "b_v"]);
	});

	test("filters, then sorts", () => {
		expect(names(table.view(rows, columns, { filter: "_i", sort: 1, dir: -1 }))).toEqual(["d_i", "c_i"]);
		expect(names(table.view(rows, columns, { filter: "latest:mv", sort: -1, dir: 0 }))).toEqual(["c_i"]);
	});

	test("searches the shown text too", () => {
		const shown = [{ title: "v", raw: (r) => r, text: (r) => r + " volts" }];
		expect(table.view([1, 2], shown, { filter: "volts", sort: -1, dir: 0 })).toEqual([1, 2]);
		expect(table.view([1, 2], shown, { filter: "2", sort: -1, dir: 0 })).toEqual([2]);
	});
});

describe("serialization", () => {
	const titles = ["name", "note", "n"];
	const matrix = [["a", "plain", 1], ["b", "has, comma \"quoted\"\nline", null], ["c", { k: 1 }, 2.5]];

	test("CSV per RFC 4180", () => {
		expect(table.toCSV(titles, matrix)).toBe("name,note,n\r\n"
			+ "a,plain,1\r\n"
			+ "b,\"has, comma \"\"quoted\"\"\nline\",\r\n"
			+ "c,\"{\"\"k\"\":1}\",2.5\r\n");
	});

	test("JSON keyed by title", () => {
		expect(JSON.parse(table.toJSON(titles, matrix))).toEqual([
			{ name: "a", note: "plain", n: 1 },
			{ name: "b", note: "has, comma \"quoted\"\nline", n: null },
			{ name: "c", note: { k: 1 }, n: 2.5 }
		]);
	});

	test("repeated and missing titles get unique keys", () => {
		expect(table.toObjects(["x", "x", ""], [[1, 2, 3]])).toEqual([{ x: 1, "x 2": 2, col3: 3 }]);
	});
});

describe("keysOf", () => {
	test("union of keys in first-seen order", () => {
		expect(table.keysOf([{ a: 1, b: 2 }, { c: 3, a: 4 }])).toEqual(["a", "b", "c"]);
		expect(table.keysOf([1, "x"])).toEqual(["value"]);
		expect(table.keysOf([])).toEqual([]);
	});
});

describe("rowsOf", () => {
	test("arrays, sweep tables, objects, scalars", () => {
		expect(table.rowsOf([{ a: 1 }])).toEqual([{ a: 1 }]);
		expect(table.rowsOf({ kind: "sweep", columns: ["x", "psu_v"], rows: [[1, 0.9], [2, 1.8]] })).toEqual([{ x: 1, psu_v: 0.9 }, { x: 2, psu_v: 1.8 }]);
		expect(table.rowsOf({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
		expect(table.rowsOf({ a: 1, b: "x" })).toEqual([{ key: "a", value: 1 }, { key: "b", value: "x" }]);
		expect(table.rowsOf(5)).toEqual([5]);
		expect(table.rowsOf(null)).toEqual([]);
	});
});
