// Custom panes: a declarative layout of SDK elements, built by Python bridges
// (python/mailab_ui.py) or by the AI (pane_add type custom). Controls run
// device commands as the person clicking them.
//
// node: {row: [...]} {col: [...]} {text: "markdown, {{channel}} = live value"}
//       {value: channel, label, precision} {chart: [channels], seconds}
//       {button: label, device, command, args} {toggle: label, device, command, arg, channel}
//       {slider: label, device, command, arg, min, max, step, channel}
//       {number: label, device, command, arg, unit, channel, value} {table: valueName} {image: name}
// text takes {{channel}} or {{channel|digits}}; number opens a keypad on tap and
// sends the value in base units (unit picks the prefix buttons: V -> mV/V/kV)

import { el, list, onDispose, state, when } from "@nemanjan00/qrp";
import { empty, numberField, pane } from "../sdk/index.js";
import chartPane from "./chart.js";
import { renderMarkdown } from "./markdown.js";
import { channelUnit, eng, escapeHtml, formatPlaceholder, liveValue } from "./util.js";
import placeholders from "../../src/utils/placeholders/index.js";

const live = liveValue;
const unitOf = channelUnit;

const run = (ctx, node, ui, args) => {
	ui.status = "…";
	return ctx.api("POST", "/devices/" + node.device + "/command", { command: node.command, args: args })
		.then(() => {
			ui.status = "";
		}, (err) => {
			ui.status = "⚠ " + err.message;
		});
};

const controls = {
	row: (ctx, node) => el("div", { class: "c-row" }, ...node.row.map((n) => render(ctx, n))),
	col: (ctx, node) => el("div", { class: "c-col" }, ...node.col.map((n) => render(ctx, n))),

	text: (ctx, node) => {
		const box = el("div", { class: "md c-text" });
		// {{channel}} placeholders follow live values
		const fill = () => placeholders.fill(node.text, (name, precision) => formatPlaceholder(ctx, name, precision));
		return el("div", {}, () => {
			box.innerHTML = renderMarkdown(fill());
			return box;
		});
	},

	value: (ctx, node) => el("div", { class: "c-value" },
		el("div", { class: "muted" }, node.label || node.value),
		el("div", { class: "num" }, () => {
			const v = live(ctx, node.value);
			return v === undefined ? "—" : Number(v).toFixed(node.precision === undefined ? 3 : node.precision) + " " + unitOf(ctx, node.value);
		})),

	button: (ctx, node) => {
		const ui = state({ status: "" });
		return el("span", { class: "c-control" },
			el("button", { onclick: () => run(ctx, node, ui, node.args || {}) }, node.button),
			el("span", { class: "muted" }, () => ui.status));
	},

	toggle: (ctx, node) => {
		const ui = state({ status: "", on: false });
		const isOn = () => (node.channel ? Boolean(live(ctx, node.channel)) : ui.on);
		return el("span", { class: "c-control" },
			el("button", {
				class: () => (isOn() ? "primary" : ""),
				onclick: () => {
					const next = !isOn();
					ui.on = next;
					run(ctx, node, ui, Object.assign({}, node.args || {}, { [node.arg || "on"]: next }));
				}
			}, () => node.toggle + (isOn() ? ": on" : ": off")),
			el("span", { class: "muted" }, () => ui.status));
	},

	slider: (ctx, node) => {
		const ui = state({ status: "", value: node.value === undefined ? node.min || 0 : node.value });
		return el("label", { class: "c-control c-slider" }, node.slider + " ",
			el("input", {
				type: "range", min: node.min || 0, max: node.max === undefined ? 1 : node.max, step: node.step || "any", value: ui.value,
				oninput: (e) => {
					ui.value = Number(e.target.value);
				},
				onchange: () => run(ctx, node, ui, Object.assign({}, node.args || {}, { [node.arg || "value"]: ui.value }))
			}),
			el("span", { class: "mono" }, () => ui.value + (node.unit ? " " + node.unit : "")),
			el("span", { class: "muted" }, () => ui.status));
	},

	number: (ctx, node) => {
		const ui = state({ status: "" });
		// tap for a keypad, or type with suffixes (2.4G, 100m); value in base units
		const input = numberField({
			unit: node.unit,
			value: node.value,
			class: "c-number",
			onSet: (v) => run(ctx, node, ui, Object.assign({}, node.args || {}, { [node.arg || "value"]: v }))
		});
		return el("span", { class: "c-control" }, node.number + " ", input,
			node.channel ? el("span", { class: "muted" }, () => " now " + eng(live(ctx, node.channel)) + unitOf(ctx, node.channel)) : "",
			el("span", { class: "muted" }, () => ui.status));
	},

	chart: (ctx, node) => {
		const host = el("div", { class: "c-chart" });
		// reuse the chart pane module on a sub-element
		let inst = null;
		let gone = false;
		requestAnimationFrame(() => {
			if (!gone) {
				inst = chartPane.mount(host, { id: "", config: { channels: [].concat(node.chart), seconds: node.seconds || 30 } }, ctx);
			}
		});
		onDispose(() => {
			gone = true;
			if (inst) {
				inst.destroy();
			}
		});
		return host;
	},

	table: (ctx, node) => {
		const view = state({ rows: [] });
		const load = () => ctx.api("GET", "/values/" + encodeURIComponent(node.table)).then((v) => {
			view.rows = [].concat(v.value || []);
		}, () => null);
		load();
		onDispose(ctx.on("value", (msg) => {
			if (msg.value.name === node.table) {
				view.rows = [].concat(msg.value.value || []);
			}
		}));
		return el("table", {}, el("tbody", {}, list(() => view.rows.map((r, i) => ({ i: i, r: r })), (x) => x.i,
			(x) => el("tr", {}, ...(typeof x.r === "object" ? Object.keys(x.r).map((k) => el("td", {}, escapeHtml(String(x.r[k])))) : [el("td", {}, String(x.r))])))));
	},

	image: (ctx, node) => {
		const img = el("img", { class: "c-image", alt: node.image });
		const load = () => {
			img.src = "/api/images/" + encodeURIComponent(node.image) + "?t=" + Date.now();
		};
		load();
		onDispose(ctx.on("image", (msg) => {
			if (msg.name === node.image) {
				load();
			}
		}));
		return img;
	}
};

// controls first: their nodes may also carry e.g. a `value` default
const KINDS = ["row", "col", "button", "toggle", "slider", "number", "chart", "table", "image", "text", "value"];

const render = (ctx, node) => {
	const kind = KINDS.find((k) => node && node[k] !== undefined && node[k] !== null);
	if (!kind) {
		return el("div", { class: "error" }, "unknown element: " + JSON.stringify(node).slice(0, 80));
	}
	return controls[kind](ctx, node);
};

export default pane((ctx, p) => when(
	() => p.pane.config.layout,
	(layout) => el("div", { class: "custom pad" }, render(ctx, layout)),
	() => empty("set config.layout (a tree of row/col/text/value/button/toggle/slider/number/chart/table/image)")
));
