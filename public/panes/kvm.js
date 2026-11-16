// Live screen of a `nanokvm` device: MJPEG from /api/kvm/<device>/mjpeg (the
// server re-serves the device's own KVM stream; the KVM credentials never
// reach the browser), keyboard / mouse as USB HID reports over
// /ws/kvm/<device> (the server drops them for anyone but people, and for
// view-only devices), ATX power buttons (people only, POST /api/kvm/<device>/power),
// LEDs, screenshot into the lab (image <device>_screen, the same one the AI gets).
// Click the screen to capture the keyboard; Esc-free: blur (click outside) releases it.

import { el, onDispose, state, when } from "@nemanjan00/qrp";
import { empty, iconButton, pane, toolbar } from "../sdk/index.js";

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;
const STATUS_POLL_MS = 5000;
const ABS_MAX = 0x7fff;
const EVENT_KEYBOARD = 1;
const EVENT_MOUSE = 2;
// KeyboardEvent.button -> HID button bit
const BUTTON_BITS = { 0: 1, 1: 4, 2: 2 };
const MODIFIER_BITS = {
	ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08,
	ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80
};
// KeyboardEvent.code -> USB HID usage (page 7)
const USAGES = (() => {
	const map = {
		Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c, Minus: 0x2d, Equal: 0x2e,
		BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, IntlHash: 0x32, Semicolon: 0x33, Quote: 0x34,
		Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39,
		PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49, Home: 0x4a, PageUp: 0x4b,
		Delete: 0x4c, End: 0x4d, PageDown: 0x4e, ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
		NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56, NumpadAdd: 0x57,
		NumpadEnter: 0x58, Numpad0: 0x62, NumpadDecimal: 0x63, IntlBackslash: 0x64, ContextMenu: 0x65
	};
	"ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach((c, i) => {
		map["Key" + c] = 0x04 + i;
	});
	"123456789".split("").forEach((d, i) => {
		map["Digit" + d] = 0x1e + i;
		map["Numpad" + d] = 0x59 + i;
	});
	map.Digit0 = 0x27;
	Array.from({ length: 12 }, (_, i) => i).forEach((i) => {
		map["F" + (i + 1)] = 0x3a + i;
	});
	return map;
})();
// Ctrl-Alt-Del as reports: ctrl, +alt, +del, then release in reverse
const CTRL_ALT_DEL = [[0x01, []], [0x05, []], [0x05, [0x4c]], [0x05, []], [0x01, []], [0, []]];

const base = () => location.protocol + "//" + location.host;
const wsUrl = (device) => (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws/kvm/" + encodeURIComponent(device);

const keyboardMessage = (modifiers, usages) => {
	const msg = new Uint8Array(9);
	msg[0] = EVENT_KEYBOARD;
	msg[1] = modifiers;
	usages.slice(0, 6).forEach((u, i) => {
		msg[3 + i] = u;
	});
	return msg;
};

const kvm = (ctx, p, device) => {
	const view = state({
		stream: "connecting",
		socket: "connecting",
		serverViewOnly: true,
		viewOnly: Boolean(p.pane.config.viewOnly),
		captured: false,
		leds: null,
		size: "",
		note: "",
		error: ""
	});
	const input = { sock: null, retry: null, retryMs: RETRY_MIN_MS, modifiers: 0, keys: [], buttons: 0, x: 0, y: 0, frame: 0, moved: false };
	const stream = { retry: null, retryMs: RETRY_MIN_MS };
	let disposed = false;
	let poll = null;

	const flash = (text) => {
		view.note = text;
		setTimeout(() => {
			if (view.note === text) {
				view.note = "";
			}
		}, 2500);
	};

	const canInput = () => !view.viewOnly && !view.serverViewOnly && view.socket === "open";

	const send = (msg) => {
		if (canInput() && input.sock && input.sock.readyState === WebSocket.OPEN) {
			input.sock.send(msg);
		}
	};

	// ---- screen --------------------------------------------------------------

	const img = el("img", { class: "kvm-screen", alt: "", draggable: "false", tabindex: "0" });

	const loadStream = () => {
		stream.retry = null;
		if (disposed) {
			return;
		}
		view.stream = "connecting";
		img.src = base() + "/api/kvm/" + encodeURIComponent(device) + "/mjpeg?t=" + Date.now();
	};

	img.addEventListener("load", () => {
		stream.retryMs = RETRY_MIN_MS;
		view.stream = "live";
		view.size = img.naturalWidth + "x" + img.naturalHeight;
	});
	img.addEventListener("error", () => {
		if (disposed) {
			return;
		}
		view.stream = "error";
		clearTimeout(stream.retry);
		stream.retry = setTimeout(loadStream, stream.retryMs);
		stream.retryMs = Math.min(RETRY_MAX_MS, stream.retryMs * 2);
	});

	// ---- input socket ----------------------------------------------------------

	const connectInput = () => {
		input.retry = null;
		if (disposed) {
			return;
		}
		view.socket = "connecting";
		const sock = new WebSocket(wsUrl(device));
		sock.binaryType = "arraybuffer";
		input.sock = sock;
		sock.onopen = () => {
			input.retryMs = RETRY_MIN_MS;
			view.socket = "open";
		};
		sock.onmessage = (e) => {
			try {
				const msg = JSON.parse(e.data);
				if (msg.type === "hello") {
					view.serverViewOnly = Boolean(msg.viewOnly);
				} else if (msg.type === "error") {
					flash("⚠ " + msg.error);
				}
			} catch (_err) {
				// not ours
			}
		};
		sock.onclose = () => {
			if (input.sock === sock) {
				input.sock = null;
			}
			view.socket = "closed";
			if (disposed) {
				return;
			}
			input.retry = setTimeout(connectInput, input.retryMs);
			input.retryMs = Math.min(RETRY_MAX_MS, input.retryMs * 2);
		};
	};

	// ---- keyboard ----------------------------------------------------------------

	const sendKeys = () => send(keyboardMessage(input.modifiers, input.keys));

	const releaseAll = () => {
		if (input.modifiers || input.keys.length) {
			input.modifiers = 0;
			input.keys = [];
			sendKeys();
		}
		if (input.buttons) {
			input.buttons = 0;
			sendMouse(0);
		}
	};

	const onKey = (down) => (e) => {
		if (!canInput()) {
			return;
		}
		const bit = MODIFIER_BITS[e.code];
		const usage = USAGES[e.code];
		if (bit === undefined && usage === undefined) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		if (bit !== undefined) {
			input.modifiers = down ? input.modifiers | bit : input.modifiers & ~bit;
		} else if (down && input.keys.indexOf(usage) === -1) {
			input.keys = input.keys.concat([usage]).slice(-6);
		} else if (!down) {
			input.keys = input.keys.filter((k) => k !== usage);
		}
		sendKeys();
	};

	const ctrlAltDel = () => {
		CTRL_ALT_DEL.reduce((p, step) => p.then(() => {
			send(keyboardMessage(step[0], step[1]));
			return new Promise((resolve) => setTimeout(resolve, 30));
		}), Promise.resolve());
	};

	// ---- mouse ---------------------------------------------------------------------

	// position inside the drawn picture (object-fit: contain letterboxes it), 0..1
	const position = (e) => {
		const r = img.getBoundingClientRect();
		const w = img.naturalWidth || r.width;
		const h = img.naturalHeight || r.height;
		const scale = Math.min(r.width / w, r.height / h);
		const dw = w * scale;
		const dh = h * scale;
		const x = (e.clientX - r.left - (r.width - dw) / 2) / dw;
		const y = (e.clientY - r.top - (r.height - dh) / 2) / dh;
		return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
	};

	const sendMouse = (wheel) => {
		const msg = new Uint8Array(7);
		const view16 = new DataView(msg.buffer);
		msg[0] = EVENT_MOUSE;
		msg[1] = input.buttons;
		view16.setUint16(2, Math.max(1, Math.round(input.x * ABS_MAX)), true);
		view16.setUint16(4, Math.max(1, Math.round(input.y * ABS_MAX)), true);
		view16.setInt8(6, wheel);
		send(msg);
	};

	const track = (e) => {
		const pos = position(e);
		input.x = pos.x;
		input.y = pos.y;
		return pos.inside;
	};

	img.addEventListener("mousemove", (e) => {
		if (!canInput()) {
			return;
		}
		track(e);
		if (!input.frame) {
			// at most one move report per animation frame
			input.frame = requestAnimationFrame(() => {
				input.frame = 0;
				sendMouse(0);
			});
		}
	});
	img.addEventListener("mousedown", (e) => {
		img.focus();
		if (!canInput() || !track(e)) {
			return;
		}
		e.preventDefault();
		input.buttons |= BUTTON_BITS[e.button] || 0;
		sendMouse(0);
	});
	img.addEventListener("mouseup", (e) => {
		if (!canInput()) {
			return;
		}
		e.preventDefault();
		track(e);
		input.buttons &= ~(BUTTON_BITS[e.button] || 0);
		sendMouse(0);
	});
	img.addEventListener("wheel", (e) => {
		if (!canInput() || !track(e) || Math.round(e.deltaY) === 0) {
			return;
		}
		e.preventDefault();
		// HID wheel > 0 scrolls up
		sendMouse(e.deltaY > 0 ? -1 : 1);
	}, { passive: false });
	img.addEventListener("contextmenu", (e) => e.preventDefault());
	img.addEventListener("keydown", onKey(true));
	img.addEventListener("keyup", onKey(false));
	img.addEventListener("focus", () => {
		view.captured = true;
	});
	img.addEventListener("blur", () => {
		view.captured = false;
		releaseAll();
	});

	// ---- actions -----------------------------------------------------------------------

	const refreshStatus = () => ctx.api("GET", "/kvm/" + encodeURIComponent(device) + "/status").then((s) => {
		view.leds = s.leds;
		view.error = "";
	}, (err) => {
		view.error = err.message;
	});

	const power = (action, question) => {
		if (question && !window.confirm(question)) {
			return;
		}
		ctx.api("POST", "/kvm/" + encodeURIComponent(device) + "/power", { action: action })
			.then(() => {
				flash(action + " done");
				return refreshStatus();
			}, (err) => flash("⚠ " + err.message));
	};

	const screenshot = () => ctx.api("POST", "/devices/" + device + "/command", { command: "screenshot", args: {} })
		.then(() => flash("saved as " + device + "_screen"), (err) => flash("⚠ " + err.message));

	const reconnect = () => {
		clearTimeout(stream.retry);
		stream.retryMs = RETRY_MIN_MS;
		loadStream();
		clearTimeout(input.retry);
		input.retryMs = RETRY_MIN_MS;
		if (input.sock) {
			// onclose schedules the next connection
			input.sock.close();
		} else {
			connectInput();
		}
	};

	onDispose(() => {
		disposed = true;
		clearTimeout(stream.retry);
		clearTimeout(input.retry);
		clearInterval(poll);
		releaseAll();
		img.removeAttribute("src");
		if (input.sock) {
			input.sock.close();
		}
	});

	loadStream();
	connectInput();
	refreshStatus();
	poll = setInterval(refreshStatus, STATUS_POLL_MS);

	const led = (label, key, title) => el("span", { class: () => "kvm-led" + (view.leds && view.leds[key] ? " on" : ""), title: title }, label);
	const human = () => !view.serverViewOnly && !view.viewOnly;

	return el("div", { class: "kvm" },
		toolbar(
			el("span", { class: () => "state " + (view.stream === "live" ? "running" : view.stream === "connecting" ? "starting" : "error"), title: () => "input: " + view.socket },
				() => (view.stream === "live" ? view.size : view.stream)),
			el("label", { class: "vnc-toggle", title: "don't send keyboard / mouse input" },
				el("input", { type: "checkbox", checked: () => view.viewOnly, onchange: (e) => {
					view.viewOnly = e.target.checked;
					releaseAll();
				} }), "view only"),
			el("button", { title: "send Ctrl-Alt-Del", disabled: () => !canInput(), onclick: ctrlAltDel }, "Ctrl-Alt-Del"),
			el("button", { title: "short press of the power button (on / ACPI off)", disabled: () => !human(), onclick: () => power("on") }, "power"),
			el("button", { title: "reset button", disabled: () => !human(), onclick: () => power("reset", "Reset the target machine?") }, "reset"),
			el("button", { title: "hold power 12 s (forced off)", disabled: () => !human(), onclick: () => power("long_press", "Force the target machine off (hold power 12 s)?") }, "force off"),
			led("PWR", "power", "power LED"),
			led("HDD", "hdd", "disk LED"),
			led("NUM", "numLock", "num lock"),
			led("CAPS", "capsLock", "caps lock"),
			iconButton("📷", "screenshot into the lab (image " + device + "_screen)", screenshot),
			iconButton("⟳", "reconnect", reconnect),
			el("span", { class: "muted mono" }, () => view.note || (view.captured && canInput() ? "keyboard captured" : ""))),
		when(() => view.error, () => el("div", { class: "error pad" }, () => view.error)),
		el("div", { class: () => "kvm-view" + (view.captured ? " captured" : "") }, img));
};

export default pane((ctx, p) => when(
	() => p.pane.config.device,
	(device) => kvm(ctx, p, device),
	() => empty("set config.device to a nanokvm device id")
));
