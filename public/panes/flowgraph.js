// Flowgraph editor for a flowgraph device: blocks laid out left→right by
// depth, live rate/throughput/errors, click a block to edit or remove it.

import { escapeHtml, eng } from "./util.js";

const BOX_W = 150;
const BOX_H = 54;
const GAP_X = 50;
const GAP_Y = 18;

// column = longest path from a source
const layout = (graph) => {
	const parent = {};
	graph.links.forEach((l) => {
		parent[l[1]] = l[0];
	});
	const depth = (id, seen) => {
		if (!parent[id] || seen > 50) {
			return 0;
		}
		return depth(parent[id], seen + 1) + 1;
	};
	const rows = {};
	const pos = {};
	graph.blocks.forEach((b) => {
		const col = depth(b.id, 0);
		rows[col] = (rows[col] || 0) + 1;
		pos[b.id] = { x: 10 + col * (BOX_W + GAP_X), y: 10 + (rows[col] - 1) * (BOX_H + GAP_Y) };
	});
	return pos;
};

const parseJson = (text) => {
	try {
		return JSON.parse(text || "{}");
	} catch (err) {
		throw new Error("invalid JSON: " + err.message, { cause: err });
	}
};

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		let graph = { blocks: [], links: [] };
		let stats = {};
		let catalog = null;
		body.innerHTML = "<div class=\"fg-toolbar pad\"><button data-act=\"add\">+ block</button> <button data-act=\"connect\">connect</button> "
			+ "<button data-act=\"run\">pause</button> <span class=\"muted fg-status\"></span></div><div class=\"fg-canvas\"></div>";
		const canvas = body.querySelector(".fg-canvas");
		const status = body.querySelector(".fg-status");
		const device = () => pane.config.device;

		const command = (name, args) => {
			return ctx.api("POST", "/devices/" + device() + "/command", { command: name, args: args || {} });
		};

		const loadCatalog = () => {
			if (catalog) {
				return Promise.resolve(catalog);
			}
			return command("blocks").then((c) => {
				catalog = c;
				return c;
			});
		};

		const render = () => {
			if (!device()) {
				canvas.innerHTML = "<div class=\"empty\">set config.device to a flowgraph device id</div>";
				return;
			}
			const pos = layout(graph);
			const width = Object.values(pos).reduce((m, p) => Math.max(m, p.x + BOX_W + 10), 200);
			const height = Object.values(pos).reduce((m, p) => Math.max(m, p.y + BOX_H + 10), 80);
			const edges = graph.links.map((l) => {
				const a = pos[l[0]];
				const b = pos[l[1]];
				if (!a || !b) {
					return "";
				}
				const x1 = a.x + BOX_W;
				const y1 = a.y + BOX_H / 2;
				const x2 = b.x;
				const y2 = b.y + BOX_H / 2;
				const mid = (x1 + x2) / 2;
				return "<path class=\"fg-edge\" d=\"M" + x1 + " " + y1 + " C" + mid + " " + y1 + " " + mid + " " + y2 + " " + x2 + " " + y2 + "\"/>";
			}).join("");
			const boxes = graph.blocks.map((b) => {
				const p = pos[b.id];
				const s = stats[b.id] || {};
				const kind = (catalog && catalog[b.type] && catalog[b.type].kind) || "dsp";
				let info = "";
				if (s.rate) {
					info = eng(s.rate, 1) + "S/s";
				}
				// audio blocks: added latency, gain reduction, neural denoise state
				if (s.latency_ms) {
					info += " · " + s.latency_ms + "ms";
				}
				if (s.gr_db) {
					info += " · GR " + s.gr_db;
				}
				if (s.status && s.status !== "ready") {
					info += " · " + s.status;
				} else if (s.rtf !== undefined && s.rtf !== null) {
					info += " · rtf " + Number(s.rtf).toFixed(2);
				}
				return "<g class=\"fg-block " + kind + (s.error ? " err" : "") + "\" data-id=\"" + escapeHtml(b.id) + "\" transform=\"translate(" + p.x + "," + p.y + ")\">"
					+ "<rect width=\"" + BOX_W + "\" height=\"" + BOX_H + "\" rx=\"6\"/>"
					+ "<text x=\"10\" y=\"20\" class=\"fg-id\">" + escapeHtml(b.id) + "</text>"
					+ "<text x=\"10\" y=\"36\" class=\"fg-type\">" + escapeHtml(b.type) + "</text>"
					+ "<text x=\"10\" y=\"49\" class=\"fg-info\">" + escapeHtml(s.error ? "⚠ " + s.error.slice(0, 22) : info) + "</text>"
					+ "<title>" + escapeHtml(JSON.stringify(b.params || {}, null, 1) + (s.error ? "\n\n" + s.error : "")
						+ (s.latency_ms !== undefined ? "\n\nstats " + JSON.stringify(s, null, 1) : "")) + "</title></g>";
			}).join("");
			canvas.innerHTML = "<svg width=\"" + width + "\" height=\"" + height + "\">" + edges + boxes + "</svg>";
			if (!graph.blocks.length) {
				canvas.insertAdjacentHTML("beforeend", "<div class=\"empty\">empty graph — “+ block” or ask the AI to build one</div>");
			}
		};

		const load = () => {
			if (!device()) {
				render();
				return;
			}
			ctx.api("GET", "/values/" + device() + "_graph").then((v) => {
				graph = v.value;
				render();
			}, () => {
				render();
			});
			loadCatalog().then(render, (err) => {
				status.textContent = err.message;
			});
		};

		const editBlock = (id) => {
			const block = graph.blocks.find((b) => b.id === id);
			const doc = catalog && catalog[block.type];
			ctx.dialog("Block " + id + " (" + block.type + ")", [
				{ name: "params", type: "textarea", value: JSON.stringify(block.params || {}, null, 2), hint: doc ? doc.doc + "\n\n" + JSON.stringify(doc.params, null, 1) : "" },
				{ name: "action", type: "select", options: ["update", "remove"] }
			], (values) => {
				if (values.action === "remove") {
					return command("remove_block", { id: id });
				}
				const next = JSON.parse(JSON.stringify(graph));
				next.blocks.find((b) => b.id === id).params = parseJson(values.params);
				return command("set_graph", { graph: next });
			});
		};

		body.addEventListener("click", (event) => {
			const blockEl = event.target.closest(".fg-block");
			if (blockEl) {
				editBlock(blockEl.dataset.id);
				return;
			}
			const button = event.target.closest("button[data-act]");
			if (!button) {
				return;
			}
			const ids = graph.blocks.map((b) => b.id);
			if (button.dataset.act === "add") {
				loadCatalog().then((cat) => {
					const types = Object.keys(cat);
					ctx.dialog("Add block", [
						{ name: "type", type: "select", options: types, hint: (t) => cat[t].kind + ": " + cat[t].doc + "\n\n" + JSON.stringify(cat[t].params, null, 1) },
						{ name: "id", value: "" },
						{ name: "from", label: "input from", type: "select", options: ["(none)"].concat(ids) },
						{ name: "params", type: "textarea", value: "{}" }
					], (values) => {
						const args = { id: values.id || values.type + (ids.length + 1), type: values.type, params: parseJson(values.params) };
						if (values.from !== "(none)") {
							args.from = values.from;
						}
						return command("add_block", args);
					});
				});
			} else if (button.dataset.act === "connect") {
				ctx.dialog("Connect", [
					{ name: "from", type: "select", options: ids },
					{ name: "to", type: "select", options: ids }
				], (values) => command("connect", { from: values.from, to: values.to }));
			} else if (button.dataset.act === "run") {
				const on = button.textContent === "run";
				command("run", { on: on }).then(() => {
					button.textContent = on ? "pause" : "run";
				});
			}
		});

		const offs = [
			ctx.on("value", (msg) => {
				if (msg.value.name === device() + "_graph") {
					graph = msg.value.value;
					render();
				} else if (msg.value.name === device() + "_stats") {
					stats = msg.value.value;
					const errors = Object.keys(stats).filter((k) => stats[k].error).length;
					status.textContent = graph.blocks.length + " blocks" + (errors ? " · " + errors + " with errors" : "");
					render();
				}
			})
		];
		load();

		return {
			update: (next) => {
				pane = next;
				catalog = null;
				load();
			},
			destroy: () => {
				offs.forEach((off) => off());
			}
		};
	}
};
