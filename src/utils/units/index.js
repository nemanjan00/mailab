// Engineering units for numeric entry: SI prefixes, the unit buttons a keypad
// offers for a base unit, and parsing / formatting of values with suffixes
// ("2.4G", "100m", "3.3 kV", "-10 dBm"). Values are always in base units.
// Plain CommonJS so jest loads it and esbuild bundles it into the web UI.

// prefix -> power of ten (µ is U+00B5, the micro sign)
const PREFIXES = { T: 12, G: 9, M: 6, k: 3, "": 0, m: -3, "µ": -6, n: -9, p: -12 };

// typed spellings of a prefix; "m" stays milli, "M" mega
const ALIASES = { K: "k", g: "G", t: "T", u: "µ", "μ": "µ", meg: "M", Meg: "M", MEG: "M" };

// prefixes offered as keypad buttons, per base unit (low to high)
const UNIT_PREFIXES = {
	V: ["m", "", "k"],
	A: ["µ", "m", ""],
	Hz: ["", "k", "M", "G"],
	s: ["n", "µ", "m", ""],
	W: ["m", ""],
	"Ω": ["", "k", "M"],
	F: ["p", "n", "µ"],
	H: ["n", "µ", "m"]
};

// logarithmic and similar units never take a prefix
const NO_PREFIX = ["dB", "dBm", "dBc", "dBi", "dBV", "dBuV", "%", "°", "°C", "deg"];

// mantissa, optional exponent, optional suffix (prefix and/or unit)
const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:e([+-]?\d+))?\s*(\S*)$/i;

/**
 * Unit buttons for a base unit: [{label, prefix, exp}], low to high.
 * Unknown units get just themselves; no unit gets none.
 * @param {string} unit
 */
const choices = (unit) => {
	if (!unit) {
		return [];
	}
	const prefixes = UNIT_PREFIXES[unit] || [""];
	return prefixes.map((prefix) => ({ label: prefix + unit, prefix: prefix, exp: PREFIXES[prefix] }));
};

// value * 10^exp without binary noise (1.1 * 1e-3 = 0.0011000000000000001)
// (mantissa may itself be in exponent form: 5e-7)
const scale = (mantissa, exp) => {
	const parts = String(mantissa).split(/e/i);
	return Number(parts[0] + "e" + (Number(parts[1] || 0) + exp));
};

const prefixOf = (suffix, unit) => {
	const bare = unit && suffix.toLowerCase().endsWith(unit.toLowerCase()) ? suffix.slice(0, suffix.length - unit.length) : suffix;
	const prefix = ALIASES[bare] !== undefined ? ALIASES[bare] : bare;
	if (PREFIXES[prefix] === undefined) {
		return null;
	}
	if (prefix !== "" && NO_PREFIX.includes(unit)) {
		return null;
	}
	return prefix;
};

/**
 * Parse typed text into a base-unit number; NaN if it isn't one.
 * "2.4G", "2.4 GHz", "100m", "100 mV", "1e-3", "-10 dBm"
 * @param {string} text
 * @param {string} [unit] base unit, stripped from the suffix if present
 */
const parse = (text, unit) => {
	const match = NUMBER.exec(String(text === undefined || text === null ? "" : text).trim());
	if (!match) {
		return NaN;
	}
	const prefix = prefixOf(match[3], unit || "");
	if (prefix === null) {
		return NaN;
	}
	return scale(match[1], Number(match[2] || 0) + PREFIXES[prefix]);
};

/**
 * Split a base-unit value into a mantissa string and the best unit button.
 * @param {number} value
 * @param {string} [unit]
 * @returns {{mantissa: string, choice: string}}
 */
const split = (value, unit) => {
	const options = choices(unit);
	if (!Number.isFinite(value)) {
		return { mantissa: "", choice: options.length ? (options.find((c) => c.prefix === "") || options[0]).label : "" };
	}
	if (!options.length) {
		return { mantissa: String(value), choice: "" };
	}
	const abs = Math.abs(value);
	// largest prefix the value reaches, else the smallest one offered
	const fits = options.filter((c) => abs >= Math.pow(10, c.exp));
	let best = options[0];
	if (abs !== 0 && fits.length) {
		best = fits[fits.length - 1];
	} else if (abs === 0) {
		best = options.find((c) => c.prefix === "") || options[0];
	}
	const mantissa = Number(scale(value, -best.exp).toPrecision(12));
	return { mantissa: String(mantissa), choice: best.label };
};

/**
 * Format a base-unit value for display: 2.4e9, "Hz" -> "2.4 GHz".
 * @param {number} value
 * @param {string} [unit]
 */
const format = (value, unit) => {
	if (!Number.isFinite(value)) {
		return "";
	}
	const parts = split(value, unit);
	if (!parts.choice) {
		return parts.mantissa + (unit ? " " + unit : "");
	}
	return parts.mantissa + " " + parts.choice;
};

/**
 * Value of a keypad entry (mantissa + chosen unit button) in base units.
 * @param {string} mantissa
 * @param {string} choice a label from choices(unit), or ""
 * @param {string} [unit]
 */
const combine = (mantissa, choice, unit) => {
	if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(mantissa)) {
		return NaN;
	}
	const picked = choices(unit).find((c) => c.label === choice);
	return scale(mantissa, picked ? picked.exp : 0);
};

module.exports = {
	PREFIXES: PREFIXES,
	choices: choices,
	parse: parse,
	split: split,
	format: format,
	combine: combine
};
