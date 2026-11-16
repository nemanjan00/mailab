const zlib = require("zlib");
const png = require("..");

// minimal PNG reader: chunks with CRC check, IHDR, inflated rows
const decode = (buf) => {
	expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
	const chunks = {};
	let at = 8;
	while (at < buf.length) {
		const len = buf.readUInt32BE(at);
		const type = buf.subarray(at + 4, at + 8).toString("latin1");
		const data = buf.subarray(at + 8, at + 8 + len);
		expect(buf.readUInt32BE(at + 8 + len)).toBe(zlib.crc32(buf.subarray(at + 4, at + 8 + len)) >>> 0);
		chunks[type] = (chunks[type] || []).concat([data]);
		at += 12 + len;
	}
	const ihdr = chunks.IHDR[0];
	return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), depth: ihdr[8], color: ihdr[9], raw: zlib.inflateSync(Buffer.concat(chunks.IDAT)), end: Boolean(chunks.IEND) };
};

describe("png", () => {
	test("encodes RGB rows with filter 0", () => {
		const data = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 1, 2, 3]);
		const out = decode(png.encode({ width: 2, height: 2, channels: 3, data: data }));
		expect(out).toMatchObject({ width: 2, height: 2, depth: 8, color: 2, end: true });
		expect(Array.from(out.raw)).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 1, 2, 3]);
	});

	test("RGBA by default", () => {
		const out = decode(png.encode({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 4]) }));
		expect(out.color).toBe(6);
		expect(Array.from(out.raw)).toEqual([0, 1, 2, 3, 4]);
	});

	test("rejects short data", () => {
		expect(() => png.encode({ width: 4, height: 4, channels: 3, data: Buffer.alloc(10) })).toThrow("needs 48 bytes");
	});
});
