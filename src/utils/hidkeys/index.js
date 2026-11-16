// USB HID boot keyboard reports (8 bytes: modifiers, reserved, 6 key usages)
// for typing text and key combos, with the same key names as utils/keysym
// ("ctrl+alt+del", "alt+f4", "F10", "shift+tab"). Usages: USB HID Usage
// Tables, page 0x07 (Keyboard/Keypad). US layout, like the NanoKVM web UI
// (sipeed/NanoKVM web/src/lib/keymap.ts).

const REPORT_BYTES = 8;
const MAX_KEYS = 6;

const MODIFIERS = {
	ctrl: 0x01, control: 0x01, lctrl: 0x01,
	shift: 0x02, lshift: 0x02,
	alt: 0x04, lalt: 0x04,
	meta: 0x08, super: 0x08, win: 0x08, cmd: 0x08,
	rctrl: 0x10, rshift: 0x20, ralt: 0x40, altgr: 0x40, rmeta: 0x80
};
const SHIFT = 0x02;

// named non-modifier keys (lowercase) -> usage
const NAMED = {
	enter: 0x28, return: 0x28,
	escape: 0x29, esc: 0x29,
	backspace: 0x2a, bs: 0x2a,
	tab: 0x2b,
	space: 0x2c,
	minus: 0x2d, plus: 0x2e, comma: 0x36, period: 0x37,
	capslock: 0x39,
	printscreen: 0x46, print: 0x46, sysrq: 0x46,
	scrolllock: 0x47, pause: 0x48,
	insert: 0x49, ins: 0x49,
	home: 0x4a, pageup: 0x4b, pgup: 0x4b,
	delete: 0x4c, del: 0x4c,
	end: 0x4d, pagedown: 0x4e, pgdn: 0x4e,
	right: 0x4f, left: 0x50, down: 0x51, up: 0x52,
	numlock: 0x53,
	menu: 0x65
};
const F1 = 0x3a;
const F13 = 0x68;
const MAX_F = 24;

// unshifted US characters -> usage
const PLAIN = {
	"1": 0x1e, "2": 0x1f, "3": 0x20, "4": 0x21, "5": 0x22, "6": 0x23, "7": 0x24, "8": 0x25, "9": 0x26, "0": 0x27,
	"\n": 0x28, "\r": 0x28, "\x1b": 0x29, "\b": 0x2a, "\t": 0x2b, " ": 0x2c,
	"-": 0x2d, "=": 0x2e, "[": 0x2f, "]": 0x30, "\\": 0x31, ";": 0x33, "'": 0x34, "`": 0x35, ",": 0x36, ".": 0x37, "/": 0x38
};
// shifted US characters -> the unshifted character on the same key
const SHIFTED = {
	"!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
	"_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "~": "`", "<": ",", ">": ".", "?": "/"
};
const LETTER_A = 0x04;

/**
 * Usage and modifiers for one character on a US keyboard.
 * @returns {{usage: number, modifiers: number}}
 */
const forChar = (ch) => {
	if (/^[a-z]$/.test(ch)) {
		return { usage: LETTER_A + ch.charCodeAt(0) - 97, modifiers: 0 };
	}
	if (/^[A-Z]$/.test(ch)) {
		return { usage: LETTER_A + ch.charCodeAt(0) - 65, modifiers: SHIFT };
	}
	if (PLAIN[ch] !== undefined) {
		return { usage: PLAIN[ch], modifiers: 0 };
	}
	if (SHIFTED[ch] !== undefined) {
		return { usage: PLAIN[SHIFTED[ch]], modifiers: SHIFT };
	}
	throw new Error("can't type " + JSON.stringify(ch) + " on a US HID keyboard (ASCII only)");
};

/**
 * A key name: {modifier: bit} or {usage}. "enter", "F10", "a", "ctrl", "0x4c" (raw usage).
 */
const forName = (name) => {
	const n = String(name).trim();
	const lower = n.toLowerCase();
	if (MODIFIERS[lower] !== undefined) {
		return { modifier: MODIFIERS[lower] };
	}
	if (NAMED[lower] !== undefined) {
		return { usage: NAMED[lower] };
	}
	const f = /^f(\d{1,2})$/.exec(lower);
	if (f && Number(f[1]) >= 1 && Number(f[1]) <= MAX_F) {
		const i = Number(f[1]);
		return { usage: i <= 12 ? F1 + i - 1 : F13 + i - 13 };
	}
	if (/^0x[0-9a-f]{1,2}$/.test(lower)) {
		return { usage: parseInt(lower, 16) };
	}
	if (Array.from(n).length === 1) {
		// a single character names its key; "A" is the a key (use shift+a for a capital)
		return { usage: forChar(lower).usage };
	}
	throw new Error("unknown key: " + name);
};

const report = (modifiers, usages) => {
	const r = Buffer.alloc(REPORT_BYTES);
	r[0] = modifiers;
	usages.slice(0, MAX_KEYS).forEach((u, i) => {
		r[2 + i] = u;
	});
	return r;
};

const RELEASE = () => Buffer.alloc(REPORT_BYTES);

/**
 * Reports for typing text: each character pressed (with Shift when needed)
 * and released; every report is a full keyboard state.
 * @param {string} text
 * @returns {Buffer[]}
 */
const typeReports = (text) => {
	return Array.from(String(text)).reduce((reports, ch) => {
		const k = forChar(ch);
		return reports.concat([report(k.modifiers, [k.usage]), RELEASE()]);
	}, []);
};

/**
 * Reports for key combos: "ctrl+alt+del", "alt+f4 enter", ["ctrl+c", "F10"].
 * Keys go down one at a time in order and come up in reverse.
 * @param {string|string[]} keys combos separated by spaces or commas
 * @returns {Buffer[]}
 */
const comboReports = (keys) => {
	const combos = (Array.isArray(keys) ? keys : String(keys).split(/[\s,]+/)).map((c) => String(c).trim()).filter(Boolean);
	if (!combos.length) {
		throw new Error("no keys given");
	}
	return combos.reduce((reports, combo) => {
		// "ctrl++" means ctrl and plus
		const parts = combo.replace(/\+\+$/, "+plus").split("+").filter(Boolean).map(forName);
		const usages = parts.filter((p) => p.usage !== undefined);
		if (usages.length > MAX_KEYS) {
			throw new Error("at most " + MAX_KEYS + " non-modifier keys at once: " + combo);
		}
		// state after the first i parts are down
		const stateAt = (i) => parts.slice(0, i).reduce((s, p) => ({
			modifiers: s.modifiers | (p.modifier || 0),
			usages: p.usage === undefined ? s.usages : s.usages.concat([p.usage])
		}), { modifiers: 0, usages: [] });
		const down = parts.map((_, i) => stateAt(i + 1));
		const up = parts.map((_, i) => stateAt(parts.length - 1 - i));
		return reports.concat(down.concat(up).map((s) => report(s.modifiers, s.usages)));
	}, []);
};

module.exports = {
	REPORT_BYTES: REPORT_BYTES,
	MODIFIERS: MODIFIERS,
	forChar: forChar,
	forName: forName,
	typeReports: typeReports,
	comboReports: comboReports
};
