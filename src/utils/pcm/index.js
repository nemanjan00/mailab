// Little-endian int16 PCM helpers: levels (dBFS) and image/format sniffing for
// media pushed by browsers.

// floor for silence, so a level channel never holds -Infinity
const SILENCE_DB = -120;
const FULL_SCALE = 32768;

const toDb = (ratio) => {
	if (!(ratio > 0)) {
		return SILENCE_DB;
	}
	return Math.max(SILENCE_DB, 20 * Math.log10(ratio));
};

/**
 * Sum of squares and peak of an int16 LE buffer (all channels together).
 * @param {Buffer} buffer
 * @returns {{sumSquares: number, peak: number, count: number}} in full-scale units
 */
const measure = (buffer) => {
	const count = buffer.length >> 1;
	let sumSquares = 0;
	let peak = 0;
	for (let i = 0; i < count; i++) {
		const v = buffer.readInt16LE(i * 2) / FULL_SCALE;
		sumSquares += v * v;
		const a = Math.abs(v);
		if (a > peak) {
			peak = a;
		}
	}
	return { sumSquares: sumSquares, peak: peak, count: count };
};

/**
 * RMS and peak level of an int16 LE buffer in dBFS (a full-scale sine is about -3 dB RMS).
 * @param {Buffer} buffer
 * @returns {{rms: number, peak: number}}
 */
const levels = (buffer) => {
	const m = measure(buffer);
	return { rms: toDb(m.count ? Math.sqrt(m.sumSquares / m.count) : 0), peak: toDb(m.peak) };
};

/**
 * Accumulates levels over chunks and reports them at most every `intervalMs`
 * (a mic sends ~20 chunks/s; the level channel doesn't need all of them).
 * @param {number} intervalMs
 * @param {function({rms: number, peak: number}, number)} onLevel (levels, t)
 */
const levelMeter = (intervalMs, onLevel) => {
	let sumSquares = 0;
	let count = 0;
	let peak = 0;
	let last = 0;
	return (buffer, now) => {
		const t = now || Date.now();
		const m = measure(buffer);
		sumSquares += m.sumSquares;
		count += m.count;
		peak = Math.max(peak, m.peak);
		if (t - last < intervalMs || !count) {
			return;
		}
		last = t;
		onLevel({ rms: toDb(Math.sqrt(sumSquares / count)), peak: toDb(peak) }, t);
		sumSquares = 0;
		count = 0;
		peak = 0;
	};
};

// magic bytes of the image formats browsers may send
const IMAGE_MAGIC = {
	"image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
	"image/png": (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a,
	"image/webp": (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP"
};

/**
 * Does the buffer really hold an image of this mime type?
 */
const isImage = (buffer, mime) => {
	const check = IMAGE_MAGIC[mime];
	return Boolean(check) && check(buffer);
};

module.exports = {
	SILENCE_DB: SILENCE_DB,
	IMAGE_TYPES: Object.keys(IMAGE_MAGIC),
	levels: levels,
	levelMeter: levelMeter,
	isImage: isImage
};
