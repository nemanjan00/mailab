// JSON view of a lab value (flowgraph graph/stats, AI findings, decoded data)
// or of a trace / channel description. config.view "table" shows tabular
// values (arrays of objects, sweep results) as a sortable, filterable table.

import { mount, state } from "@nemanjan00/qrp";
import { objectTable } from "../sdk/index.js";
import tableUtil from "../../src/utils/table/index.js";
import { updateTree } from "./tree.js";
import { escapeHtml } from "./util.js";

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		body.innerHTML = "<div class=\"pad mono jsonview\"></div>";
		const view = body.querySelector(".jsonview");

		// qrp table, mounted while config.view is "table"
		let tabular = null;

		const dropTable = () => {
			if (tabular) {
				tabular.mounted.dispose();
				tabular = null;
				view.innerHTML = "";
			}
		};

		const renderTable = (doc) => {
			if (!tabular) {
				view.innerHTML = "";
				const data = state({ rows: [] });
				tabular = { data: data, mounted: mount(view, () => objectTable({ rows: () => data.rows, name: pane.config.value })) };
			}
			tabular.data.rows = tableUtil.rowsOf(doc);
		};

		const render = (doc) => {
			if (pane.config.view === "table") {
				renderTable(doc);
				return;
			}
			dropTable();
			updateTree(view, doc, Number(pane.config.depth) || 2);
		};

		const load = () => {
			const name = pane.config.value;
			if (!name) {
				dropTable();
				view.innerHTML = "<span class=\"muted\">set config.value (a lab value name; see the channels pane)</span>";
				return;
			}
			ctx.api("GET", "/values/" + encodeURIComponent(name)).then((v) => {
				render(v.value);
			}, (err) => {
				dropTable();
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
			destroy: () => {
				off();
				dropTable();
			}
		};
	}
};
