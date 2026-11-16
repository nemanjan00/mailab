// X11 keysyms for VNC key events (RFB 7.5.4): text to type and key combos
// like "ctrl+alt+del", "alt+f4", "F10", "shift+tab".

// named keys (lowercase) -> keysym
const NAMED = {
	backspace: 0xff08, bs: 0xff08,
	tab: 0xff09,
	enter: 0xff0d, return: 0xff0d,
	escape: 0xff1b, esc: 0xff1b,
	delete: 0xffff, del: 0xffff,
	insert: 0xff63, ins: 0xff63,
	home: 0xff50, end: 0xff57,
	pageup: 0xff55, pgup: 0xff55, pagedown: 0xff56, pgdn: 0xff56,
	left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54,
	space: 0x20,
	pause: 0xff13, scrolllock: 0xff14, sysrq: 0xff15, printscreen: 0xff61, print: 0xff61,
	menu: 0xff67, capslock: 0xffe5, numlock: 0xff7f,
	shift: 0xffe1, lshift: 0xffe1, rshift: 0xffe2,
	ctrl: 0xffe3, control: 0xffe3, lctrl: 0xffe3, rctrl: 0xffe4,
	alt: 0xffe9, lalt: 0xffe9, ralt: 0xffea, altgr: 0xfe03,
	meta: 0xffe7, super: 0xffeb, win: 0xffeb, cmd: 0xffeb,
	plus: 0x2b, minus: 0x2d, comma: 0x2c, period: 0x2e
};
const F1 = 0xffbe;
const MAX_F = 24;
const SHIFT = 0xffe1;
// characters that need Shift on a US layout; sending Shift explicitly keeps
// servers that map keysyms back to scancodes (QEMU) from dropping the case
const US_SHIFTED = "~!@#$%^&*()_+{}|:\"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CONTROL_CHARS = { "\n": 0xff0d, "\r": 0xff0d, "\t": 0xff09, "\b": 0xff08, "\x1b": 0xff1b };

/**
 * Keysym for one character (Latin-1 directly, other Unicode as 0x01000000 + code point).
 */
const forChar = (ch) => {
	if (CONTROL_CHARS[ch] !== undefined) {
		return CONTROL_CHARS[ch];
	}
	const cp = ch.codePointAt(0);
	if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) {
		return cp;
	}
	if (cp < 0x20 || cp === 0x7f) {
		throw new Error("no keysym for control character 0x" + cp.toString(16));
	}
	return 0x01000000 + cp;
};

/**
 * Keysym for a key name: "enter", "F10", "a", "ctrl", "0xff0d".
 */
const forName = (name) => {
	const n = String(name).trim();
	const lower = n.toLowerCase();
	if (NAMED[lower] !== undefined) {
		return NAMED[lower];
	}
	const f = /^f(\d{1,2})$/.exec(lower);
	if (f && Number(f[1]) >= 1 && Number(f[1]) <= MAX_F) {
		return F1 + Number(f[1]) - 1;
	}
	if (/^0x[0-9a-f]+$/.test(lower)) {
		return parseInt(lower, 16);
	}
	if (Array.from(n).length === 1) {
		return forChar(n);
	}
	throw new Error("unknown key: " + name);
};

/**
 * Key events (press/release, in order) for typing text.
 * @param {string} text
 * @returns {Array<{keysym: number, down: boolean}>}
 */
const typeEvents = (text) => {
	return Array.from(String(text)).reduce((events, ch) => {
		const keysym = forChar(ch);
		const tap = [{ keysym: keysym, down: true }, { keysym: keysym, down: false }];
		if (US_SHIFTED.indexOf(ch) === -1) {
			return events.concat(tap);
		}
		return events.concat([{ keysym: SHIFT, down: true }], tap, [{ keysym: SHIFT, down: false }]);
	}, []);
};

/**
 * Key events for combos: "ctrl+alt+del", "alt+f4 enter", ["ctrl+c", "F10"].
 * Modifiers go down in order and come up in reverse.
 * @param {string|string[]} keys combos separated by spaces or commas
 * @returns {Array<{keysym: number, down: boolean}>}
 */
const comboEvents = (keys) => {
	const combos = (Array.isArray(keys) ? keys : String(keys).split(/[\s,]+/)).map((c) => String(c).trim()).filter(Boolean);
	if (!combos.length) {
		throw new Error("no keys given");
	}
	return combos.reduce((events, combo) => {
		// "ctrl++" means ctrl and plus
		const parts = combo.replace(/\+\+$/, "+plus").split("+").filter(Boolean);
		const syms = parts.map(forName);
		const down = syms.map((keysym) => ({ keysym: keysym, down: true }));
		const up = syms.slice().reverse().map((keysym) => ({ keysym: keysym, down: false }));
		return events.concat(down, up);
	}, []);
};

module.exports = {
	forChar: forChar,
	forName: forName,
	typeEvents: typeEvents,
	comboEvents: comboEvents
};
