const nodeCrypto = require("crypto");
const checksum = require("..");

const CHECK = Buffer.from("123456789");

describe("checksum", () => {
	test.each(Object.keys(checksum.CRCS))("%s matches its catalogue check value", (name) => {
		expect(checksum.crc(name, CHECK)).toBe(checksum.CRCS[name].check);
	});

	test("table CRC-32 agrees with zlib on random data", () => {
		const data = nodeCrypto.randomBytes(10000);
		// crc32-jamcrc is the table path of crc32 without the final xor
		expect((checksum.crc("crc32-jamcrc", data) ^ 0xFFFFFFFF) >>> 0).toBe(checksum.crc("crc32", data));
	});

	test("sums, xor, two's complement, adler, inet", () => {
		const r = checksum.run(CHECK, ["sum8", "sum16", "sum32", "xor8", "twos8", "adler32", "inet16", "sum16-be-words", "sum16-le-words", "sum32-le-words"]);
		expect(r.sum8.value).toBe(0xDD);
		expect(r.sum16.value).toBe(0x1DD);
		expect(r.sum32.value).toBe(0x1DD);
		expect(r.xor8.value).toBe(0x31 ^ 0x32 ^ 0x33 ^ 0x34 ^ 0x35 ^ 0x36 ^ 0x37 ^ 0x38 ^ 0x39);
		expect(r.twos8.value).toBe(0x23);
		expect((r.sum8.value + r.twos8.value) & 0xFF).toBe(0);
		expect(r.adler32.hex).toBe("0x091E01DE");
		expect(r.inet16.value).toBe(0xF62A);
		expect(r["sum16-be-words"].value).toBe((0x3132 + 0x3334 + 0x3536 + 0x3738 + 0x3900) & 0xFFFF);
		expect(r["sum16-le-words"].value).toBe((0x3231 + 0x3433 + 0x3635 + 0x3837 + 0x0039) & 0xFFFF);
		expect(r["sum32-le-words"].value).toBe((0x34333231 + 0x38373635 + 0x39) >>> 0);
	});

	test("adler32 matches a per-byte reference on a large buffer", () => {
		const data = Buffer.alloc(100000, 0xFF);
		let a = 1;
		let b = 0;
		data.forEach((x) => {
			a = (a + x) % 65521;
			b = (b + a) % 65521;
		});
		expect(checksum.compute("adler32", data).value).toBe(((b << 16) | a) >>> 0);
	});

	test("hashes, entropy, histogram", () => {
		const r = checksum.run(CHECK, ["md5", "sha1", "sha256", "entropy", "histogram"]);
		expect(r.md5.hex).toBe("25f9e794323b453885f5181f1b624d0b");
		expect(r.sha256.hex).toBe(nodeCrypto.createHash("sha256").update(CHECK).digest("hex"));
		expect(r.entropy.value).toBeCloseTo(Math.log2(9), 3);
		expect(r.histogram.counts[0x31]).toBe(1);
		expect(r.histogram.counts.reduce((x, y) => x + y)).toBe(9);
	});

	test("default and all sets, unknown names", () => {
		expect(Object.keys(checksum.run(CHECK))).toEqual(checksum.DEFAULT_ALGORITHMS);
		expect(Object.keys(checksum.run(CHECK, "all")).length).toBe(checksum.ALGORITHMS.length);
		expect(() => checksum.run(CHECK, ["crc99"])).toThrow(/unknown algorithm/);
		expect(checksum.catalogue().find((c) => c.name === "crc16-modbus").params.poly).toBe("0x8005");
	});
});
