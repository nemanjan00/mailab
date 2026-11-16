const bytesearch = require("..");

const offsets = (r) => r.hits.map((h) => h.offset);

describe("bytesearch", () => {
	const buf = Buffer.concat([Buffer.from("xxDEADxxdeadxx"), Buffer.from([0xde, 0xad, 0x01, 0xef, 0xde, 0xad, 0x02, 0xef, 0x00, 0xde])]);

	test("hex with and without wildcards", () => {
		expect(offsets(bytesearch.search(buf, { hex: "de ad ?? ef" }))).toEqual([14, 18]);
		expect(offsets(bytesearch.search(buf, { hex: "?? ad 02" }))).toEqual([18]);
		expect(offsets(bytesearch.search(buf, { hex: "dead" }))).toEqual([14, 18]);
		// pattern ending past the buffer never matches
		expect(offsets(bytesearch.search(buf, { hex: "de ??" }))).toEqual([14, 18]);
		expect(bytesearch.search(buf, { hex: "de ad ?? ef" }).hits[0].length).toBe(4);
	});

	test("all-wildcard pattern matches every non-overlapping position", () => {
		expect(offsets(bytesearch.search(Buffer.alloc(5), { hex: "????" }))).toEqual([0, 2]);
	});

	test("hits never overlap", () => {
		expect(offsets(bytesearch.search(Buffer.from("aaaa"), { text: "aa" }))).toEqual([0, 2]);
	});

	test("text: ascii, case-insensitive, utf16le", () => {
		expect(offsets(bytesearch.search(buf, { text: "DEAD" }))).toEqual([2]);
		expect(offsets(bytesearch.search(buf, { text: "dead", ignoreCase: true }))).toEqual([2, 8]);
		const wide = Buffer.concat([Buffer.alloc(3), Buffer.from("Hello", "utf16le")]);
		expect(offsets(bytesearch.search(wide, { text: "Hello", encoding: "utf16le" }))).toEqual([3]);
		expect(bytesearch.search(wide, { text: "Hello", encoding: "utf16le" }).hits[0].length).toBe(10);
	});

	test("regex over latin1 with byte offsets", () => {
		const r = bytesearch.search(buf, { regex: "dead|DEAD" });
		expect(offsets(r)).toEqual([2, 8]);
		expect(offsets(bytesearch.search(buf, { regex: "\\xde\\xad[\\x00-\\x01]" }))).toEqual([14]);
		expect(offsets(bytesearch.search(buf, { regex: "x*" }))).toEqual([0, 6, 12]);
		expect(() => bytesearch.search(buf, { regex: "(" })).toThrow();
	});

	test("next / prev / wrap", () => {
		expect(offsets(bytesearch.search(buf, { hex: "dead" }, { dir: "next", from: 15 }))).toEqual([18]);
		expect(offsets(bytesearch.search(buf, { hex: "dead" }, { dir: "next", from: 19 }))).toEqual([]);
		expect(offsets(bytesearch.search(buf, { hex: "dead" }, { dir: "next", from: 19, wrap: true }))).toEqual([14]);
		expect(offsets(bytesearch.search(buf, { hex: "dead" }, { dir: "prev", from: 18 }))).toEqual([14]);
		expect(offsets(bytesearch.search(buf, { hex: "dead" }, { dir: "prev", from: 14 }))).toEqual([]);
		expect(offsets(bytesearch.search(buf, { hex: "dead" }, { dir: "prev", from: 14, wrap: true }))).toEqual([18]);
		expect(offsets(bytesearch.search(buf, { hex: "de??01" }, { dir: "prev", from: 100 }))).toEqual([14]);
		expect(offsets(bytesearch.search(buf, { regex: "dead" }, { dir: "next", from: 3 }))).toEqual([8]);
		expect(offsets(bytesearch.search(buf, { regex: "dead", flags: "i" }, { dir: "prev", from: 8 }))).toEqual([2]);
		expect(offsets(bytesearch.search(buf, { regex: "dead" }, { dir: "prev", from: 8, wrap: true }))).toEqual([8]);
	});

	test("range and max", () => {
		expect(offsets(bytesearch.search(buf, { hex: "dead" }, { start: 15 }))).toEqual([18]);
		expect(offsets(bytesearch.search(buf, { hex: "dead" }, { end: 18 }))).toEqual([14]);
		expect(offsets(bytesearch.search(buf, { hex: "dead" }, { end: 19 }))).toEqual([14]);
		expect(offsets(bytesearch.search(buf, { regex: "dead", flags: "i" }, { start: 3 }))).toEqual([8]);
		const many = bytesearch.search(Buffer.alloc(100), { hex: "00" }, { max: 10 });
		expect(many.hits.length).toBe(10);
		expect(many.truncated).toBe(true);
		const regexMany = bytesearch.search(Buffer.alloc(100), { regex: "\\x00" }, { max: 10 });
		expect(regexMany.hits.length).toBe(10);
		expect(regexMany.truncated).toBe(true);
	});

	test("bad specs", () => {
		expect(() => bytesearch.search(buf, {})).toThrow(/give hex, text or regex/);
		expect(() => bytesearch.search(buf, { regex: "a".repeat(600) })).toThrow(/longer than/);
	});

	test("finds a wildcard pattern in a big buffer quickly", () => {
		const big = Buffer.alloc(16 * 1024 * 1024, 0x5a);
		big.write("MAGIC", 15 * 1024 * 1024);
		const t0 = Date.now();
		expect(offsets(bytesearch.search(big, { hex: "4d 41 ?? 49 43" }))).toEqual([15 * 1024 * 1024]);
		expect(Date.now() - t0).toBeLessThan(2000);
	});
});
