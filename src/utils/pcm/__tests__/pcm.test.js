const pcm = require("..");

const int16 = (values) => {
	const buf = Buffer.alloc(values.length * 2);
	values.forEach((v, i) => {
		buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
	});
	return buf;
};

const sine = (n, amp) => int16(Array.from({ length: n }, (_v, i) => amp * 32767 * Math.sin(2 * Math.PI * i / 48)));

describe("levels", () => {
	test("full-scale sine: about -3 dBFS RMS, 0 dBFS peak", () => {
		const lv = pcm.levels(sine(4800, 1));
		expect(lv.rms).toBeCloseTo(-3.01, 1);
		expect(lv.peak).toBeCloseTo(0, 1);
	});

	test("-20 dB sine and silence", () => {
		expect(pcm.levels(sine(4800, 0.1)).rms).toBeCloseTo(-23.01, 1);
		expect(pcm.levels(int16([0, 0, 0, 0]))).toEqual({ rms: pcm.SILENCE_DB, peak: pcm.SILENCE_DB });
		expect(pcm.levels(Buffer.alloc(0)).rms).toBe(pcm.SILENCE_DB);
	});

	test("meter accumulates chunks and reports at most every interval", () => {
		const seen = [];
		const meter = pcm.levelMeter(100, (lv, t) => seen.push({ lv: lv, t: t }));
		meter(sine(480, 1), 1000);
		meter(int16(new Array(480).fill(0)), 1080);
		expect(seen.length).toBe(1);
		meter(int16(new Array(480).fill(16384)), 1100);
		expect(seen.length).toBe(2);
		// the second report covers the silent chunk and the half-scale DC chunk
		expect(seen[1].lv.peak).toBeCloseTo(-6.02, 1);
		expect(seen[1].lv.rms).toBeCloseTo(-9.03, 1);
	});
});

describe("isImage", () => {
	test("checks magic bytes against the mime type", () => {
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
		const webp = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
		expect(pcm.isImage(jpeg, "image/jpeg")).toBe(true);
		expect(pcm.isImage(png, "image/png")).toBe(true);
		expect(pcm.isImage(webp, "image/webp")).toBe(true);
		expect(pcm.isImage(png, "image/jpeg")).toBe(false);
		expect(pcm.isImage(Buffer.from("<svg/>"), "image/svg+xml")).toBe(false);
	});
});
