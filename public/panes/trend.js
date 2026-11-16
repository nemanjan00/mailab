// Long-term trends (Grafana-like): mean line inside a min/max band, with a
// timeframe picker; data comes from the server's tiered buckets.

import uPlot from "uplot";
import { el, state } from "@nemanjan00/qrp";
import { pane, widget } from "../sdk/index.js";
import { axisStyle, eng } from "./util.js";

const RANGES = [["5m", 300], ["1h", 3600], ["6h", 21600], ["24h", 86400], ["7d", 604800], ["30d", 2592000]];
const REFRESH_MS = 5000;
const LEGEND = 28;
const TOOLBAR = 34;

export default pane((ctx, p) => {
	const view = state({ range: p.pane.config.range || "6h", tier: "" });
	let plot = null;
	let host = null;
	let timer = null;

	const channels = () => [].concat(p.pane.config.channels || []);
	const seconds = () => (RANGES.find((r) => r[0] === view.range) || RANGES[2])[1];

	const build = (data) => {
		if (plot) {
			plot.destroy();
		}
		const axis = axisStyle();
		const series = [{}];
		const bands = [];
		channels().forEach((name, i) => {
			const color = ctx.color(i);
			series.push({ label: name + " max", stroke: color + "55", width: 1, points: { show: false } });
			series.push({ label: name + " min", stroke: color + "55", width: 1, points: { show: false } });
			series.push({ label: name, stroke: color, width: 1.6, points: { show: false }, value: (_u, v) => (v === null || v === undefined ? "—" : eng(v)) });
			const base = 1 + i * 3;
			bands.push({ series: [base, base + 1], fill: color + "22" });
		});
		plot = new uPlot({
			width: Math.max(50, host.clientWidth),
			height: Math.max(40, host.clientHeight - LEGEND),
			scales: { x: { time: true } },
			axes: [axis, Object.assign({}, axis, { size: 64, values: (_u, ticks) => ticks.map((v) => eng(v, 1)) })],
			series: series,
			bands: bands,
			legend: { live: true }
		}, data, host);
	};

	const load = () => {
		const names = channels();
		if (!names.length || !host) {
			return;
		}
		const to = Date.now();
		const from = to - seconds() * 1000;
		Promise.all(names.map((n) => ctx.api("GET", "/trends/" + encodeURIComponent(n) + "?from=" + from + "&to=" + to + "&points=800")))
			.then((results) => {
				view.tier = results[0] ? results[0].tier : "";
				const tables = results.map((r) => [r.t.map((t) => t / 1000), r.max, r.min, r.mean]);
				// join on time; each channel contributes max, min, mean columns
				const joined = tables.length === 1 ? tables[0] : uPlot.join(tables.map((tb) => [tb[0], tb[1], tb[2], tb[3]]));
				build(joined);
				plot.setScale("x", { min: from / 1000, max: to / 1000 });
			}, () => null);
	};

	return el("div", { class: "trend" },
		el("div", { class: "toolbar pad" },
			...RANGES.map((r) => el("button", {
				class: () => (view.range === r[0] ? "primary" : ""),
				onclick: () => {
					view.range = r[0];
					load();
				}
			}, r[0])),
			el("span", { class: "muted" }, () => (view.tier ? "resolution " + view.tier : ""))),
		widget((h) => {
			host = h;
			host.style.height = "calc(100% - " + TOOLBAR + "px)";
			load();
			timer = setInterval(load, REFRESH_MS);
			return {
				resize: () => {
					if (plot) {
						plot.setSize({ width: Math.max(50, host.clientWidth), height: Math.max(40, host.clientHeight - LEGEND) });
					}
				},
				destroy: () => {
					clearInterval(timer);
					if (plot) {
						plot.destroy();
					}
				}
			};
		}));
});
