// Log classifier: templates with counts (their numbers are recorded as
// channels) and the unclassified clusters, biggest first. Turning a cluster
// into a template absorbs its backlog.

import { el, onDispose, state } from "@nemanjan00/qrp";
import { iconButton, pane, table } from "../sdk/index.js";
import { time } from "./util.js";

const REFRESH_MS = 2000;

export default pane((ctx) => {
	const view = state({ templates: [], unclassified: [], total: 0 });

	const load = () => ctx.api("GET", "/classifier").then((s) => {
		view.templates = s.templates;
		view.unclassified = s.unclassified;
		view.total = s.unclassifiedTotal;
	}, () => null);
	load();
	const timer = setInterval(load, REFRESH_MS);
	// the view runs in the pane's scope: stop polling when it's removed
	onDispose(() => clearInterval(timer));

	const makeTemplate = (cluster) => ctx.dialog("New template", [
		{ name: "name", value: "" },
		{ name: "pattern", value: cluster.signature, hint: "placeholders: <num> <hex> <ip> <uuid> <word> <*>\nexample: " + cluster.example }
	], (values) => ctx.api("POST", "/classifier/templates", { name: values.name, pattern: values.pattern }).then(load));

	return el("div", { class: "classifier" },
		el("div", { class: "pad muted" }, "templates"),
		table({
			rows: () => view.templates,
			key: (t) => t.name,
			empty: "no templates yet: turn a cluster below into one",
			columns: [
				{ title: "name", mono: true, value: (t) => t.name },
				{ title: "pattern", mono: true, value: (t) => t.pattern },
				{ title: "count", num: true, value: (t) => t.count },
				{ title: "last", muted: true, value: (t) => (t.last ? time(t.last) + "  " + (t.example || "") : "") },
				{
					value: (t) => [
						iconButton("📈", "chart count + values", () => ctx.api("POST", "/panes", { type: "chart", title: "classifier: " + t.name, config: { channels: ["cls_" + t.name + "_1"], seconds: 600 } })),
						iconButton("×", "remove", () => ctx.api("DELETE", "/classifier/templates/" + t.name).then(load))
					]
				}
			]
		}),
		el("div", { class: "pad muted" }, () => "unclassified: " + view.total + " lines in " + view.unclassified.length + " clusters"),
		table({
			rows: () => view.unclassified,
			key: (c) => c.signature,
			empty: "nothing unclassified",
			columns: [
				{ title: "×", num: true, value: (c) => c.count },
				{ title: "signature", mono: true, value: (c) => c.signature },
				{ title: "device", muted: true, value: (c) => c.device },
				{ value: (c) => iconButton("→", "make a template", () => makeTemplate(c)) }
			]
		})
	);
});
