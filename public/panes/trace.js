// x/y plot of captured traces: spectra, VNA sweeps, scope & logic captures
// (uPlot, with markers + readings table), and canvas modes: glitch scatter,
// constellation, eye diagram.
import uPlot from "uplot";
import { el, mount, state } from "@nemanjan00/qrp";
import { tableState } from "../sdk/index.js";

import { axisStyle, eng, frameThrottle } from "./util.js";
import { CANVAS_MODES, drawMap } from "./plot2d.js";
import { computeReadings, drawMarkers, measurementsTable, readingRows, readingsTable } from "./markers.js";

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
		let measEl = null;
		// readings table: qrp-mounted under tableEl, fed through readingsState
		let readingsMount = null;
		// filtering / sorting the readings changes the table's height: refit the plot
		const tableResize = new ResizeObserver(() => {
			if (plot) {
				plot.setSize(size());
			}
		});
		const readingsState = state({ rows: [] });
		const readingsUi = tableState();
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

		const removeMarker = (index) => saveMarkers((pane.config.markers || []).filter((_m, i) => i !== index));

		const refreshReadings = (trs) => {
			if (!tableEl) {
				return;
			}
			readings = hasMarkers() ? computeReadings(trs, pane.config) : [];
			const before = tableEl.offsetHeight;
			measEl.innerHTML = measurementsTable(trs[0] && trs[0].measurements);
			readingsState.rows = readingRows(readings);
			if (plot && tableEl.offsetHeight !== before) {
				plot.setSize(size());
			}
		};

		const names = () => [].concat(pane.config.traces || pane.config.trace || []);

		// manual zoom windows (null = auto). horizontal scroll zooms time,
		// vertical scroll zooms V; ctrl+scroll drives the scope's timebase,
		// shift+scroll its V/div (drivers with a settings model, e.g. mho900)
		const zoomState = { x: null, y: null };
		let scopeCache = { t: 0, model: null };
		const scopeModel = () => {
			if (!pane.config.device) {
				return Promise.resolve(null);
			}
			if (scopeCache.model && Date.now() - scopeCache.t < 3000) {
				return Promise.resolve(scopeCache.model);
			}
			return ctx.api("GET", "/values/" + pane.config.device + "_settings").then((entry) => {
				scopeCache = { t: Date.now(), model: entry.value };
				return entry.value;
			}, () => null);
		};
		// scope scales live on a 1-2-5 ladder: step to the adjacent rung
		const MANTISSAS = [1, 2, 5];
		const ladderStep = (v, inOut) => {
			let p = Math.pow(10, Math.floor(Math.log10(v)));
			const m = v / p;
			let i = MANTISSAS.findIndex((x) => Math.abs(x - m) < 1e-9);
			if (i === -1) {
				// off-ladder value: snap to the nearest rung first
				return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
			}
			i += inOut;
			while (i < 0) {
				p /= 10;
				i += 3;
			}
			while (i > 2) {
				p *= 10;
				i -= 3;
			}
			return MANTISSAS[i] * p;
		};
		// ctrl wheel -> scope timebase (t/div), shift wheel -> channel V/div;
		// falls back to plain zoom for drivers without a settings model
		const scopeWheel = (event, ax, zoomIn) => {
			scopeModel().then((model) => {
				if (!model || !plot) {
					return;
				}
				const dev = pane.config.device;
				if (event.ctrlKey) {
					const cur = model.timebase && model.timebase.scale;
					if (!cur) {
						return;
					}
					const next = ladderStep(cur, zoomIn ? -1 : 1);
					zoomState.x = null;
					zoomState.y = null;
					ctx.api("POST", "/devices/" + dev + "/command", { command: "set", args: { timebase: { scale: next } } }).catch(() => null);
					return;
				}
				if (event.shiftKey) {
					const label = plot.series.length > 1 ? String(plot.series[1].label || "") : "";
					const m = /CHAN(\d)/i.exec(label);
					const n = m ? parseInt(m[1], 10) : 1;
					const cur = model.ch && model.ch[String(n)] && model.ch[String(n)].scale;
					if (!cur) {
						return;
					}
					const next = ladderStep(cur, zoomIn ? -1 : 1);
					zoomState.x = null;
					zoomState.y = null;
					ctx.api("POST", "/devices/" + dev + "/command", { command: "set", args: { ch: { [n]: { scale: next } } } }).catch(() => null);
				}
			});
		};

		const loaded = () => names().map((n) => ctx.traces[n]).filter(Boolean);

		const teardown = () => {
			if (plot) {
				plot.destroy();
				plot = null;
			}
			if (readingsMount) {
				readingsMount.dispose();
				readingsMount = null;
			}
			tableResize.disconnect();
			canvas = null;
			plotEl = null;
			tableEl = null;
			measEl = null;
			body.innerHTML = "";
		};

		// [x, y] for uPlot; a log x axis can't take x <= 0 (a spectrum of real input starts at 0 Hz)
		const xyTable = (tr, s) => {
			if (!pane.config.logX) {
				return [tr.x, s.y];
			}
			const keep = tr.x.map((_x, i) => i).filter((i) => tr.x[i] > 0);
			return [keep.map((i) => tr.x[i]), keep.map((i) => s.y[i])];
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
					tables.push(xyTable(tr, s));
				});
			});
			const scaleY = { auto: true };
			if (pane.config.yMin !== undefined && pane.config.yMax !== undefined) {
				scaleY.auto = false;
				scaleY.range = [Number(pane.config.yMin), Number(pane.config.yMax)];
			}
			const axes = [
				// log axes hand unlabeled minor ticks in as null
				Object.assign({}, axis, { values: (_u, ticks) => ticks.map((v) => (v === null ? "" : eng(v, 1) + trs[0].xUnit)) }),
				Object.assign({}, axis, { size: 72, values: (_u, ticks) => ticks.map((v) => eng(v, 1) + trs[0].yUnit) })
			];
			if (rightAxis) {
				axes.push(Object.assign({}, axis, { scale: "y2", side: 1, grid: { show: false } }));
			}
			plotEl = document.createElement("div");
			tableEl = document.createElement("div");
			tableEl.className = "readings-wrap";
			measEl = el("div");
			tableEl.appendChild(measEl);
			const readingsHost = el("div");
			tableEl.appendChild(readingsHost);
			readingsMount = mount(readingsHost, () => readingsTable(() => readingsState.rows, removeMarker, readingsUi));
			body.appendChild(plotEl);
			body.appendChild(tableEl);
			tableResize.observe(tableEl);
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
			plotEl.title = "scroll h: time zoom, v: V zoom" + (pane.config.device ? "; ctrl: t/div, shift: V/div (scope)" : "");
			// shift-click: marker at the cursor's x
			plot.over.addEventListener("click", (event) => {
				if (!event.shiftKey) {
					return;
				}
				const x = plot.posToVal(plot.cursor.left, "x");
				saveMarkers((pane.config.markers || []).concat([{ mode: "x", x: x }]));
			});
			// wheel: zoom around the cursor; ctrl/shift wheel drives the scope
			plot.over.addEventListener("wheel", (event) => {
				if (!plot) {
					return;
				}
				event.preventDefault();
				const ax = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? "x" : "y";
				const delta = ax === "x" ? event.deltaX : event.deltaY;
				const zoomIn = ax === "x" ? delta > 0 : delta < 0;
				if (event.ctrlKey || event.shiftKey) {
					scopeWheel(event, ax, zoomIn);
					return;
				}
				const u = plot;
				const sc = u.scales[ax];
				if (sc.min === undefined || sc.max === undefined || sc.min === null || sc.max === null) {
					return;
				}
				const rect = u.over.getBoundingClientRect();
				const frac = ax === "x"
					? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
					: Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height));
				const pivot = sc.min + frac * (sc.max - sc.min);
				const f = zoomIn ? 1 / 1.25 : 1.25;
				const win = { min: pivot - (pivot - sc.min) * f, max: pivot + (sc.max - pivot) * f };
				zoomState[ax] = win;
				u.setScale(Object.assign({}, ax === "x" ? { x: win } : { y: win }));
			}, { passive: false });
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
			let draw = CANVAS_MODES[trs[0].mode];
			if (trs[0].mode === "scatter" && pane.config.view === "map") {
				draw = drawMap;
			}
			// rebuild uPlot only when the series layout changes
			const sig = JSON.stringify(trs.map((tr) => [tr.name, tr.mode, tr.series.map((s) => s.label)])) + document.documentElement.dataset.theme;
			if (draw) {
				if (!canvas) {
					teardown();
					canvas = document.createElement("canvas");
					canvas.className = "full";
					body.appendChild(canvas);
				}
				draw(canvas, trs[0], ctx.color, pane.config);
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
					tables.push(xyTable(tr, s));
				});
			});
			refreshReadings(trs);
			plot.setData(tables.length === 1 ? tables[0] : uPlot.join(tables), !(zoomState.x || zoomState.y));
			if (zoomState.x || zoomState.y) {
				const s = {};
				if (zoomState.x) {
					s.x = zoomState.x;
				}
				if (zoomState.y) {
					s.y = zoomState.y;
				}
				plot.setScale(s);
			}
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
