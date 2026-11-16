// Serial terminal for a `uart` device (USB-UART adapters): scrollback of
// rx / tx lines, an input line that sends text (or hex), and live baud,
// line ending and display (text / hex) switches. History with ↑ / ↓.

import { el, list, onDispose, state, when } from "@nemanjan00/qrp";
import { empty, iconButton, pane, toolbar } from "../sdk/index.js";
import { time } from "./util.js";

const MAX_LINES = 2000;
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 1500000, 2000000, 3000000];
const EOLS = ["lf", "crlf", "cr", "none"];
const LEVELS = ["rx", "tx", "warn", "error", "info"];

const select = (values, current, onchange) => el("select", { onchange: (e) => onchange(e.target.value) },
	...values.map((v) => el("option", { value: v, selected: () => String(current()) === String(v) }, String(v))));

const terminal = (ctx, device) => {
	const view = state({ lines: [], status: null, error: "", hexInput: false });
	const history = [];
	let historyAt = 0;
	let seq = 0;

	const add = (entry) => {
		seq++;
		view.lines = view.lines.concat([Object.assign({ key: seq }, entry)]).slice(-MAX_LINES);
	};

	const command = (name, args) => ctx.api("POST", "/devices/" + device + "/command", { command: name, args: args || {} });

	const refresh = () => command("status").then((s) => {
		view.status = s;
	}, (err) => {
		view.error = err.message;
	});

	ctx.api("GET", "/logs?device=" + encodeURIComponent(device)).then((entries) => {
		view.lines = entries.filter((e) => LEVELS.indexOf(e.level) !== -1).slice(-MAX_LINES).map((e) => {
			seq++;
			return Object.assign({ key: seq }, e);
		});
	});
	refresh();
	onDispose(ctx.on("log", (msg) => {
		if (msg.entry.device === device && LEVELS.indexOf(msg.entry.level) !== -1) {
			add(msg.entry);
		}
	}));

	const set = (changes) => command("set", changes).then((s) => {
		view.status = s;
		view.error = "";
	}, (err) => {
		view.error = err.message;
	});

	const input = el("input", {
		class: "mono term-input",
		placeholder: () => (view.hexInput ? "hex bytes, e.g. de ad be ef" : "send… (↑↓ history)"),
		onkeydown: (e) => {
			if (e.key === "Enter") {
				const text = input.value;
				history.push(text);
				historyAt = history.length;
				input.value = "";
				(view.hexInput ? command("write_hex", { hex: text }) : command("write", { text: text })).then(() => {
					view.error = "";
				}, (err) => {
					view.error = err.message;
				});
			} else if (e.key === "ArrowUp" && historyAt > 0) {
				historyAt--;
				input.value = history[historyAt];
				e.preventDefault();
			} else if (e.key === "ArrowDown" && historyAt < history.length) {
				historyAt++;
				input.value = history[historyAt] || "";
				e.preventDefault();
			}
		}
	});

	const scroll = el("div", { class: "term-feed mono" },
		list(() => view.lines, (l) => l.key, (l) => el("div", { class: "term-" + l.level },
			el("span", { class: "t" }, time(l.t) + " "),
			l.level === "tx" ? "› " : "",
			l.text)));
	new MutationObserver(() => {
		if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 60) {
			scroll.scrollTop = scroll.scrollHeight;
		}
	}).observe(scroll, { childList: true });

	const st = (k) => () => (view.status ? view.status[k] : "");

	return el("div", { class: "terminal" },
		toolbar(
			el("span", { class: () => "state " + (view.status && view.status.connected ? "running" : "error") },
				() => (view.status ? (view.status.connected ? view.status.path.split("/").pop() : "disconnected") : "…")),
			" ",
			select(BAUDS, st("baud"), (v) => set({ baud: Number(v) })),
			select(["8N1", "8E1", "8O1", "7E1", "7O1", "8N2"], st("format"), (v) => set({ format: v })),
			select(EOLS, st("eol"), (v) => set({ eol: v })),
			select(["text", "hex"], st("display"), (v) => set({ display: v })),
			el("label", { class: "muted" }, el("input", { type: "checkbox", onchange: (e) => {
				view.hexInput = e.target.checked;
			} }), " hex send"),
			iconButton("⌫", "clear scrollback", () => {
				view.lines = [];
			}),
			el("span", { class: "muted mono" }, () => (view.status ? " rx " + view.status.rxBytes + " / tx " + view.status.txBytes + " B" : ""))),
		when(() => view.error, () => el("div", { class: "error pad" }, () => view.error)),
		scroll,
		input);
};

export default pane((ctx, p) => when(
	() => p.pane.config.device,
	(device) => terminal(ctx, device),
	() => empty("set config.device to a uart device id")
));
