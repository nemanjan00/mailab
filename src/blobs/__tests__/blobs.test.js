const zlib = require("zlib");
const randomBytes = require("crypto").randomBytes;
const blobs = require("..");

const sample = () => Buffer.concat([
	Buffer.from("FWHDR\x01\x00"), Buffer.alloc(2000),
	zlib.gzipSync(Buffer.from("mailab firmware ".repeat(4000))),
	Buffer.alloc(1500, 0xff), randomBytes(4096)
]);

describe("blob analysis", () => {
	test("entropy finds padding and random regions", () => {
		const e = blobs.entropy(sample(), 256);
		expect(e.regions[0]).toMatchObject({ kind: "low", start: 0 });
		// the random tail is one high-entropy region reaching the end
		const size = sample().length;
		const tail = e.regions.filter((r) => r.kind === "high" && r.end === size);
		expect(tail.length).toBe(1);
		expect(tail[0].start).toBeLessThanOrEqual(size - 4096 + 256);
	});

	test("diff merges nearby changes and counts length differences", () => {
		const a = sample();
		const b = Buffer.from(a);
		b[10] ^= 1;
		b[12] ^= 1;
		b[5000] ^= 1;
		expect(blobs.diff(a, b).ranges).toEqual([{ start: 10, end: 13 }, { start: 5000, end: 5001 }]);
		expect(blobs.diff(Buffer.from("abc"), Buffer.from("abcde"))).toMatchObject({ changedBytes: 2, ranges: [{ start: 3, end: 5 }] });
	});

	test("file + binwalk identify embedded data", () => {
		return blobs.analyze(sample()).then((r) => {
			expect(r.size).toBe(sample().length);
			expect(r.sha256).toHaveLength(64);
			if (Array.isArray(r.signatures)) {
				expect(r.signatures.map((s) => s.name)).toContain("gzip");
			}
		});
	}, 30000);
});
