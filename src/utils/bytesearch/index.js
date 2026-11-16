// Search inside binary buffers: hex patterns with ?? wildcards, text in an
// encoding (optionally case-insensitive), and JavaScript regexes over the
// latin1 view (one char per byte, so match offsets are byte offsets).
// Hits never overlap. Directions: "next" (first hit at or after `from`),
// "prev" (last hit starting before `from`), "all" (every hit in the range).

const bytes = require("../bytes");

const MAX_HITS = 10000;
const DEFAULT_MAX = 1000;
const MAX_REGEX = 512;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile a search spec into a matcher.
 * @param {Object} spec {hex} | {text, encoding, ignoreCase} | {regex, flags}
 * @returns {{kind: string, pattern: Buffer, mask: Uint8Array, regex: RegExp}}
 */
const compile = (spec) => {
	const s = spec || {};
	if (s.hex !== undefined && s.hex !== "") {
		const p = bytes.parsePattern(s.hex);
		return { kind: "pattern", pattern: Buffer.from(p.bytes), mask: p.mask };
	}
	if (s.text !== undefined && s.text !== "") {
		const encoded = Buffer.from(bytes.encodeText(s.text, s.encoding));
		if (s.ignoreCase) {
			// byte-wise regex over latin1: case folds ASCII letters only
			const source = escapeRegex(encoded.toString("latin1"));
			return { kind: "regex", regex: new RegExp(source, "gi") };
		}
		return { kind: "pattern", pattern: encoded, mask: new Uint8Array(encoded.length).fill(1) };
	}
	if (s.regex !== undefined && s.regex !== "") {
		if (String(s.regex).length > MAX_REGEX) {
			throw new Error("regex longer than " + MAX_REGEX + " characters");
		}
		const flags = String(s.flags || "").replace(/[^imsu]/g, "");
		return { kind: "regex", regex: new RegExp(s.regex, "g" + flags) };
	}
	throw new Error("give hex, text or regex");
};

// longest run of fixed bytes: what indexOf looks for before checking the rest
const anchorOf = (pattern, mask) => {
	let best = { at: 0, length: 0 };
	let start = -1;
	for (let i = 0; i <= mask.length; i++) {
		if (i < mask.length && mask[i]) {
			if (start < 0) {
				start = i;
			}
		} else if (start >= 0) {
			if (i - start > best.length) {
				best = { at: start, length: i - start };
			}
			start = -1;
		}
	}
	return { at: best.at, bytes: pattern.subarray(best.at, best.at + best.length) };
};

const matchesAt = (buf, pos, m) => {
	for (let k = 0; k < m.pattern.length; k++) {
		if (m.mask[k] && buf[pos + k] !== m.pattern[k]) {
			return false;
		}
	}
	return true;
};

/**
 * First pattern hit starting in [from, end - length], or -1.
 */
const findForward = (buf, m, from, end) => {
	const len = m.pattern.length;
	const anchor = m.anchor || (m.anchor = anchorOf(m.pattern, m.mask));
	if (!anchor.bytes.length) {
		// all wildcards: every position matches
		return from + len <= end ? from : -1;
	}
	let at = buf.indexOf(anchor.bytes, from + anchor.at);
	while (at !== -1) {
		const pos = at - anchor.at;
		if (pos + len > end) {
			return -1;
		}
		if (matchesAt(buf, pos, m)) {
			return pos;
		}
		at = buf.indexOf(anchor.bytes, at + 1);
	}
	return -1;
};

/**
 * Last pattern hit starting in [start, before), or -1.
 */
const findBackward = (buf, m, start, before, end) => {
	const len = m.pattern.length;
	const anchor = m.anchor || (m.anchor = anchorOf(m.pattern, m.mask));
	const last = Math.min(before - 1, end - len);
	if (last < start) {
		return -1;
	}
	if (!anchor.bytes.length) {
		return last;
	}
	let at = buf.lastIndexOf(anchor.bytes, last + anchor.at);
	while (at !== -1) {
		const pos = at - anchor.at;
		if (pos < start) {
			return -1;
		}
		if (pos <= last && matchesAt(buf, pos, m)) {
			return pos;
		}
		at = at > 0 ? buf.lastIndexOf(anchor.bytes, at - 1) : -1;
	}
	return -1;
};

/**
 * Search a buffer.
 * @param {Buffer} buf
 * @param {Object} spec see compile()
 * @param {Object} [options]
 * @param {string} [options.dir] "all" (default), "next", "prev"
 * @param {number} [options.from] next: first offset to consider; prev: hits start before it
 * @param {number} [options.start] range start (default 0)
 * @param {number} [options.end] range end, exclusive (default buffer length)
 * @param {number} [options.max] most hits for "all" (default 1000, cap 10000)
 * @param {boolean} [options.wrap] next/prev wrap around the range
 * @returns {{hits: {offset: number, length: number}[], truncated: boolean}}
 */
const search = (buf, spec, options) => {
	const opts = options || {};
	const m = compile(spec);
	const start = Math.max(0, Math.min(buf.length, Number(opts.start) || 0));
	const end = Math.max(start, Math.min(buf.length, opts.end === undefined ? buf.length : Number(opts.end)));
	const dir = opts.dir || "all";
	const max = Math.max(1, Math.min(MAX_HITS, Number(opts.max) || DEFAULT_MAX));
	let from = opts.from === undefined ? start : Number(opts.from);
	if (!Number.isFinite(from)) {
		from = start;
	}

	if (m.kind === "regex") {
		const text = buf.toString("latin1", start, end);
		// non-overlapping hits from `at` (relative), up to `limit`
		const scan = (at, limit, stopBefore) => {
			const hits = [];
			m.regex.lastIndex = at;
			let r = m.regex.exec(text);
			while (r) {
				if (stopBefore !== undefined && r.index >= stopBefore) {
					break;
				}
				if (r[0].length) {
					hits.push({ offset: start + r.index, length: r[0].length });
					if (hits.length > limit) {
						break;
					}
				} else {
					m.regex.lastIndex++;
				}
				r = m.regex.exec(text);
			}
			return hits;
		};
		if (dir === "next") {
			let hits = scan(Math.max(0, from - start), 1);
			if (!hits.length && opts.wrap) {
				hits = scan(0, 1);
			}
			return { hits: hits.slice(0, 1), truncated: false };
		}
		if (dir === "prev") {
			let hits = scan(0, Infinity, from - start);
			if (!hits.length && opts.wrap) {
				hits = scan(0, Infinity);
			}
			return { hits: hits.slice(-1), truncated: false };
		}
		const hits = scan(0, max);
		return { hits: hits.slice(0, max), truncated: hits.length > max };
	}

	const len = m.pattern.length;
	if (dir === "next") {
		let pos = findForward(buf, m, Math.max(start, from), end);
		if (pos === -1 && opts.wrap) {
			pos = findForward(buf, m, start, end);
		}
		return { hits: pos === -1 ? [] : [{ offset: pos, length: len }], truncated: false };
	}
	if (dir === "prev") {
		let pos = findBackward(buf, m, start, Math.min(end, from), end);
		if (pos === -1 && opts.wrap) {
			pos = findBackward(buf, m, start, end, end);
		}
		return { hits: pos === -1 ? [] : [{ offset: pos, length: len }], truncated: false };
	}
	const hits = [];
	let pos = findForward(buf, m, start, end);
	while (pos !== -1 && hits.length <= max) {
		hits.push({ offset: pos, length: len });
		pos = findForward(buf, m, pos + len, end);
	}
	return { hits: hits.slice(0, max), truncated: hits.length > max };
};

module.exports = {
	MAX_HITS: MAX_HITS,
	compile: compile,
	search: search
};
