// Binary patch application with inverse ops (for undo). A patch is a list of
// ops applied in order, each seeing the result of the previous one:
//   {op: "poke",   offset, hex|base64}         overwrite (may extend past the end)
//   {op: "insert", offset, hex|base64}         insert bytes before offset
//   {op: "delete", offset, length}             remove bytes
//   {op: "fill",   offset, length, hex|base64}  repeat a pattern (default 00) over a range
// The input buffer is never modified.

const MAX_OPS = 10000;
const MAX_OP_BYTES = 64 * 1024 * 1024;
const MAX_SIZE = 256 * 1024 * 1024;
// undo data larger than this is dropped (the patch still applies)
const MAX_UNDO_BYTES = 16 * 1024 * 1024;

const OPS = ["poke", "insert", "delete", "fill"];

const integer = (value, what, max) => {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0 || n > max) {
		throw new Error(what + " must be an integer in 0…" + max + " (got " + value + ")");
	}
	return n;
};

/**
 * Data of an op: hex (whitespace allowed), base64, or a byte array.
 * @returns {Buffer|null}
 */
const dataOf = (op) => {
	let data = null;
	if (op.hex !== undefined) {
		const clean = String(op.hex).replace(/\s+/g, "");
		if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) {
			throw new Error(op.op + ": bad hex");
		}
		data = Buffer.from(clean, "hex");
	} else if (op.base64 !== undefined) {
		data = Buffer.from(String(op.base64), "base64");
	} else if (Array.isArray(op.bytes)) {
		data = Buffer.from(op.bytes.map((b) => integer(b, op.op + ": byte", 255)));
	}
	if (data && data.length > MAX_OP_BYTES) {
		throw new Error(op.op + ": more than " + MAX_OP_BYTES + " bytes");
	}
	return data;
};

const b64 = (buf) => buf.toString("base64");

/**
 * Apply one op to `buf` (a private copy, may be modified in place).
 * @returns {{buf: Buffer, inverse: Object[], undoBytes: number}}
 */
const applyOne = (buf, op) => {
	if (!op || OPS.indexOf(op.op) === -1) {
		throw new Error("unknown op: " + (op && op.op) + " (" + OPS.join(", ") + ")");
	}
	const offset = integer(op.offset, op.op + ": offset", buf.length);
	const data = dataOf(op);
	if (op.op === "poke") {
		if (!data || !data.length) {
			throw new Error("poke: no data");
		}
		const inPlace = Math.min(data.length, buf.length - offset);
		const old = Buffer.from(buf.subarray(offset, offset + inPlace));
		const inverse = [];
		let out = buf;
		if (inPlace < data.length) {
			out = Buffer.concat([buf, Buffer.alloc(data.length - inPlace)]);
			inverse.push({ op: "delete", offset: buf.length, length: data.length - inPlace });
		}
		data.copy(out, offset);
		if (inPlace) {
			inverse.push({ op: "poke", offset: offset, base64: b64(old) });
		}
		return { buf: out, inverse: inverse, undoBytes: old.length };
	}
	if (op.op === "insert") {
		if (!data || !data.length) {
			throw new Error("insert: no data");
		}
		return {
			buf: Buffer.concat([buf.subarray(0, offset), data, buf.subarray(offset)]),
			inverse: [{ op: "delete", offset: offset, length: data.length }],
			undoBytes: 0
		};
	}
	const length = integer(op.length, op.op + ": length", buf.length - offset);
	if (op.op === "delete") {
		const removed = Buffer.from(buf.subarray(offset, offset + length));
		return {
			buf: Buffer.concat([buf.subarray(0, offset), buf.subarray(offset + length)]),
			inverse: length ? [{ op: "insert", offset: offset, base64: b64(removed) }] : [],
			undoBytes: length
		};
	}
	// fill
	const pattern = data && data.length ? data : Buffer.from([0]);
	const old = Buffer.from(buf.subarray(offset, offset + length));
	buf.fill(pattern, offset, offset + length);
	return { buf: buf, inverse: length ? [{ op: "poke", offset: offset, base64: b64(old) }] : [], undoBytes: length };
};

/**
 * Apply ops to a copy of buf.
 * @param {Buffer} buf
 * @param {Object[]} ops
 * @returns {{data: Buffer, inverses: Object[][], undo: Object[]|null}} inverses[i] undoes ops[i]
 *   (applied to the result of ops[0..i]); undo undoes the whole patch (null if too large)
 */
const apply = (buf, ops) => {
	if (!Array.isArray(ops) || !ops.length) {
		throw new Error("ops must be a non-empty list");
	}
	if (ops.length > MAX_OPS) {
		throw new Error("more than " + MAX_OPS + " ops");
	}
	const start = { buf: Buffer.from(buf), inverses: [], undoBytes: 0 };
	const result = ops.reduce((acc, op, i) => {
		let r;
		try {
			r = applyOne(acc.buf, op);
		} catch (err) {
			throw new Error("op " + i + ": " + err.message, { cause: err });
		}
		if (r.buf.length > MAX_SIZE) {
			throw new Error("op " + i + ": blob would exceed " + MAX_SIZE + " bytes");
		}
		acc.buf = r.buf;
		acc.inverses.push(r.inverse);
		acc.undoBytes += r.undoBytes;
		return acc;
	}, start);
	let undo = null;
	if (result.undoBytes <= MAX_UNDO_BYTES) {
		undo = result.inverses.slice().reverse().reduce((acc, inv) => acc.concat(inv), []);
	}
	return { data: result.buf, inverses: result.undoBytes <= MAX_UNDO_BYTES ? result.inverses : null, undo: undo };
};

module.exports = {
	OPS: OPS,
	MAX_OPS: MAX_OPS,
	apply: apply
};
