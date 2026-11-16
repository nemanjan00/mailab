// x/y plot of captured traces: spectra, VNA sweeps, scope & logic captures
// (uPlot, with markers + readings table), and canvas modes: glitch scatter,
// constellation, eye diagram.

import { axisStyle, eng, frameThrottle } from "./util.js";
import { CANVAS_MODES } from "./plot2d.js";
import { computeReadings, drawMarkers, readingsTable } from "./markers.js";

const LEGEND_HEIGHT = 28;

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		let plot = null;
		let canvas = null;
		let signature = "";
		let readings = [];
		let plotEl = null;
		let tableEl = null;
		body.classList.add("fill");

		const hasMarkers = () => (pane.config.markers || []).length > 0 || Number(pane.config.peaks) > 0;

		// plot gets whatever the readings table leaves
		const size = () => {
			const tableHeight = tableEl ? tableEl.offsetHeight : 0;
			return { width: Math.max(50, body.clientWidth), height: Math.max(40, body.clientHeight - LEGEND_HEIGHT - tableHeight) };
		};

		const saveMarkers = (markers) => {
			return ctx.api("PATCH", "/panes/" + pane.id, { config: { markers: markers } });
		};

		const refreshReadings = (trs) => {
			if (!tableEl) {
				return;
			}
			readings = hasMarkers() ? computeReadings(trs, pane.config) : [];
			const before = tableEl.offsetHeight;
			tableEl.innerHTML = readingsTable(readings);
			if (plot && tableEl.offsetHeight !== before) {
				plot.setSize(size());
			}
		};

		const names = () => [].concat(pane.config.traces || pane.config.trace || []);

		const loaded = () => names().map((n) => ctx.traces[n]).filter(Boolean);

		const teardown = () => {
			if (plot) {
				plot.destroy();
				plot = null;
			}
			canvas = null;
			plotEl = null;
			tableEl = null;
			body.innerHTML = "";
		};

		const buildLine = (trs) => {
			const axis = axisStyle();
			const series = [{}];
			const tables = [];
			let rightAxis = false;
			trs.forEach((tr) => {
				tr.series.forEach((s) => {
					const right = s.axis === "right";
					rightAxis = rightAxis || right;
					series.push({
						label: (trs.length > 1 ? tr.name + " " : "") + s.label,
						stroke: ctx.color(series.length - 1),
						width: 1.25,
						scale: right ? "y2" : "y",
						points: { show: false },
						paths: tr.mode === "step" ? uPlot.paths.stepped({ align: 1 }) : undefined,
						value: (_u, v) => (v === null || v === undefined ? "—" : eng(v) + (right ? "" : tr.yUnit))
					});
					tables.push([tr.x, s.y]);
				});
			});
			const scaleY = { auto: true };
			if (pane.config.yMin !== undefined && pane.config.yMax !== undefined) {
				scaleY.auto = false;
				scaleY.range = [Number(pane.config.yMin), Number(pane.config.yMax)];
			}
			const axes = [
				Object.assign({}, axis, { values: (_u, ticks) => ticks.map((v) => eng(v, 1) + trs[0].xUnit) }),
				Object.assign({}, axis, { size: 72, values: (_u, ticks) => ticks.map((v) => eng(v, 1)) })
			];
			if (rightAxis) {
				axes.push(Object.assign({}, axis, { scale: "y2", side: 1, grid: { show: false } }));
			}
			plotEl = document.createElement("div");
			tableEl = document.createElement("div");
			tableEl.className = "readings-wrap";
			body.appendChild(plotEl);
			body.appendChild(tableEl);
			refreshReadings(trs);
			plot = new uPlot(Object.assign({
				scales: { x: { time: false, distr: pane.config.logX ? 3 : 1 }, y: scaleY, y2: { auto: true } },
				axes: axes,
				series: series,
				cursor: { drag: { x: true, y: false } },
				hooks: {
					draw: [(u) => {
						drawMarkers(u, readings);
					}]
				}
			}, size()), tables.length === 1 ? tables[0] : uPlot.join(tables), plotEl);
			// shift-click: marker at the cursor's x
			plot.over.addEventListener("click", (event) => {
				if (!event.shiftKey) {
					return;
				}
				const x = plot.posToVal(plot.cursor.left, "x");
				saveMarkers((pane.config.markers || []).concat([{ mode: "x", x: x }]));
			});
			tableEl.addEventListener("click", (event) => {
				const button = event.target.closest("button[data-remove]");
				if (!button) {
					return;
				}
				const index = Number(button.dataset.remove);
				saveMarkers((pane.config.markers || []).filter((_m, i) => i !== index));
			});
		};

		const render = frameThrottle(() => {
			const trs = loaded();
			if (!names().length) {
				teardown();
				body.innerHTML = "<div class=\"empty\">set config.traces, e.g. [\"vna_s11\"]</div>";
				signature = "";
				return;
			}
			if (!trs.length) {
				teardown();
				body.innerHTML = "<div class=\"empty\">waiting for trace data…</div>";
				signature = "";
				return;
			}
			const draw = CANVAS_MODES[trs[0].mode];
			// rebuild uPlot only when the series layout changes
			const sig = JSON.stringify(trs.map((tr) => [tr.name, tr.mode, tr.series.map((s) => s.label)])) + document.documentElement.dataset.theme;
			if (draw) {
				if (!canvas) {
					teardown();
					canvas = document.createElement("canvas");
					canvas.className = "full";
					body.appendChild(canvas);
				}
				draw(canvas, trs[0], ctx.color);
				signature = "";
				return;
			}
			if (sig !== signature || !plot) {
				teardown();
				buildLine(trs);
				signature = sig;
				return;
			}
			const tables = [];
			trs.forEach((tr) => {
				tr.series.forEach((s) => {
					tables.push([tr.x, s.y]);
				});
			});
			refreshReadings(trs);
			plot.setData(tables.length === 1 ? tables[0] : uPlot.join(tables));
		});

		const fetchMissing = () => {
			names().filter((n) => !ctx.traces[n]).forEach((n) => {
				ctx.fetchTrace(n).catch(() => null);
			});
		};

		const offs = [
			ctx.on("trace", (tr) => {
				if (names().indexOf(tr.name) !== -1) {
					render();
				}
			}),
			ctx.on("theme", () => {
				signature = "";
				render();
			}),
			ctx.on("state", fetchMissing)
		];
		fetchMissing();
		render();

		return {
			update: (next) => {
				pane = next;
				signature = "";
				fetchMissing();
				render();
			},
			resize: () => {
				if (plot) {
					plot.setSize(size());
				}
				if (canvas) {
					render();
				}
			},
			destroy: () => {
				offs.forEach((off) => off());
				teardown();
			}
		};
	}
};
