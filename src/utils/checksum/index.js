// Checksums over byte ranges: table-driven CRCs (Rocksoft model, parameters
// and check values from the reveng catalogue), Adler-32, byte / word sums,
// XOR, two's complement, internet checksum, md5/sha*, entropy and histogram.
// CRCs and sums are pure JS; hashes use node crypto (server side).

const nodeCrypto = require("crypto");
const zlib = require("zlib");

// name -> Rocksoft parameters; check = CRC of ASCII "123456789"
const CRCS = {
	"crc8": { width: 8, poly: 0x07, init: 0x00, refin: false, xorout: 0x00, check: 0xF4, alias: "CRC-8/SMBUS" },
	"crc8-maxim": { width: 8, poly: 0x31, init: 0x00, refin: true, xorout: 0x00, check: 0xA1, alias: "CRC-8/MAXIM-DOW (1-Wire)" },
	"crc8-autosar": { width: 8, poly: 0x2F, init: 0xFF, refin: false, xorout: 0xFF, check: 0xDF },
	"crc8-sae-j1850": { width: 8, poly: 0x1D, init: 0xFF, refin: false, xorout: 0xFF, check: 0x4B },
	"crc8-rohc": { width: 8, poly: 0x07, init: 0xFF, refin: true, xorout: 0x00, check: 0xD0 },
	"crc8-cdma2000": { width: 8, poly: 0x9B, init: 0xFF, refin: false, xorout: 0x00, check: 0xDA },
	"crc8-i-code": { width: 8, poly: 0x1D, init: 0xFD, refin: false, xorout: 0x00, check: 0x7E },
	"crc8-itu": { width: 8, poly: 0x07, init: 0x00, refin: false, xorout: 0x55, check: 0xA1, alias: "CRC-8/I-432-1" },
	"crc8-bluetooth": { width: 8, poly: 0xA7, init: 0x00, refin: true, xorout: 0x00, check: 0x26 },
	"crc16-ccitt-false": { width: 16, poly: 0x1021, init: 0xFFFF, refin: false, xorout: 0x0000, check: 0x29B1, alias: "CRC-16/IBM-3740" },
	"crc16-xmodem": { width: 16, poly: 0x1021, init: 0x0000, refin: false, xorout: 0x0000, check: 0x31C3 },
	"crc16-kermit": { width: 16, poly: 0x1021, init: 0x0000, refin: true, xorout: 0x0000, check: 0x2189 },
	"crc16-x25": { width: 16, poly: 0x1021, init: 0xFFFF, refin: true, xorout: 0xFFFF, check: 0x906E, alias: "CRC-16/IBM-SDLC" },
	"crc16-aug-ccitt": { width: 16, poly: 0x1021, init: 0x1D0F, refin: false, xorout: 0x0000, check: 0xE5CC, alias: "CRC-16/SPI-FUJITSU" },
	"crc16-genibus": { width: 16, poly: 0x1021, init: 0xFFFF, refin: false, xorout: 0xFFFF, check: 0xD64E },
	"crc16-modbus": { width: 16, poly: 0x8005, init: 0xFFFF, refin: true, xorout: 0x0000, check: 0x4B37 },
	"crc16-arc": { width: 16, poly: 0x8005, init: 0x0000, refin: true, xorout: 0x0000, check: 0xBB3D },
	"crc16-usb": { width: 16, poly: 0x8005, init: 0xFFFF, refin: true, xorout: 0xFFFF, check: 0xB4C8 },
	"crc16-maxim": { width: 16, poly: 0x8005, init: 0x0000, refin: true, xorout: 0xFFFF, check: 0x44C2 },
	"crc16-dnp": { width: 16, poly: 0x3D65, init: 0x0000, refin: true, xorout: 0xFFFF, check: 0xEA82 },
	"crc32": { width: 32, poly: 0x04C11DB7, init: 0xFFFFFFFF, refin: true, xorout: 0xFFFFFFFF, check: 0xCBF43926, alias: "CRC-32/ISO-HDLC (zip, ethernet)" },
	"crc32c": { width: 32, poly: 0x1EDC6F41, init: 0xFFFFFFFF, refin: true, xorout: 0xFFFFFFFF, check: 0xE3069283, alias: "CRC-32/ISCSI (Castagnoli)" },
	"crc32-bzip2": { width: 32, poly: 0x04C11DB7, init: 0xFFFFFFFF, refin: false, xorout: 0xFFFFFFFF, check: 0xFC891918 },
	"crc32-mpeg2": { width: 32, poly: 0x04C11DB7, init: 0xFFFFFFFF, refin: false, xorout: 0x00000000, check: 0x0376E6E7, alias: "STM32 CRC unit" },
	"crc32-jamcrc": { width: 32, poly: 0x04C11DB7, init: 0xFFFFFFFF, refin: true, xorout: 0x00000000, check: 0x340BC6D9 },
	"crc32-posix": { width: 32, poly: 0x04C11DB7, init: 0x00000000, refin: false, xorout: 0xFFFFFFFF, check: 0x765E7680, alias: "CRC-32/CKSUM (without length)" },
	"crc32-autosar": { width: 32, poly: 0xF4ACFB13, init: 0xFFFFFFFF, refin: true, xorout: 0xFFFFFFFF, check: 0x1697D06A }
};

const HASHES = ["md5", "sha1", "sha256", "sha512"];

/**
 * Non-CRC checksums: name -> {width (bits of the result), fn(bytes) -> number}.
 * Word sums take 16/32-bit words (zero-padded tail) and wrap at that width.
 */
const wordSum = (bytes, size, littleEndian) => {
	let sum = 0;
	for (let i = 0; i < bytes.length; i += size) {
		let word = 0;
		for (let k = 0; k < size; k++) {
			const b = i + k < bytes.length ? bytes[i + k] : 0;
			const shift = littleEndian ? 8 * k : 8 * (size - 1 - k);
			word += b * Math.pow(2, shift);
		}
		sum = (sum + word) % Math.pow(2, 8 * size);
	}
	return sum;
};

const byteSum = (bytes) => {
	let sum = 0;
	for (let i = 0; i < bytes.length; i++) {
		sum += bytes[i];
	}
	return sum;
};

const SUMS = {
	"sum8": { width: 8, fn: (bytes) => byteSum(bytes) % 0x100 },
	"sum16": { width: 16, fn: (bytes) => byteSum(bytes) % 0x10000 },
	"sum32": { width: 32, fn: (bytes) => byteSum(bytes) % 0x100000000 },
	"sum16-le-words": { width: 16, fn: (bytes) => wordSum(bytes, 2, true) },
	"sum16-be-words": { width: 16, fn: (bytes) => wordSum(bytes, 2, false) },
	"sum32-le-words": { width: 32, fn: (bytes) => wordSum(bytes, 4, true) },
	"sum32-be-words": { width: 32, fn: (bytes) => wordSum(bytes, 4, false) },
	"xor8": { width: 8, fn: (bytes) => bytes.reduce((acc, b) => acc ^ b, 0) },
	// value that makes the 8-bit sum (data + checksum) zero (Intel HEX, many headers)
	"twos8": { width: 8, fn: (bytes) => (0x100 - (byteSum(bytes) % 0x100)) % 0x100 },
	// RFC 1071 internet checksum: one's complement of the one's complement sum of BE words
	"inet16": { width: 16, fn: (bytes) => {
		let sum = 0;
		for (let i = 0; i < bytes.length; i += 2) {
			sum += (bytes[i] << 8) + (i + 1 < bytes.length ? bytes[i + 1] : 0);
			if (sum > 0xFFFF) {
				sum = (sum & 0xFFFF) + (sum >>> 16);
			}
		}
		return (~sum) & 0xFFFF;
	} },
	"adler32": { width: 32, fn: (bytes) => {
		let a = 1;
		let b = 0;
		// defer the modulo: 5552 is the largest n keeping b below 2^32 (zlib's NMAX)
		for (let i = 0; i < bytes.length; i += 5552) {
			const end = Math.min(bytes.length, i + 5552);
			for (let k = i; k < end; k++) {
				a += bytes[k];
				b += a;
			}
			a %= 65521;
			b %= 65521;
		}
		return (b * 65536 + a) >>> 0;
	} }
};

const reflect = (value, width) => {
	let out = 0;
	for (let i = 0; i < width; i++) {
		if (value & (1 << i)) {
			out |= 1 << (width - 1 - i);
		}
	}
	return out >>> 0;
};

const maskOf = (width) => (width === 32 ? 0xFFFFFFFF : (1 << width) - 1);

const tables = {};

// 256-entry table, reflected (LSB-first) or not (MSB-first)
const tableFor = (name) => {
	if (tables[name]) {
		return tables[name];
	}
	const p = CRCS[name];
	const mask = maskOf(p.width);
	const table = new Uint32Array(256);
	if (p.refin) {
		const poly = reflect(p.poly, p.width);
		for (let i = 0; i < 256; i++) {
			let r = i;
			for (let k = 0; k < 8; k++) {
				r = r & 1 ? (r >>> 1) ^ poly : r >>> 1;
			}
			table[i] = r >>> 0;
		}
	} else {
		const top = Math.pow(2, p.width - 1);
		for (let i = 0; i < 256; i++) {
			let r = (i * Math.pow(2, p.width - 8)) >>> 0;
			for (let k = 0; k < 8; k++) {
				r = (r >= top ? ((r << 1) ^ p.poly) : (r << 1)) & mask;
				r >>>= 0;
			}
			table[i] = r;
		}
	}
	tables[name] = table;
	return table;
};

/**
 * CRC of bytes with a catalogue algorithm.
 * @param {string} name key of CRCS
 * @param {Uint8Array} bytes
 * @returns {number}
 */
const crc = (name, bytes) => {
	const p = CRCS[name];
	if (!p) {
		throw new Error("unknown CRC: " + name);
	}
	// zlib's native crc32 is the same algorithm, much faster on big dumps
	if (name === "crc32" && typeof zlib.crc32 === "function") {
		return zlib.crc32(bytes) >>> 0;
	}
	const table = tableFor(name);
	const mask = maskOf(p.width);
	if (p.refin) {
		let r = reflect(p.init, p.width);
		for (let i = 0; i < bytes.length; i++) {
			r = (r >>> 8) ^ table[(r ^ bytes[i]) & 0xFF];
		}
		return ((r ^ p.xorout) & mask) >>> 0;
	}
	const shift = p.width - 8;
	let r = p.init >>> 0;
	for (let i = 0; i < bytes.length; i++) {
		r = (((r << 8) ^ table[((r >>> shift) ^ bytes[i]) & 0xFF]) & mask) >>> 0;
	}
	return ((r ^ p.xorout) & mask) >>> 0;
};

const ALGORITHMS = Object.keys(CRCS).concat(Object.keys(SUMS), HASHES, ["entropy", "histogram"]);

// a quick default: the ones people reach for first
const DEFAULT_ALGORITHMS = ["crc8", "crc16-ccitt-false", "crc16-xmodem", "crc16-modbus", "crc32", "crc32c", "crc32-mpeg2", "adler32",
	"sum8", "sum16", "sum32", "xor8", "twos8", "md5", "sha1", "sha256", "entropy"];

const hexOf = (value, width) => "0x" + value.toString(16).toUpperCase().padStart(Math.ceil(width / 4), "0");

const histogram = (bytes) => {
	const counts = new Array(256).fill(0);
	for (let i = 0; i < bytes.length; i++) {
		counts[bytes[i]]++;
	}
	return counts;
};

const entropyOf = (counts, n) => {
	if (!n) {
		return 0;
	}
	return counts.reduce((h, c) => {
		if (!c) {
			return h;
		}
		const p = c / n;
		return h - p * Math.log2(p);
	}, 0);
};

/**
 * One algorithm over bytes: {value, hex} for CRCs / sums, {hex} for hashes,
 * bits per byte for entropy, 256 counts for histogram.
 * @param {string} name
 * @param {Uint8Array} bytes
 */
const compute = (name, bytes) => {
	if (CRCS[name]) {
		const value = crc(name, bytes);
		return { value: value, hex: hexOf(value, CRCS[name].width) };
	}
	if (SUMS[name]) {
		const value = SUMS[name].fn(bytes);
		return { value: value, hex: hexOf(value, SUMS[name].width) };
	}
	if (HASHES.indexOf(name) !== -1) {
		return { hex: nodeCrypto.createHash(name).update(bytes).digest("hex") };
	}
	if (name === "entropy") {
		const value = entropyOf(histogram(bytes), bytes.length);
		return { value: Math.round(value * 10000) / 10000, unit: "bits/byte" };
	}
	if (name === "histogram") {
		return { counts: histogram(bytes) };
	}
	throw new Error("unknown algorithm: " + name + " (known: " + ALGORITHMS.join(", ") + ")");
};

/**
 * Several algorithms at once: name -> result.
 * @param {Uint8Array} bytes
 * @param {string[]|string} [algorithms] names, "all", or default set
 */
const run = (bytes, algorithms) => {
	let names = DEFAULT_ALGORITHMS;
	if (algorithms === "all") {
		names = ALGORITHMS;
	} else if (Array.isArray(algorithms) && algorithms.length) {
		names = algorithms;
	}
	return names.reduce((acc, name) => {
		acc[name] = compute(name, bytes);
		return acc;
	}, {});
};

/**
 * Algorithm catalogue (for UIs): [{name, kind, width, alias, params}].
 */
const catalogue = () => {
	return Object.keys(CRCS).map((name) => ({ name: name, kind: "crc", width: CRCS[name].width, alias: CRCS[name].alias || "",
		params: { poly: hexOf(CRCS[name].poly, CRCS[name].width), init: hexOf(CRCS[name].init, CRCS[name].width), refin: CRCS[name].refin, refout: CRCS[name].refin, xorout: hexOf(CRCS[name].xorout, CRCS[name].width) } }))
		.concat(Object.keys(SUMS).map((name) => ({ name: name, kind: "sum", width: SUMS[name].width })))
		.concat(HASHES.map((name) => ({ name: name, kind: "hash" })))
		.concat([{ name: "entropy", kind: "stat" }, { name: "histogram", kind: "stat" }]);
};

module.exports = {
	CRCS: CRCS,
	ALGORITHMS: ALGORITHMS,
	DEFAULT_ALGORITHMS: DEFAULT_ALGORITHMS,
	crc: crc,
	compute: compute,
	run: run,
	catalogue: catalogue
};
