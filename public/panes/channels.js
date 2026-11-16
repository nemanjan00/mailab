// Everything the lab holds: channels (live values), traces, JSON values and
// binary blobs, each with a one-click "show it in a pane".

import { iconButton, pane, table } from "../sdk/index.js";
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

export default pane((ctx) => {
	const parts = sections(ctx);
	// one row per item, tagged with its section
	const rows = () => parts.reduce((all, s, index) => all.concat(s.rows().map((item) => ({ s: index, item: item }))), []);
	const part = (x) => parts[x.s];
	return table({
		rows: rows,
		key: (x) => part(x).key(x.item),
		name: "channels",
		empty: "no data yet",
		columns: [
			{ title: "name", mono: true, value: (x) => x.item.name },
			{ title: "latest", num: true, value: (x) => part(x).latest(x.item) },
			{ title: "source", muted: true, value: (x) => part(x).source(x.item) },
			{ value: (x) => part(x).actions(x.item) }
		]
	});
});
