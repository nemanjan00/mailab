// Table view logic shared by the web UI's SDK table: numeric-aware sorting
// (plain numbers and engineering notation like "1.2 k", "-381.042 mV"),
// natural string order, filter matching ("text", "col:text") and CSV / JSON
// serialization of the visible rows. Plain CommonJS so jest loads it and
// esbuild bundles it into the web UI.

const units = require("../units");

// prefix spellings seen in cells; µ (U+00B5) is canonical
const PREFIX_ALIASES = { u: "µ", "μ": "µ", K: "k" };

// femto isn't a keypad unit but shows up in measurements
const EXTRA_PREFIXES = { f: -15 };

// suffixes whose first letter only looks like a prefix
const NOT_PREFIXED = ["min", "mol", "mil", "mi", "pts", "pt", "px", "ppm", "ppb", "Torr", "T"];

// a number, optional exponent, then an optional suffix (prefix + unit)
const NUMBER = /^([+\-−]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(\S*)$/i;

// what may follow a number: a unit, optionally prefixed ("mV", "kHz", "%")
const UNIT = /^[A-Za-zµμΩ°%/²³]*$/;

// hex offsets / addresses ("0x1f00")
const HEX = /^0x[0-9a-f]+$/i;

// filter tokens: words, quoted phrases, col:"quoted phrase"
const TOKEN = /(?:[^\s"]+|"[^"]*")+/g;

// placeholder text cells that mean "no value"
const BLANKS = ["", "—", "-", "–"];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const prefixPower = (letter) => {
	const canonical = PREFIX_ALIASES[letter] || letter;
	if (EXTRA_PREFIXES[canonical] !== undefined) {
		return EXTRA_PREFIXES[canonical];
	}
	return units.PREFIXES[canonical];
};

// power of ten a suffix ("mV", "k", "GHz", "dBm") stands for; 0 = none
const suffixPower = (suffix) => {
	if (!suffix || NOT_PREFIXED.includes(suffix)) {
		return 0;
	}
	const power = prefixPower(suffix[0]);
	if (power === undefined) {
		return 0;
	}
	return power;
};

/**
 * Text of a raw cell value, for filtering and CSV: objects as JSON.
 */
const text = (value) => {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "object") {
		return JSON.stringify(value);
	}
	return String(value);
};

/**
 * Numeric value of a cell: numbers as-is, strings parsed as plain or
 * engineering notation ("1.2 k" -> 1200, "-381.042 mV" -> -0.381042,
 * "2.4 GHz" -> 2.4e9). NaN when it isn't a number.
 * @param {*} value
 */
const toNumber = (value) => {
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "boolean") {
		return value ? 1 : 0;
	}
	if (typeof value !== "string") {
		return NaN;
	}
	const trimmed = value.trim();
	if (HEX.test(trimmed)) {
		return parseInt(trimmed, 16);
	}
	const match = NUMBER.exec(trimmed);
	// "12:30", "1.2.3", "10.0.0.1" aren't numbers
	if (!match || !UNIT.test(match[2])) {
		return NaN;
	}
	const parts = match[1].replace("−", "-").split(/e/i);
	return Number(parts[0] + "e" + (Number(parts[1] || 0) + suffixPower(match[2])));
};

/**
 * Cells that sort last whichever way: nothing, NaN, "", "—" (eng() of no value).
 * @param {*} value
 */
const isBlank = (value) => {
	if (value === null || value === undefined) {
		return true;
	}
	if (typeof value === "number") {
		return Number.isNaN(value);
	}
	return BLANKS.includes(text(value).trim());
};

/**
 * Ascending order of two non-blank cells: numbers by value before strings,
 * strings in natural order ("ch2" < "ch10"), case-insensitive.
 */
const compare = (a, b) => {
	const x = toNumber(a);
	const y = toNumber(b);
	const xNum = !Number.isNaN(x);
	const yNum = !Number.isNaN(y);
	if (xNum && yNum) {
		return x - y;
	}
	if (xNum !== yNum) {
		return xNum ? -1 : 1;
	}
	return collator.compare(text(a), text(b));
};

const unquote = (token) => token.replace(/"/g, "");

/**
 * Parse filter text into AND-ed, case-insensitive terms. "col:text" limits a
 * term to the column whose title is (or starts with) col; an unknown column
 * makes the whole token a plain term (so "12:30" still matches a time).
 * @param {string} input
 * @param {Array<string>} titles column titles
 * @returns {Array<{column: number, text: string}>} column -1 = any
 */
const parseFilter = (input, titles) => {
	const lower = (titles || []).map((t) => String(t || "").toLowerCase());
	const tokens = String(input || "").match(TOKEN) || [];
	return tokens.map((token) => {
		const colon = token.indexOf(":");
		if (colon > 0) {
			const name = unquote(token.slice(0, colon)).toLowerCase();
			let column = lower.indexOf(name);
			if (column === -1) {
				column = lower.findIndex((t) => t !== "" && t.startsWith(name));
			}
			if (column !== -1) {
				return { column: column, text: unquote(token.slice(colon + 1)).toLowerCase() };
			}
		}
		return { column: -1, text: unquote(token).toLowerCase() };
	}).filter((term) => term.text !== "");
};

/**
 * Does a row match every term?
 * @param {Array<string>} cells searchable text per column
 * @param {Array<{column: number, text: string}>} terms from parseFilter
 */
const matches = (cells, terms) => {
	const lower = cells.map((c) => text(c).toLowerCase());
	return terms.every((term) => {
		if (term.column >= 0) {
			return (lower[term.column] || "").includes(term.text);
		}
		return lower.some((c) => c.includes(term.text));
	});
};

/**
 * Filter and sort rows. Blank sort cells stay last in both directions; ties
 * keep their original order.
 * @param {Array} rows
 * @param {Array<{title: string, raw: function(*): *, text: function(*): string}>} columns
 *   raw: value to sort / export; text (optional): what the cell shows, also searched
 * @param {{filter: string, sort: number, dir: number}} options sort = column index
 *   (-1 = none), dir 1 ascending / -1 descending / 0 unsorted
 * @returns {Array} the visible rows
 */
const view = (rows, columns, options) => {
	const terms = parseFilter(options.filter, columns.map((c) => c.title));
	let visible = rows;
	if (terms.length) {
		visible = rows.filter((row) => matches(columns.map((c) => {
			const raw = text(c.raw(row));
			const shown = c.text ? c.text(row) : raw;
			if (shown === raw) {
				return raw;
			}
			return raw + "\u0000" + shown;
		}), terms));
	}
	const column = columns[options.sort];
	if (!column || !options.dir) {
		return visible;
	}
	return visible
		.map((row, index) => ({ row: row, index: index, key: column.raw(row) }))
		.sort((a, b) => {
			const aBlank = isBlank(a.key);
			const bBlank = isBlank(b.key);
			if (aBlank || bBlank) {
				return (aBlank - bBlank) || (a.index - b.index);
			}
			return (compare(a.key, b.key) * options.dir) || (a.index - b.index);
		})
		.map((entry) => entry.row);
};

const csvCell = (value) => {
	const s = text(value);
	if (/[",\r\n]/.test(s)) {
		return "\"" + s.replace(/"/g, "\"\"") + "\"";
	}
	return s;
};

/**
 * RFC 4180 CSV: header row, CRLF line breaks, fields quoted where needed.
 * @param {Array<string>} titles
 * @param {Array<Array<*>>} matrix rows of raw cell values
 */
const toCSV = (titles, matrix) => [titles].concat(matrix)
	.map((cells) => cells.map(csvCell).join(","))
	.join("\r\n") + "\r\n";

/**
 * Rows as objects keyed by column title (repeated titles get " 2", " 3"…).
 * @param {Array<string>} titles
 * @param {Array<Array<*>>} matrix
 */
const toObjects = (titles, matrix) => {
	const keys = titles.reduce((acc, title, i) => {
		const base = String(title || "col" + (i + 1));
		const taken = (k) => acc.includes(k);
		let key = base;
		let n = 2;
		while (taken(key)) {
			key = base + " " + n;
			n += 1;
		}
		return acc.concat([key]);
	}, []);
	return matrix.map((cells) => keys.reduce((obj, key, i) => {
		obj[key] = cells[i] === undefined ? null : cells[i];
		return obj;
	}, {}));
};

/**
 * Pretty JSON: array of objects keyed by column title.
 */
const toJSON = (titles, matrix) => JSON.stringify(toObjects(titles, matrix), null, 2) + "\n";

/**
 * Columns for a list of plain objects: the union of their keys in order of
 * first appearance; non-object rows add a single "value" column.
 * @param {Array} rows
 * @returns {Array<string>}
 */
const keysOf = (rows) => rows.reduce((keys, row) => {
	if (row === null || typeof row !== "object" || Array.isArray(row)) {
		return keys.includes("value") ? keys : keys.concat(["value"]);
	}
	return keys.concat(Object.keys(row).filter((k) => !keys.includes(k)));
}, []);

/**
 * Table rows of a lab value: an array as-is; {columns: [..], rows: [[..]]}
 * (sweep results) as objects keyed by column; {rows: [..]} its rows; any
 * other object as {key, value} entries; a scalar as one row.
 * @param {*} value
 * @returns {Array}
 */
const rowsOf = (value) => {
	if (value === null || value === undefined) {
		return [];
	}
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value !== "object") {
		return [value];
	}
	if (Array.isArray(value.rows)) {
		if (Array.isArray(value.columns) && value.rows.every(Array.isArray)) {
			return toObjects(value.columns, value.rows);
		}
		return value.rows;
	}
	return Object.keys(value).map((key) => ({ key: key, value: value[key] }));
};

module.exports = {
	toNumber: toNumber,
	isBlank: isBlank,
	compare: compare,
	text: text,
	parseFilter: parseFilter,
	matches: matches,
	view: view,
	toCSV: toCSV,
	toObjects: toObjects,
	toJSON: toJSON,
	keysOf: keysOf,
	rowsOf: rowsOf
};
