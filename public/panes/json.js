// JSON view of a lab value (flowgraph graph/stats, AI findings, decoded data)
// or of a trace / channel description.

import { updateTree } from "./tree.js";
import { escapeHtml } from "./util.js";

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		body.innerHTML = "<div class=\"pad mono jsonview\"></div>";
		const view = body.querySelector(".jsonview");

		const render = (doc) => {
			updateTree(view, doc, Number(pane.config.depth) || 2);
		};

		const load = () => {
			const name = pane.config.value;
			if (!name) {
				view.innerHTML = "<span class=\"muted\">set config.value (a lab value name; see the channels pane)</span>";
				return;
			}
			ctx.api("GET", "/values/" + encodeURIComponent(name)).then((v) => {
				render(v.value);
			}, (err) => {
				view.innerHTML = "<span class=\"muted\">" + escapeHtml(err.message) + "</span>";
			});
		};

		const off = ctx.on("value", (msg) => {
			if (msg.value.name === pane.config.value) {
				render(msg.value.value);
			}
		});
		load();

		return {
			update: (next) => {
				pane = next;
				load();
			},
			destroy: off
		};
	}
};
