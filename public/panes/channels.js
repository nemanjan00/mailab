// Everything the lab holds: channels (live values), traces, JSON values and
// binary blobs, each with a one-click "show it in a pane".

import { el, list, when } from "@nemanjan00/qrp";
import { empty, iconButton, pane } from "../sdk/index.js";
import { eng } from "./util.js";

const show = (ctx, icon, title, spec) => iconButton(icon, title, () => ctx.api("POST", "/panes", spec));

// one table, four keyed sections
const sections = (ctx) => [
	{
		rows: () => ctx.state.channels,
		key: (c) => "c:" + c.name,
		latest: (c) => {
			let v = ctx.store.live[c.name];
			if (v === undefined && c.latest) {
				v = c.latest.v;
			}
			return eng(v) + (c.unit || "");
		},
		source: (c) => c.source || "",
		actions: (c) => [
			show(ctx, "📈", "chart", { type: "chart", title: c.name, config: { channels: [c.name], seconds: 30 } }),
			show(ctx, "#", "readout", { type: "value", title: c.name, w: 3, h: 3, config: { channel: c.name } })
		]
	},
	{
		rows: () => ctx.state.traces,
		key: (t) => "t:" + t.name,
		latest: (t) => t.points + " pts",
		source: (t) => "trace · " + t.mode,
		actions: (t) => [
			show(ctx, "📈", "plot", { type: "trace", title: t.name, config: { traces: [t.name] } }),
			show(ctx, "≋", "waterfall", { type: "waterfall", title: t.name + " waterfall", config: { trace: t.name } })
		]
	},
	{
		rows: () => ctx.state.values || [],
		key: (v) => "v:" + v.name,
		latest: () => "json",
		source: (v) => "value · " + (v.source || ""),
		actions: (v) => [show(ctx, "{}", "json view", { type: "json", title: v.name, config: { value: v.name } })]
	},
	{
		rows: () => ctx.state.blobs || [],
		key: (b) => "b:" + b.name,
		latest: (b) => b.bytes + " B",
		source: (b) => "blob · " + (b.source || ""),
		actions: (b) => [
			show(ctx, "∿", "analyze (entropy, binwalk)", { type: "blob", title: b.name, config: { blob: b.name } }),
			show(ctx, "⬚", "kaitai view", { type: "kaitai", title: b.name, config: { blob: b.name, ksy: "" } })
		]
	}
];

const row = (section) => (item) => el("tr", {},
	el("td", { class: "mono" }, () => item.name),
	el("td", { class: "num" }, () => section.latest(item)),
	el("td", { class: "muted" }, () => section.source(item)),
	el("td", {}, section.actions(item)));

export default pane((ctx) => {
	const parts = sections(ctx);
	const total = () => parts.reduce((n, s) => n + s.rows().length, 0);
	return when(() => total() > 0,
		() => el("table", {},
			el("thead", {}, el("tr", {}, el("th", {}, "name"), el("th", {}, "latest"), el("th", {}, "source"), el("th"))),
			el("tbody", {}, ...parts.map((s) => list(s.rows, s.key, row(s))))),
		() => empty("no data yet"));
});
