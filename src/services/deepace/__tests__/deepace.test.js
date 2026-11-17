// DeepAce framing: buildFrame + streaming parser round-trips, resync on
// corruption. Formats from the kc9531b vendor-protocol package; not yet
// verified on a KC901K [HW].

const deepace = require("..");

describe("deepace framing", () => {
	test("buildFrame: header, length and running-sum checksum", () => {
		const f = deepace.buildFrame(0x42, Buffer.from([0x33, 0x33, 0x33]));
		expect(Array.from(f)).toEqual([0xfe, 0x01, 0x42, 0x03, 0x00, 0x33, 0x33, 0x33, 0xdd, 0x01]);
		// checksum: fe+01+42+03+00+33*3 = 0x1dd
		expect(f.readUInt16LE(5 + 3)).toBe(0x1dd);
	});

	test("buildFrame: empty payload, multi-byte length", () => {
		const f = deepace.buildFrame(7, Buffer.alloc(0));
		expect(f.length).toBe(7);
		expect(f.readUInt16LE(3)).toBe(0);
		const big = deepace.buildFrame(1, Buffer.alloc(300, 0x55));
		expect(big.readUInt16LE(3)).toBe(300);
	});

	test("parser: one whole frame", () => {
		const frames = [];
		const p = deepace.createParser((f) => frames.push(f));
		const wire = Buffer.from([0xff, 0x01, 0x42, 0x01, 0x03, 0x00, 0xaa, 0xbb, 0xcc, 0x00, 0x00]);
		// fix checksum: sum over ff 01 42 01 03 00 aa bb cc
		const sum = wire.slice(0, 9).reduce((a, b) => (a + b) & 0xffff, 0);
		wire.writeUInt16LE(sum, 9);
		p.push(wire);
		expect(frames.length).toBe(1);
		expect(frames[0].code).toBe(0x42);
		expect(frames[0].ok).toBe(true);
		expect(Array.from(frames[0].body)).toEqual([0xaa, 0xbb, 0xcc]);
	});

	test("parser: chunked delivery and multiple frames", () => {
		const frames = [];
		const p = deepace.createParser((f) => frames.push(f));
		const mk = (code, body) => {
			const b = Buffer.from(body);
			const head = Buffer.from([0xff, 0x01, code, 1, b.length & 0xff, (b.length >> 8) & 0xff]);
			const cc = deepace.checksum(Buffer.concat([head, b]));
			return Buffer.concat([head, b, Buffer.from([cc & 0xff, (cc >> 8) & 0xff])]);
		};
		const wire = Buffer.concat([mk(1, [1, 2]), mk(2, []), mk(3, [9])]);
		for (let i = 0; i < wire.length; i += 3) {
			p.push(wire.slice(i, i + 3));
		}
		expect(frames.length).toBe(3);
		expect(frames.map((f) => f.code)).toEqual([1, 2, 3]);
		expect(frames[1].body.length).toBe(0);
	});

	test("parser: resyncs past garbage and bad checksums", () => {
		const frames = [];
		const errors = [];
		const p = deepace.createParser((f) => frames.push(f), (e) => errors.push(e));
		const mk = (code, body, corrupt) => {
			const b = Buffer.from(body);
			const head = Buffer.from([0xff, 0x01, code, 1, b.length, 0]);
			const cc = deepace.checksum(Buffer.concat([head, b])) ^ (corrupt ? 0xff : 0);
			return Buffer.concat([head, b, Buffer.from([cc & 0xff, (cc >> 8) & 0xff])]);
		};
		p.push(Buffer.from([0x00, 0x13, 0x37])); // garbage
		p.push(mk(9, [1], true)); // bad checksum
		p.push(mk(10, [2])); // good
		p.push(Buffer.from([0xff, 0x02, 0x00])); // bad version then nothing
		expect(frames.length).toBe(1);
		expect(frames[0].code).toBe(10);
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});

	test("parser: status byte maps to ok", () => {
		const frames = [];
		const p = deepace.createParser((f) => frames.push(f));
		const head = Buffer.from([0xff, 0x01, 5, 0, 1, 0]); // status 0 = device error
		const cc = deepace.checksum(Buffer.concat([head, Buffer.from([0x55])]));
		p.push(Buffer.concat([head, Buffer.from([0x55, cc & 0xff, (cc >> 8) & 0xff])]));
		expect(frames.length).toBe(1);
		expect(frames[0].ok).toBe(false);
	});
});
