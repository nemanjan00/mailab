// Hex-editor operations on lab blobs, shared by REST and MCP: ranged reads
// (peek), typed pokes, patches (poke/insert/delete/fill with undo),
// search / replace, checksums, slices and next/prev change between two blobs.

const bytes = require("../../utils/bytes");
const patch = require("../../utils/patch");
const bytesearch = require("../../utils/bytesearch");
const checksum = require("../../utils/checksum");

const MAX_RANGE = 1024 * 1024;
const MAX_PEEK = 65536;
const DEFAULT_PEEK = 256;
const MAX_REPLACE = 10000;
const CHUNK = 4096;
const PEEK_TEXT = ["hex", "base64", "ascii", "latin1", "utf8", "utf16le", "bin"];

const integer = (value, what, min, max) => {
	const n = Number(value);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new Error(what + " must be an integer in " + min + "…" + max + " (got " + value + ")");
	}
	return n;
};

/**
 * Offset / length inside a blob of `size` bytes; length defaults to the rest, capped.
 */
const span = (size, offset, length, cap) => {
	const start = offset === undefined ? 0 : integer(offset, "offset", 0, size);
	let len = size - start;
	if (length !== undefined && length !== null) {
		len = Math.min(integer(length, "length", 0, Number.MAX_SAFE_INTEGER), size - start);
	}
	if (cap !== undefined && len > cap) {
		throw new Error("length " + len + " exceeds the limit of " + cap + " bytes");
	}
	return { start: start, end: start + len, length: len };
};

const blobData = (lab, name) => lab.getBlob(name).data;

/**
 * Raw bytes of a range (for the UI's paged view).
 * @returns {{size: number, offset: number, data: Buffer}}
 */
const range = (lab, name, offset, length) => {
	const data = blobData(lab, name);
	const s = span(data.length, offset, Math.min(length === undefined ? MAX_RANGE : Number(length), MAX_RANGE));
	return { size: data.length, offset: s.start, data: data.subarray(s.start, s.end) };
};

// JSON-safe typed values (BigInt -> string)
const jsonValue = (v) => (typeof v === "bigint" ? v.toString() : v);

/**
 * Read part of a blob in a format: hex, base64, ascii, utf8, utf16le, bin, or a
 * type (u8, u16le, u32be, i64le, f32le, f64be…) giving an array of values.
 * @param {Object} lab
 * @param {{name: string, offset: number, length: number, as: string}} a
 */
const peek = (lab, a) => {
	const data = blobData(lab, a.name);
	const as = a.as || "hex";
	const wanted = a.length === undefined ? DEFAULT_PEEK : Number(a.length);
	const s = span(data.length, a.offset, Math.min(wanted, MAX_PEEK));
	const part = data.subarray(s.start, s.end);
	let value;
	if (as === "hex") {
		value = part.toString("hex");
	} else if (as === "base64") {
		value = part.toString("base64");
	} else if (as === "ascii") {
		value = Array.from(part, (b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : ".")).join("");
	} else if (as === "latin1" || as === "utf8" || as === "utf16le") {
		value = part.toString(as);
	} else if (as === "bin") {
		value = Array.from(part, (b) => b.toString(2).padStart(8, "0")).join(" ");
	} else if (bytes.TYPES[as]) {
		value = bytes.readArray(part, as).map(jsonValue);
	} else {
		throw new Error("unknown format: " + as + " (" + PEEK_TEXT.concat(Object.keys(bytes.TYPES)).join(", ") + ")");
	}
	return { name: a.name, size: data.length, offset: s.start, length: s.length, truncated: wanted > MAX_PEEK, as: as, value: value };
};

/**
 * Apply a patch and store the result.
 * @param {Object} lab
 * @param {{name: string, ops: Object[]}} a
 * @param {string} source "ui" / "ai"
 * @returns {{name: string, size: number, undo: Object[]|null, inverses: Object[][]|null}}
 */
const applyPatch = (lab, a, source) => {
	const data = blobData(lab, a.name);
	const r = patch.apply(data, a.ops);
	lab.setBlob(a.name, r.data, source || "edit");
	return { name: a.name, size: r.data.length, ops: a.ops.length, undo: r.undo, inverses: r.inverses };
};

/**
 * Overwrite bytes at offset: {hex} / {base64}, or {value, type} encoded with
 * the type's size and byte order (u8…u64, i8…i64, f32, f64; le/be).
 */
const poke = (lab, a, source) => {
	let data;
	if (a.hex !== undefined) {
		data = Buffer.from(bytes.parseHex(a.hex));
	} else if (a.base64 !== undefined) {
		data = Buffer.from(a.base64, "base64");
	} else if (a.value !== undefined && a.type) {
		data = Buffer.from(bytes.encode(a.type, a.value));
	} else {
		throw new Error("give hex, base64, or value + type");
	}
	const r = applyPatch(lab, { name: a.name, ops: [{ op: "poke", offset: a.offset, base64: data.toString("base64") }] }, source);
	return Object.assign(r, { offset: a.offset, written: data.toString("hex") });
};

const searchSpec = (a) => ({ hex: a.hex, text: a.text, encoding: a.encoding, ignoreCase: a.ignoreCase, regex: a.regex, flags: a.flags });

/**
 * Search a blob (see utils/bytesearch for the spec and options).
 */
const search = (lab, a) => {
	const data = blobData(lab, a.name);
	const r = bytesearch.search(data, searchSpec(a), { dir: a.dir, from: a.from, start: a.start, end: a.end, max: a.max, wrap: a.wrap });
	return { name: a.name, size: data.length, hits: r.hits, count: r.hits.length, truncated: r.truncated };
};

// replacement bytes for one hit: ?? in a hex replacement keeps the matched byte
const replacementFor = (rep, data, hit) => {
	if (rep.hex !== undefined) {
		const p = bytes.parsePattern(rep.hex);
		return Buffer.from(Array.from(p.bytes, (b, k) => {
			if (p.mask[k]) {
				return b;
			}
			if (k >= hit.length) {
				throw new Error("?? at replacement byte " + k + " is past the match (" + hit.length + " bytes)");
			}
			return data[hit.offset + k];
		}));
	}
	if (rep.text !== undefined) {
		return Buffer.from(bytes.encodeText(rep.text, rep.encoding));
	}
	if (rep.base64 !== undefined) {
		return Buffer.from(rep.base64, "base64");
	}
	return Buffer.alloc(0);
};

/**
 * Replace the next hit at/after `from` or (all) every hit in [start, end).
 * @param {Object} lab
 * @param {{name: string, find: Object, replace: Object, all: boolean, from: number, start: number, end: number, max: number}} a
 *   find: {hex|text|regex, encoding, ignoreCase, flags}; replace: {hex (?? keeps the byte) | text, encoding | base64}
 */
const replace = (lab, a, source) => {
	const data = blobData(lab, a.name);
	const find = typeof a.find === "string" ? { hex: a.find } : (a.find || {});
	const rep = typeof a.replace === "string" ? { hex: a.replace } : (a.replace || {});
	const opts = { start: a.start, end: a.end, from: a.from, wrap: a.wrap };
	const r = bytesearch.search(data, find, Object.assign(opts, a.all ? { dir: "all", max: Math.min(Number(a.max) || MAX_REPLACE, MAX_REPLACE) } : { dir: "next" }));
	if (!r.hits.length) {
		return { name: a.name, size: data.length, replaced: 0, hits: [], undo: [] };
	}
	// last hit first so earlier offsets stay valid
	const ops = r.hits.slice().reverse().reduce((acc, hit) => {
		const with_ = replacementFor(rep, data, hit);
		if (with_.length === hit.length) {
			return acc.concat([{ op: "poke", offset: hit.offset, base64: with_.toString("base64") }]);
		}
		const del = [{ op: "delete", offset: hit.offset, length: hit.length }];
		return acc.concat(with_.length ? del.concat([{ op: "insert", offset: hit.offset, base64: with_.toString("base64") }]) : del);
	}, []);
	const out = applyPatch(lab, { name: a.name, ops: ops }, source);
	return { name: a.name, size: out.size, replaced: r.hits.length, truncated: r.truncated, hits: r.hits.slice(0, 100), undo: out.undo };
};

/**
 * Checksums / hashes over a range (default: whole blob, default algorithms).
 */
const checksumOf = (lab, a) => {
	const data = blobData(lab, a.name);
	const s = span(data.length, a.offset, a.length);
	let algorithms = a.algorithms;
	if (typeof algorithms === "string" && algorithms !== "all") {
		algorithms = algorithms.split(",").map((x) => x.trim()).filter(Boolean);
	}
	return { name: a.name, offset: s.start, length: s.length, results: checksum.run(data.subarray(s.start, s.end), algorithms) };
};

/**
 * Copy a range into another blob (a whole copy = "save as").
 */
const slice = (lab, a, source) => {
	if (!a.to) {
		throw new Error("give `to` (new blob name)");
	}
	const data = blobData(lab, a.name);
	const s = span(data.length, a.offset, a.length);
	lab.setBlob(a.to, Buffer.from(data.subarray(s.start, s.end)), source || "edit");
	return { name: a.to, from: a.name, offset: s.start, bytes: s.length };
};

const differs = (a, b, i) => i >= a.length || i >= b.length || a[i] !== b[i];

/**
 * Next (first starting at/after from) or prev (last starting before from)
 * contiguous changed range between two buffers, or null.
 */
const findChange = (a, b, from, dir) => {
	const n = Math.max(a.length, b.length);
	const common = Math.min(a.length, b.length);
	if (dir === "prev") {
		let i = Math.min(Number(from), n) - 1;
		// skip equal chunks backwards
		while (i >= 0 && !differs(a, b, i)) {
			if (i < common && i - CHUNK >= 0 && a.compare(b, i - CHUNK, i, i - CHUNK, i) === 0) {
				i -= CHUNK;
			} else {
				i--;
			}
		}
		if (i < 0) {
			return null;
		}
		const end = i + 1;
		while (i > 0 && differs(a, b, i - 1)) {
			i--;
		}
		return { start: i, end: end };
	}
	let i = Math.max(0, Number(from) || 0);
	while (i < n && !differs(a, b, i)) {
		if (i + CHUNK <= common && a.compare(b, i, i + CHUNK, i, i + CHUNK) === 0) {
			i += CHUNK;
		} else {
			i++;
		}
	}
	if (i >= n) {
		return null;
	}
	const start = i;
	while (i < n && differs(a, b, i)) {
		i++;
	}
	return { start: start, end: i };
};

const change = (lab, a) => {
	const r = findChange(blobData(lab, a.a), blobData(lab, a.b), a.from || 0, a.dir === "prev" ? "prev" : "next");
	return { a: a.a, b: a.b, change: r };
};

module.exports = {
	MAX_RANGE: MAX_RANGE,
	MAX_PEEK: MAX_PEEK,
	range: range,
	peek: peek,
	patch: applyPatch,
	poke: poke,
	search: search,
	replace: replace,
	checksum: checksumOf,
	slice: slice,
	findChange: findChange,
	change: change
};
