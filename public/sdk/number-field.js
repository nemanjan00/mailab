// Numeric setpoint entry that works on a tablet: tapping the input opens a
// keypad popover (digits, ".", "±", backspace, clear, unit/prefix buttons,
// set). On a desktop the input is typed into directly; Enter submits and
// engineering suffixes parse ("2.4G", "100m", "3.3 kV").
//
//   numberField({ unit: "Hz", value: 433.92e6, onSet: (hz) => send(hz) })

import { el, onDispose, state } from "@nemanjan00/qrp";
import keypad from "../../src/utils/keypad/index.js";
import units from "../../src/utils/units/index.js";

// below this viewport width the keypad docks to the bottom of the screen
const SHEET_WIDTH = 520;
const KEY_ROWS = [["7", "8", "9", "back"], ["4", "5", "6", "clear"], ["1", "2", "3", "±"]];
const KEY_LABELS = { back: "⌫", clear: "C" };

const place = (pad, input) => {
	if (window.innerWidth < SHEET_WIDTH) {
		pad.classList.add("sheet");
		pad.style.left = "";
		pad.style.top = "";
		return;
	}
	pad.classList.remove("sheet");
	const at = input.getBoundingClientRect();
	const size = pad.getBoundingClientRect();
	const left = Math.min(Math.max(8, at.left), window.innerWidth - size.width - 8);
	// below the input if it fits, else above
	const below = at.bottom + 4;
	const top = below + size.height <= window.innerHeight - 8 ? below : Math.max(8, at.top - size.height - 4);
	pad.style.left = left + "px";
	pad.style.top = top + "px";
};

/**
 * @param {Object} spec
 * @param {string} [spec.unit] base unit ("V", "Hz", "s", "A", "dBm"...); picks the unit buttons
 * @param {number} [spec.value] initial value in base units
 * @param {function(number): *} spec.onSet called with the value in base units
 * @param {string} [spec.class] extra class for the input
 * @param {string} [spec.title]
 * @returns {HTMLElement} the input
 */
export const numberField = (spec) => {
	const unit = spec.unit || "";
	const options = units.choices(unit);
	const k = state({ mantissa: "", fresh: true, choice: "", bad: false });

	const input = el("input", {
		class: "number-field " + (spec.class || ""),
		type: "text",
		inputmode: "decimal",
		autocomplete: "off",
		placeholder: unit,
		title: spec.title || "type a value (2.4G, 100m) or tap for the keypad",
		value: units.format(spec.value, unit)
	});

	const submit = (value) => {
		if (!Number.isFinite(value)) {
			input.classList.add("bad");
			k.bad = true;
			return false;
		}
		input.classList.remove("bad");
		input.value = units.format(value, unit);
		spec.onSet(value);
		return true;
	};

	const press = (key) => {
		const next = keypad.press({ mantissa: k.mantissa, fresh: k.fresh }, key);
		k.mantissa = next.mantissa;
		k.fresh = next.fresh;
		k.bad = false;
	};

	const keyButton = (key) => el("button", { type: "button", class: "key", onclick: () => press(key) }, KEY_LABELS[key] || key);

	const pad = el("div", { class: "keypad", popover: "manual" },
		el("div", { class: () => "kp-display" + (k.bad ? " bad" : "") + (k.fresh ? " fresh" : "") },
			el("span", { class: "kp-value" }, () => k.mantissa || "0"),
			el("span", { class: "kp-unit" }, () => k.choice)),
		options.length > 1 ? el("div", { class: "kp-units" }, ...options.map((c) => el("button", {
			type: "button",
			class: () => "key unit" + (k.choice === c.label ? " primary" : ""),
			onclick: () => {
				k.choice = c.label;
			}
		}, c.label))) : "",
		el("div", { class: "kp-keys" },
			...KEY_ROWS.map((row) => row.map(keyButton)).reduce((a, b) => a.concat(b), []),
			keyButton("0"), keyButton("."),
			el("button", { type: "button", class: "key primary kp-set", onclick: () => {
				if (submit(units.combine(k.mantissa, k.choice, unit))) {
					close();
				}
			} }, "set")),
		el("button", { type: "button", class: "kp-cancel", onclick: () => close() }, "cancel"));

	const outside = (event) => {
		if (!pad.contains(event.target) && event.target !== input) {
			close();
		}
	};

	const close = () => {
		document.removeEventListener("pointerdown", outside, true);
		if (pad.isConnected) {
			pad.hidePopover();
			pad.remove();
		}
	};

	const open = () => {
		if (pad.isConnected) {
			return;
		}
		const shown = units.split(units.parse(input.value, unit), unit);
		const entry = keypad.open(shown.mantissa);
		k.mantissa = entry.mantissa;
		k.fresh = entry.fresh;
		k.choice = shown.choice;
		k.bad = false;
		// inside an open modal dialog, the rest of the page is inert
		(input.closest("dialog") || document.body).appendChild(pad);
		pad.showPopover();
		place(pad, input);
		document.addEventListener("pointerdown", outside, true);
	};

	// touch: the keypad replaces the on-screen keyboard
	input.addEventListener("pointerdown", (event) => {
		input.inputMode = event.pointerType === "mouse" ? "decimal" : "none";
	});
	input.addEventListener("click", open);
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			close();
			submit(units.parse(input.value, unit));
		} else if (event.key === "Escape") {
			close();
		} else if (event.key.length === 1) {
			// typing takes over from the keypad
			close();
			input.classList.remove("bad");
		}
	});
	onDispose(close);
	return input;
};
