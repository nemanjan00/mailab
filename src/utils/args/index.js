// Strict parsing of command arguments. MCP args are free-form JSON, so
// anything that drives hardware must be validated, never coerced:
// Boolean("false") === true would turn an output ON.

const SWITCH = { on: true, off: false, true: true, false: false };

/**
 * Parse an on/off argument. Accepts true/false, "on"/"off", "true"/"false".
 * @param {*} value
 * @param {string} name argument name, for the error message
 * @returns {boolean}
 */
const parseSwitch = (value, name) => {
	if (value === true || value === false) {
		return value;
	}
	if (typeof value === "string" && Object.prototype.hasOwnProperty.call(SWITCH, value.trim().toLowerCase())) {
		return SWITCH[value.trim().toLowerCase()];
	}
	throw new Error((name || "value") + " must be true/false or \"on\"/\"off\", got " + JSON.stringify(value));
};

/**
 * Parse a finite number within [min, max].
 * @param {*} value number or numeric string
 * @param {string} name
 * @param {{min: number, max: number, unit: string}} [limits]
 * @returns {number}
 */
const parseNumber = (value, name, limits) => {
	const l = limits || {};
	const unit = l.unit ? " " + l.unit : "";
	let n = NaN;
	if (typeof value === "number") {
		n = value;
	} else if (typeof value === "string" && value.trim() !== "") {
		n = Number(value);
	}
	if (!Number.isFinite(n)) {
		throw new Error(name + " must be a number, got " + JSON.stringify(value));
	}
	if (l.min !== undefined && n < l.min) {
		throw new Error(name + " " + n + unit + " is below the minimum " + l.min + unit);
	}
	if (l.max !== undefined && n > l.max) {
		throw new Error(name + " " + n + unit + " is above the limit " + l.max + unit);
	}
	return n;
};

module.exports = {
	parseSwitch: parseSwitch,
	parseNumber: parseNumber
};
