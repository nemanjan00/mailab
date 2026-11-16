const bytes = require("..");

const B = (arr) => Uint8Array.from(arr);

describe("bytes", () => {
	test("typed reads honour size and byte order", () => {
		const b = B([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x88]);
		expect(bytes.read(b, 0, "u8")).toBe(1);
		expect(bytes.read(b, 7, "i8")).toBe(-120);
		expect(bytes.read(b, 0, "u16le")).toBe(0x0201);
		expect(bytes.read(b, 0, "u16be")).toBe(0x0102);
		expect(bytes.read(b, 0, "u32le")).toBe(0x04030201);
		expect(bytes.read(b, 0, "u32be")).toBe(0x01020304);
		expect(bytes.read(b, 0, "u64le")).toBe(0x8807060504030201n);
		expect(bytes.read(b, 0, "u64be")).toBe(0x0102030405060788n);
		expect(bytes.read(b, 0, "i64le")).toBe(0x8807060504030201n - (1n << 64n));
		expect(bytes.read(B([0xff, 0xfe]), 0, "i16le")).toBe(-257);
		expect(() => bytes.read(b, 6, "u32le")).toThrow(/past the end/);
		expect(() => bytes.read(b, 0, "u24")).toThrow(/unknown type/);
	});

	test("reads work on a subarray with a byte offset", () => {
		const big = B([9, 9, 0x34, 0x12]);
		expect(bytes.read(big.subarray(2), 0, "u16le")).toBe(0x1234);
	});

	test("encode round-trips and range-checks", () => {
		Object.keys(bytes.TYPES).forEach((type) => {
			const value = /^f/.test(type) ? 1.5 : 5;
			const enc = bytes.encode(type, value);
			expect(enc.length).toBe(bytes.TYPES[type]);
			expect(Number(bytes.read(enc, 0, type))).toBe(value);
		});
		expect(Array.from(bytes.encode("u32be", "0xdeadbeef"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
		expect(Array.from(bytes.encode("u16le", 0x1234))).toEqual([0x34, 0x12]);
		expect(Array.from(bytes.encode("i8", -1))).toEqual([0xff]);
		expect(Array.from(bytes.encode("u64le", "18446744073709551615"))).toEqual(new Array(8).fill(0xff));
		expect(Array.from(bytes.encode("i64be", -2))).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]);
		expect(Array.from(bytes.encode("f32le", 1))).toEqual([0, 0, 0x80, 0x3f]);
		expect(Array.from(bytes.encode("f64be", -2))).toEqual([0xc0, 0, 0, 0, 0, 0, 0, 0]);
		expect(() => bytes.encode("u8", 256)).toThrow(/out of range/);
		expect(() => bytes.encode("i8", 128)).toThrow(/out of range/);
		expect(() => bytes.encode("u16le", -1)).toThrow(/out of range/);
		expect(() => bytes.encode("u8", 1.5)).toThrow(/not an integer/);
		expect(() => bytes.encode("f32le", "abc")).toThrow(/not a number/);
	});

	test("hex parsing and patterns", () => {
		expect(Array.from(bytes.parseHex("de ad:be,ef"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
		expect(Array.from(bytes.parseHex("0x01 0x02 \\x03"))).toEqual([1, 2, 3]);
		expect(() => bytes.parseHex("abc")).toThrow(/bad hex/);
		expect(() => bytes.parseHex("zz")).toThrow(/bad hex/);
		const p = bytes.parsePattern("de ?? be ef");
		expect(Array.from(p.bytes)).toEqual([0xde, 0, 0xbe, 0xef]);
		expect(Array.from(p.mask)).toEqual([1, 0, 1, 1]);
		expect(() => bytes.parsePattern("de?")).toThrow(/bad pattern/);
		expect(() => bytes.parsePattern("")).toThrow(/empty/);
	});

	test("text encodings", () => {
		expect(Array.from(bytes.encodeText("Hi", "ascii"))).toEqual([0x48, 0x69]);
		expect(Array.from(bytes.encodeText("Hi", "utf16le"))).toEqual([0x48, 0, 0x69, 0]);
		expect(Array.from(bytes.encodeText("é", "utf8"))).toEqual([0xc3, 0xa9]);
		expect(() => bytes.encodeText("€", "ascii")).toThrow(/latin1/);
		expect(() => bytes.encodeText("x", "ebcdic")).toThrow(/unknown encoding/);
	});

	test("copy formats", () => {
		const b = B([0x00, 0x41, 0x22, 0xff]);
		expect(bytes.format(b, "hex")).toBe("004122ff");
		expect(bytes.format(b, "hex-spaced")).toBe("00 41 22 ff");
		expect(bytes.format(b, "base64")).toBe(Buffer.from(b).toString("base64"));
		expect(bytes.format(B([1, 2]), "base64")).toBe("AQI=");
		expect(bytes.format(B([1]), "base64")).toBe("AQ==");
		expect(bytes.format(b, "c", { name: "fw" })).toBe("const unsigned char fw[4] = {\n\t0x00, 0x41, 0x22, 0xff\n};");
		expect(bytes.format(b, "python")).toBe("b\"\\x00A\\x22\\xff\"");
		expect(bytes.format(b, "escaped")).toBe("\\x00\\x41\\x22\\xff");
		expect(() => bytes.format(b, "rust")).toThrow(/unknown format/);
	});

	test("inspect shows every type that fits", () => {
		const out = bytes.inspect(B([0x41, 0x00, 0x00, 0x00]), 0);
		expect(out.u8).toBe(0x41);
		expect(out.u32le).toBe(0x41);
		expect(out.u64le).toBeUndefined();
		expect(out.bits).toBe("01000001");
		expect(out.ascii).toBe("A");
		expect(out.utf8).toBe("A");
		expect(out.utf16le).toBe("A");
		expect(out.unix32le).toBe("1970-01-01T00:01:05.000Z");
		expect(bytes.inspect(B([0xc3, 0xa9]), 0).utf8).toBe("é");
		expect(bytes.inspect(B([0xc3]), 0).utf8).toBe("");
	});
});
