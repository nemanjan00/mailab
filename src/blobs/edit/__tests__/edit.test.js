const edit = require("..");

// the slice of the lab API the editor uses
const fakeLab = () => {
	const blobs = {};
	return {
		setBlob: (name, data, source) => {
			blobs[name] = { name: name, data: Buffer.from(data), source: source };
		},
		getBlob: (name) => {
			if (!blobs[name]) {
				throw new Error("unknown blob: " + name);
			}
			return blobs[name];
		}
	};
};

const hexOf = (lab, name) => lab.getBlob(name).data.toString("hex");

describe("blob editing", () => {
	let lab;
	beforeEach(() => {
		lab = fakeLab();
		lab.setBlob("fw", Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex"));
	});

	test("range and peek", () => {
		expect(edit.range(lab, "fw", 4, 4).data.toString("hex")).toBe("05060708");
		expect(edit.range(lab, "fw", 14, 100).data.toString("hex")).toBe("0f10");
		expect(edit.range(lab, "fw", 4, 4).size).toBe(16);
		expect(() => edit.range(lab, "fw", 17, 1)).toThrow(/offset/);
		expect(edit.peek(lab, { name: "fw", offset: 0, length: 4 }).value).toBe("01020304");
		expect(edit.peek(lab, { name: "fw", offset: 0, length: 4, as: "u16le" }).value).toEqual([0x0201, 0x0403]);
		expect(edit.peek(lab, { name: "fw", offset: 0, length: 8, as: "u64be" }).value).toEqual(["72623859790382856"]);
		expect(edit.peek(lab, { name: "fw", offset: 0, length: 4, as: "f32le" }).value.length).toBe(1);
		expect(edit.peek(lab, { name: "fw", offset: 0, length: 2, as: "bin" }).value).toBe("00000001 00000010");
		expect(edit.peek(lab, { name: "fw", offset: 0, length: 2, as: "ascii" }).value).toBe("..");
		expect(() => edit.peek(lab, { name: "fw", as: "u24" })).toThrow(/unknown format/);
		lab.setBlob("big", Buffer.alloc(200000));
		expect(edit.peek(lab, { name: "big", length: 100000 })).toMatchObject({ length: 65536, truncated: true });
		expect(() => edit.peek(lab, { name: "nope" })).toThrow(/unknown blob/);
	});

	test("poke hex and typed values", () => {
		edit.poke(lab, { name: "fw", offset: 0, hex: "ffee" }, "ai");
		expect(hexOf(lab, "fw").slice(0, 8)).toBe("ffee0304");
		const r = edit.poke(lab, { name: "fw", offset: 4, value: "0xdeadbeef", type: "u32be" }, "ai");
		expect(r.written).toBe("deadbeef");
		expect(hexOf(lab, "fw").slice(8, 16)).toBe("deadbeef");
		edit.poke(lab, { name: "fw", offset: 8, value: -1.5, type: "f32le" }, "ai");
		expect(lab.getBlob("fw").data.readFloatLE(8)).toBe(-1.5);
		expect(() => edit.poke(lab, { name: "fw", offset: 0 })).toThrow(/give hex/);
		expect(() => edit.poke(lab, { name: "fw", offset: 0, value: 300, type: "u8" })).toThrow(/out of range/);
		// undo restores
		edit.patch(lab, { name: "fw", ops: r.undo });
		expect(hexOf(lab, "fw").slice(8, 16)).toBe("05060708");
	});

	test("patch stores the result with undo", () => {
		const r = edit.patch(lab, { name: "fw", ops: [{ op: "delete", offset: 0, length: 8 }, { op: "insert", offset: 0, hex: "aa" }] }, "ui");
		expect(r.size).toBe(9);
		expect(hexOf(lab, "fw")).toBe("aa090a0b0c0d0e0f10");
		edit.patch(lab, { name: "fw", ops: r.undo });
		expect(hexOf(lab, "fw")).toBe("0102030405060708090a0b0c0d0e0f10");
	});

	test("search, replace (same and different length, ?? keeps bytes)", () => {
		lab.setBlob("t", Buffer.from("key=AAAA;key=BBBB;"));
		expect(edit.search(lab, { name: "t", text: "key=" }).count).toBe(2);
		expect(edit.search(lab, { name: "t", text: "key=", dir: "next", from: 1 }).hits).toEqual([{ offset: 9, length: 4 }]);

		const one = edit.replace(lab, { name: "t", find: { text: "key=" }, replace: { text: "KEY=" } }, "ui");
		expect(one.replaced).toBe(1);
		expect(lab.getBlob("t").data.toString()).toBe("KEY=AAAA;key=BBBB;");

		const all = edit.replace(lab, { name: "t", find: { regex: "[A-Z]{4};" }, replace: { text: "x;" }, all: true }, "ui");
		expect(all.replaced).toBe(2);
		expect(lab.getBlob("t").data.toString()).toBe("KEY=x;key=x;");
		edit.patch(lab, { name: "t", ops: all.undo });
		expect(lab.getBlob("t").data.toString()).toBe("KEY=AAAA;key=BBBB;");

		// hex find/replace given as strings; ?? keeps the matched byte
		edit.replace(lab, { name: "t", find: "41 41 ?? 41", replace: "42 ?? ?? 42", all: true }, "ui");
		expect(lab.getBlob("t").data.toString()).toBe("KEY=BAAB;key=BBBB;");
		expect(() => edit.replace(lab, { name: "t", find: "4b", replace: "?? ??" }, "ui")).toThrow(/past the match/);

		// replace with nothing deletes; within a range only
		edit.replace(lab, { name: "t", find: { text: ";" }, replace: {}, all: true, start: 10 }, "ui");
		expect(lab.getBlob("t").data.toString()).toBe("KEY=BAAB;key=BBBB");
		expect(edit.replace(lab, { name: "t", find: { text: "zzz" }, replace: { text: "y" } }).replaced).toBe(0);
	});

	test("checksum over a range", () => {
		lab.setBlob("c", Buffer.from("xx123456789yy"));
		const r = edit.checksum(lab, { name: "c", offset: 2, length: 9, algorithms: "crc32,crc16-modbus" });
		expect(r.results.crc32.hex).toBe("0xCBF43926");
		expect(r.results["crc16-modbus"].hex).toBe("0x4B37");
		expect(Object.keys(edit.checksum(lab, { name: "c" }).results).length).toBeGreaterThan(5);
	});

	test("slice copies a range into a new blob", () => {
		expect(edit.slice(lab, { name: "fw", offset: 2, length: 3, to: "part" })).toMatchObject({ name: "part", bytes: 3 });
		expect(hexOf(lab, "part")).toBe("030405");
		edit.slice(lab, { name: "fw", to: "copy" });
		expect(hexOf(lab, "copy")).toBe(hexOf(lab, "fw"));
		expect(() => edit.slice(lab, { name: "fw" })).toThrow(/to/);
	});

	test("next / prev change between blobs", () => {
		const a = Buffer.alloc(20000);
		const b = Buffer.from(a);
		b[10] = 1;
		b[11] = 1;
		b[15000] = 2;
		expect(edit.findChange(a, b, 0, "next")).toEqual({ start: 10, end: 12 });
		expect(edit.findChange(a, b, 12, "next")).toEqual({ start: 15000, end: 15001 });
		expect(edit.findChange(a, b, 15001, "next")).toBe(null);
		expect(edit.findChange(a, b, 20000, "prev")).toEqual({ start: 15000, end: 15001 });
		expect(edit.findChange(a, b, 15000, "prev")).toEqual({ start: 10, end: 12 });
		expect(edit.findChange(a, b, 10, "prev")).toBe(null);
		// length difference counts as change
		expect(edit.findChange(Buffer.from("ab"), Buffer.from("abcd"), 0, "next")).toEqual({ start: 2, end: 4 });
		lab.setBlob("a", a);
		lab.setBlob("b", b);
		expect(edit.change(lab, { a: "a", b: "b", from: 0 }).change).toEqual({ start: 10, end: 12 });
	});
});
