// Web terminal for a `uart` device (USB-UART adapters): xterm.js on the raw
// byte stream, so colors, cursor movement and full-screen TUIs (menuconfig,
// vi, top on the target) work. Dracula palette. Raw mode sends keystrokes as
// typed (the target echoes); line mode edits locally and sends on Enter with
// the device's line ending (↑ / ↓ history). Toolbar: baud, format, line
// ending, how rx is logged for the AI (text / hex), raw / line, clear.

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { el, onDispose, state, when } from "@nemanjan00/qrp";
import { empty, iconButton, pane, toolbar, widget } from "../sdk/index.js";

const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 1500000, 2000000, 3000000];
const EOLS = ["lf", "crlf", "cr", "none"];
const FORMATS = ["8N1", "8E1", "8O1", "7E1", "7O1", "8N2"];

// Dracula (draculatheme.com/contribute) ANSI palette
const DRACULA = {
	background: "#282a36",
	foreground: "#f8f8f2",
	cursor: "#f8f8f2",
	cursorAccent: "#282a36",
	selectionBackground: "#44475a",
	black: "#21222c",
	red: "#ff5555",
	green: "#50fa7b",
	yellow: "#f1fa8c",
	blue: "#bd93f9",
	magenta: "#ff79c6",
	cyan: "#8be9fd",
	white: "#f8f8f2",
	brightBlack: "#6272a4",
	brightRed: "#ff6e6e",
	brightGreen: "#69ff94",
	brightYellow: "#ffffa5",
	brightBlue: "#d6acff",
	brightMagenta: "#ff92df",
	brightCyan: "#a4ffff",
	brightWhite: "#ffffff"
};

const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const hexLine = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ") + "\r\n";

const select = (values, current, onchange, title) => el("select", { title: title, onchange: (e) => onchange(e.target.value) },
	...values.map((v) => el("option", { value: v, selected: () => String(current()) === String(v) }, String(v))));

const terminal = (ctx, p, device) => {
	const view = state({ status: null, error: "", mode: (p.pane.config.mode === "line" ? "line" : "raw") });
	let term = null;
	let line = "";
	const history = [];
	let historyAt = 0;

	const command = (name, args) => ctx.api("POST", "/devices/" + device + "/command", { command: name, args: args || {} });
	const fail = (err) => {
		view.error = err.message;
	};
	const refresh = () => command("status").then((s) => {
		view.status = s;
		view.error = "";
	}, fail);
	const set = (changes) => command("set", changes).then((s) => {
		view.status = s;
		view.error = "";
	}, fail);

	const show = (bytes) => {
		if (!term) {
			return;
		}
		term.write(view.status && view.status.display === "hex" ? hexLine(bytes) : bytes);
	};

	const sendRaw = (text) => ctx.api("POST", "/devices/" + device + "/term", { data: toBase64(text) }).catch(fail);

	// line mode: local editing, the whole line goes out on Enter
	const lineInput = (data) => {
		if (data === "\r") {
			term.write("\r\n");
			history.push(line);
			historyAt = history.length;
			command("write", { text: line }).catch(fail);
			line = "";
		} else if (data === "\x7f" || data === "\b") {
			if (line.length) {
				line = line.slice(0, -1);
				term.write("\b \b");
			}
		} else if (data === "\x1b[A" || data === "\x1b[B") {
			historyAt = Math.max(0, Math.min(history.length, historyAt + (data === "\x1b[A" ? -1 : 1)));
			term.write("\b \b".repeat(line.length));
			line = history[historyAt] || "";
			term.write(line);
		} else if (data === "\x03") {
			// Ctrl-C still reaches the target
			sendRaw(data);
		} else if (!data.startsWith("\x1b")) {
			const printable = Array.from(data).filter((c) => c.charCodeAt(0) >= 32).join("");
			line += printable;
			term.write(printable);
		}
	};

	refresh();
	onDispose(ctx.on("term", (msg) => {
		if (msg.device === device) {
			show(fromBase64(msg.data));
		}
	}));
	// connection state follows the device (replugs)
	onDispose(ctx.on("state", () => {
		refresh();
	}));

	const screen = widget((host) => {
		term = new Terminal({
			theme: DRACULA,
			fontFamily: getComputedStyle(document.body).getPropertyValue("--mono") || "monospace",
			fontSize: 13,
			cursorBlink: true,
			scrollback: 5000,
			convertEol: false,
			allowProposedApi: false
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();
		term.onData((data) => {
			if (view.mode === "line") {
				lineInput(data);
			} else {
				sendRaw(data);
			}
		});
		ctx.api("GET", "/devices/" + device + "/term").then((r) => {
			if (r.data) {
				term.write(fromBase64(r.data));
			}
		}, fail);
		return {
			resize: () => fit.fit(),
			destroy: () => {
				term.dispose();
				term = null;
			}
		};
	});

	const st = (k) => () => (view.status ? view.status[k] : "");

	return el("div", { class: "terminal" },
		toolbar(
			el("span", { class: () => "state " + (view.status && view.status.connected ? "running" : "error"), title: () => (view.status && view.status.path) || "" },
				() => (view.status ? (view.status.connected ? String(view.status.path).split("/").pop() : "disconnected") : "…")),
			select(BAUDS, st("baud"), (v) => set({ baud: Number(v) }), "baud"),
			select(FORMATS, st("format"), (v) => set({ format: v }), "data bits, parity, stop bits"),
			select(EOLS, st("eol"), (v) => set({ eol: v }), "line ending sent in line mode"),
			select(["text", "hex"], st("display"), (v) => set({ display: v }), "how received bytes are shown and logged"),
			select(["raw", "line"], () => view.mode, (v) => {
				view.mode = v;
				line = "";
				if (term) {
					term.focus();
				}
			}, "raw: keystrokes go out as typed; line: edit locally, send on Enter"),
			iconButton("⌫", "clear screen", () => term && term.clear()),
			el("span", { class: "muted mono" }, () => (view.status ? "rx " + view.status.rxBytes + " / tx " + view.status.txBytes + " B" : ""))),
		when(() => view.error, () => el("div", { class: "error pad" }, () => view.error)),
		screen);
};

export default pane((ctx, p) => when(
	() => p.pane.config.device,
	(device) => terminal(ctx, p, device),
	() => empty("set config.device to a uart device id")
));
