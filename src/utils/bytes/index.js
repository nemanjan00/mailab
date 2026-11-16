// Byte helpers shared by the server and the browser (no Buffer, no node
// modules): typed reads / writes (u8…u64 as BigInt, f32/f64, LE/BE), hex
// parsing, search patterns with ?? wildcards, text encodings and "copy as"
// formats (hex, C array, Python bytes, base64). Works on any Uint8Array.

// type -> byte size; the suffix picks the byte order
const TYPES = {
	u8: 1, i8: 1,
	u16le: 2, u16be: 2, i16le: 2, i16be: 2,
	u32le: 4, u32be: 4, i32le: 4, i32be: 4,
	u64le: 8, u64be: 8, i64le: 8, i64be: 8,
	f32le: 4, f32be: 4, f64le: 8, f64be: 8
};

const GETTERS = { u8: "getUint8", i8: "getInt8", u16: "getUint16", i16: "getInt16", u32: "getUint32", i32: "getInt32",
	u64: "getBigUint64", i64: "getBigInt64", f32: "getFloat32", f64: "getFloat64" };

const FORMATS = ["hex", "hex-spaced", "c", "python", "base64", "escaped"];

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const MAX_PATTERN = 4096;

const splitType = (type) => {
	if (!TYPES[type]) {
		throw new Error("unknown type: " + type + " (known: " + Object.keys(TYPES).join(", ") + ")");
	}
	return { base: type.replace(/(le|be)$/, ""), little: !/be$/.test(type), size: TYPES[type] };
};

const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * Typed value at offset; 64-bit integers are BigInt. Throws past the end.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {string} type key of TYPES
 */
const read = (bytes, offset, type) => {
	const t = splitType(type);
	if (offset < 0 || offset + t.size > bytes.length) {
		throw new Error(type + " at " + offset + " runs past the end (" + bytes.length + " bytes)");
	}
	return viewOf(bytes)[GETTERS[t.base]](offset, t.little);
};

/**
 * Consecutive values of one type (a trailing partial value is dropped).
 */
const readArray = (bytes, type) => {
	const size = splitType(type).size;
	return Array.from({ length: Math.floor(bytes.length / size) }, (_, i) => read(bytes, i * size, type));
};

// "0x1f", "-5", "1e3", 12n -> BigInt (integers only)
const toBigInt = (value) => {
	if (typeof value === "bigint") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isInteger(value)) {
			throw new Error("not an integer: " + value);
		}
		return BigInt(value);
	}
	const text = String(value).trim().replace(/_/g, "");
	const m = /^(-?)(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)$/i.exec(text);
	if (!m) {
		throw new Error("not an integer: " + value);
	}
	const magnitude = BigInt(m[2]);
	return m[1] ? -magnitude : magnitude;
};

/**
 * Bytes of a typed value; integers are range-checked (no silent wrap).
 * @param {string} type
 * @param {number|string|bigint} value
 * @returns {Uint8Array}
 */
const encode = (type, value) => {
	const t = splitType(type);
	const out = new Uint8Array(t.size);
	const view = viewOf(out);
	const setter = GETTERS[t.base].replace("get", "set");
	if (t.base[0] === "f") {
		const num = Number(value);
		if (String(value).trim() === "" || Number.isNaN(num) && !/^\s*nan\s*$/i.test(String(value))) {
			throw new Error("not a number: " + value);
		}
		view[setter](0, num, t.little);
		return out;
	}
	const big = toBigInt(value);
	const bits = BigInt(8 * t.size);
	const signed = t.base[0] === "i";
	const min = signed ? -(1n << (bits - 1n)) : 0n;
	const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
	if (big < min || big > max) {
		throw new Error(value + " is out of range for " + type + " (" + min + " … " + max + ")");
	}
	if (t.size === 8) {
		view[setter](0, big, t.little);
	} else {
		view[setter](0, Number(big), t.little);
	}
	return out;
};

/**
 * Hex string (whitespace, "0x", ",", ":" and "\x" separators allowed) -> bytes.
 */
const parseHex = (text) => {
	const clean = String(text).replace(/0x|\\x/gi, "").replace(/[\s,:;-]/g, "");
	if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) {
		throw new Error("bad hex: " + String(text).slice(0, 40));
	}
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(clean.substr(i * 2, 2), 16);
	}
	return out;
};

const toHex = (bytes, separator) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(separator || "");

/**
 * Hex search pattern with "??" wildcards: {bytes, mask} (mask 1 = must match).
 * "de ad ?? ef", "dead??ef".
 */
const parsePattern = (text) => {
	const tokens = String(text).replace(/0x|\\x/gi, "").replace(/[\s,:;-]/g, "").match(/.{1,2}/g) || [];
	if (!tokens.length) {
		throw new Error("empty pattern");
	}
	if (tokens.length > MAX_PATTERN) {
		throw new Error("pattern longer than " + MAX_PATTERN + " bytes");
	}
	const bytes = new Uint8Array(tokens.length);
	const mask = new Uint8Array(tokens.length);
	tokens.forEach((tok, i) => {
		if (tok === "??") {
			return;
		}
		if (!/^[0-9a-f]{2}$/i.test(tok)) {
			throw new Error("bad pattern byte: " + tok + " (hex pairs or ??)");
		}
		bytes[i] = parseInt(tok, 16);
		mask[i] = 1;
	});
	return { bytes: bytes, mask: mask };
};

const latin1 = (text) => Uint8Array.from(Array.from(String(text)), (ch) => {
	const code = ch.charCodeAt(0);
	if (code > 0xFF) {
		throw new Error("character outside latin1: " + ch);
	}
	return code;
});

const utf16le = (text) => {
	const s = String(text);
	const out = new Uint8Array(s.length * 2);
	for (let i = 0; i < s.length; i++) {
		out[i * 2] = s.charCodeAt(i) & 0xFF;
		out[i * 2 + 1] = s.charCodeAt(i) >> 8;
	}
	return out;
};

/**
 * Text -> bytes in an encoding: ascii / latin1, utf8, utf16le.
 */
const encodeText = (text, encoding) => {
	const enc = (encoding || "ascii").toLowerCase().replace(/-/g, "");
	if (enc === "ascii" || enc === "latin1") {
		return latin1(text);
	}
	if (enc === "utf8") {
		return new TextEncoder().encode(String(text));
	}
	if (enc === "utf16le" || enc === "utf16") {
		return utf16le(text);
	}
	throw new Error("unknown encoding: " + encoding + " (ascii, utf8, utf16le)");
};

const base64 = (bytes) => {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
		out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
		out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : "=";
		out += i + 2 < bytes.length ? BASE64[n & 63] : "=";
	}
	return out;
};

const printable = (b) => b >= 0x20 && b < 0x7F;

/**
 * Bytes formatted for copying: hex, hex-spaced, c (array), python (bytes
 * literal), base64, escaped ("\x00ab").
 * @param {Uint8Array} bytes
 * @param {string} format
 * @param {{name: string, perLine: number}} [options]
 */
const format = (bytes, fmt, options) => {
	const opts = options || {};
	const perLine = opts.perLine || 16;
	if (fmt === "hex") {
		return toHex(bytes);
	}
	if (fmt === "hex-spaced") {
		return toHex(bytes, " ");
	}
	if (fmt === "base64") {
		return base64(bytes);
	}
	if (fmt === "c") {
		const lines = [];
		for (let i = 0; i < bytes.length; i += perLine) {
			lines.push("\t" + Array.from(bytes.subarray(i, i + perLine), (b) => "0x" + b.toString(16).padStart(2, "0")).join(", "));
		}
		return "const unsigned char " + (opts.name || "data") + "[" + bytes.length + "] = {\n" + lines.join(",\n") + "\n};";
	}
	if (fmt === "python" || fmt === "escaped") {
		const body = Array.from(bytes, (b) => {
			if (fmt === "python" && printable(b) && b !== 0x5C && b !== 0x22) {
				return String.fromCharCode(b);
			}
			return "\\x" + b.toString(16).padStart(2, "0");
		}).join("");
		return fmt === "python" ? "b\"" + body + "\"" : body;
	}
	throw new Error("unknown format: " + fmt + " (" + FORMATS.join(", ") + ")");
};

/**
 * Everything a data inspector shows for the bytes at offset (missing = past end).
 * @returns {Object} type -> value (BigInt for 64-bit), plus bits, ascii, utf8, utf16le, unix32/unix64
 */
const inspect = (bytes, offset) => {
	const out = {};
	Object.keys(TYPES).forEach((type) => {
		if (offset + TYPES[type] <= bytes.length) {
			out[type] = read(bytes, offset, type);
		}
	});
	if (offset < bytes.length) {
		const b = bytes[offset];
		out.bits = b.toString(2).padStart(8, "0");
		out.ascii = printable(b) ? String.fromCharCode(b) : "";
		// one UTF-8 sequence (fatal decoder: invalid sequences show nothing)
		const lead = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
		try {
			out.utf8 = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + lead));
		} catch (_err) {
			out.utf8 = "";
		}
		if (offset + 2 <= bytes.length) {
			out.utf16le = String.fromCharCode(bytes[offset] | (bytes[offset + 1] << 8));
		}
	}
	if (out.u32le !== undefined) {
		out.unix32le = new Date(out.u32le * 1000).toISOString();
		out.unix32be = new Date(out.u32be * 1000).toISOString();
	}
	return out;
};

module.exports = {
	TYPES: TYPES,
	FORMATS: FORMATS,
	read: read,
	readArray: readArray,
	encode: encode,
	toBigInt: toBigInt,
	parseHex: parseHex,
	toHex: toHex,
	parsePattern: parsePattern,
	encodeText: encodeText,
	base64: base64,
	format: format,
	inspect: inspect
};
