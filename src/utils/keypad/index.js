// Numeric keypad entry as a pure state machine: press(entry, key) -> entry.
// entry: {mantissa: "12.5", fresh: bool}. A fresh entry (just opened, showing
// the current value) is replaced by the first digit, like a calculator.

const DIGITS = "0123456789";

// longest mantissa we keep (digits, sign and point)
const MAX_LENGTH = 16;

/**
 * @param {string} mantissa current value, e.g. from units.split()
 */
const open = (mantissa) => ({ mantissa: mantissa || "", fresh: true });

const append = (entry, text) => {
	const base = entry.fresh ? "" : entry.mantissa;
	if (base.length >= MAX_LENGTH) {
		return { mantissa: base, fresh: false };
	}
	return { mantissa: base + text, fresh: false };
};

const KEYS = {
	".": (entry) => {
		const base = entry.fresh ? "" : entry.mantissa;
		if (base.includes(".")) {
			return { mantissa: base, fresh: false };
		}
		const digits = base.replace(/^[+-]/, "");
		return append({ mantissa: base, fresh: false }, digits === "" ? "0." : ".");
	},
	"±": (entry) => {
		const base = entry.mantissa;
		if (base.startsWith("-")) {
			return { mantissa: base.slice(1), fresh: false };
		}
		return { mantissa: "-" + base, fresh: false };
	},
	back: (entry) => ({ mantissa: entry.mantissa.slice(0, -1), fresh: false }),
	clear: () => ({ mantissa: "", fresh: false })
};

/**
 * Apply one key: a digit, ".", "±", "back" or "clear". Unknown keys are ignored.
 * @param {{mantissa: string, fresh: boolean}} entry
 * @param {string} key
 */
const press = (entry, key) => {
	if (DIGITS.includes(key) && key.length === 1) {
		return append(entry, key);
	}
	if (KEYS[key]) {
		return KEYS[key](entry);
	}
	return entry;
};

module.exports = {
	open: open,
	press: press
};
