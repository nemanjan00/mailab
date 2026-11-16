// Parse text lines from instruments into {field: number} readings.
//  kv:     "v=3.30 i:0.120"     -> {v: 3.3, i: 0.12}
//  csv:    "3.30,0.120"         -> {<fields[0]>: 3.3, <fields[1]>: 0.12} (or c0, c1 ...)
//  number: "3.30"               -> {value: 3.3}
//  raw:    nothing, lines only go to the log

const KV_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(-?[0-9.]+(?:[eE][-+]?[0-9]+)?)/g;

const toNumber = (text) => {
	const n = Number(String(text).trim());
	if (String(text).trim() === "" || Number.isNaN(n)) {
		return null;
	}
	return n;
};

const PARSERS = {
	kv: (line) => {
		const out = {};
		Array.from(line.matchAll(KV_RE)).forEach((match) => {
			out[match[1]] = Number(match[2]);
		});
		return out;
	},

	csv: (line, fields) => {
		const out = {};
		line.split(/[,;\t]/).forEach((cell, i) => {
			const n = toNumber(cell);
			if (n !== null) {
				out[(fields && fields[i]) || "c" + i] = n;
			}
		});
		return out;
	},

	number: (line) => {
		const n = toNumber(line);
		if (n === null) {
			return {};
		}
		return { value: n };
	},

	raw: () => {
		return {};
	}
};

/**
 * @param {string} parser kv | csv | number | raw
 * @param {string} line
 * @param {string[]} [fields] csv column names
 * @returns {Object} field -> number
 */
const parse = (parser, line, fields) => {
	const fn = PARSERS[parser];
	if (!fn) {
		throw new Error("unknown parser: " + parser);
	}
	return fn(line, fields);
};

module.exports = {
	parse: parse,
	PARSERS: Object.keys(PARSERS)
};
