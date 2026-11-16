const mjpeg = require("..");

const jpegs = [Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]), Buffer.from("--fra not a boundary \r\n-- \xff\xd9", "latin1"), Buffer.alloc(300, 7)];

const stream = (parts) => Buffer.concat(parts.map((j) => mjpeg.part("frame", j)));

describe("MJPEG multipart parser", () => {
	test("boundary from the Content-Type", () => {
		expect(mjpeg.boundaryOf("multipart/x-mixed-replace; boundary=frame")).toBe("frame");
		expect(mjpeg.boundaryOf("multipart/x-mixed-replace;boundary=\"--myb\"")).toBe("myb");
		expect(mjpeg.boundaryOf("image/jpeg")).toBe(null);
	});

	test("frames by Content-Length, with the stream split at every possible point", () => {
		const all = stream(jpegs);
		Array.from({ length: all.length - 1 }, (_, i) => i + 1).forEach((cut) => {
			const got = [];
			const p = mjpeg.createParser("frame", (body) => got.push(body));
			p.push(all.subarray(0, cut));
			p.push(all.subarray(cut));
			expect(got).toEqual(jpegs);
		});
	});

	test("byte-at-a-time, leading garbage, headers in any case", () => {
		const got = [];
		const p = mjpeg.createParser("frame", (body, headers) => got.push({ body: body, type: headers["content-type"] }));
		const data = Buffer.concat([Buffer.from("junk\r\n"), stream(jpegs)]);
		Array.from(data).forEach((b) => p.push(Buffer.from([b])));
		expect(got.map((g) => g.body)).toEqual(jpegs);
		expect(got[0].type).toBe("image/jpeg");
		expect(p.frames()).toBe(3);
	});

	test("parts without Content-Length end at the next boundary", () => {
		const raw = Buffer.concat(jpegs.slice(0, 2).map((j) => Buffer.concat([Buffer.from("--b\r\nContent-Type: image/jpeg\r\n\r\n"), j, Buffer.from("\r\n")])).concat([Buffer.from("--b\r\n")]));
		const got = [];
		const p = mjpeg.createParser("b", (body) => got.push(body));
		p.push(raw.subarray(0, 10));
		p.push(raw.subarray(10, 40));
		p.push(raw.subarray(40));
		expect(got).toEqual(jpegs.slice(0, 2));
	});

	test("oversized frames are refused", () => {
		const p = mjpeg.createParser("frame", () => null, { maxFrameBytes: 100 });
		expect(() => p.push(mjpeg.part("frame", Buffer.alloc(200)))).toThrow(/too large/);
	});
});
