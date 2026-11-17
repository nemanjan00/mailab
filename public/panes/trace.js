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
		let wheelBurst = { t: 0, ax: null }; // trackpad diagonal/split-gesture suppression
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
		// the chart follows the scope's own windows: y = channel offset ± 4 divs
		// (manual zoom wins until a modifier scroll clears it)
		const applyScopeRanges = (model) => {
			if (!plot || !model || !pane.config.device || zoomState.y) {
				return;
			}
			const label = plot.series.length > 1 ? String(plot.series[1].label || "") : "";
			const m = /CHAN(\d)/i.exec(label);
			const ch = model.ch && model.ch[m ? m[1] : "1"];
			if (ch && ch.scale) {
				const off = Number(ch.offset) || 0;
				const half = 4 * Number(ch.scale);
				plot.setScale("y", { min: off - half, max: off + half });
			}
		};

		// local zoom around the cursor, on either axis; f is the window factor
		// (<1 zooms in) so callers can match exact steps (the scope's 1-2-5
		// ladder, e.g. 2x) instead of a smooth guess
		const zoomAt = (ax, zoomIn, event, f) => {
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
			const k = f || (zoomIn ? 1 / 1.25 : 1.25);
			const win = { min: pivot - (pivot - sc.min) * k, max: pivot + (sc.max - pivot) * k };
			zoomState[ax] = win;
			u.setScale(ax, win);
		};
		// after a modifier scroll the local zoom is an ESTIMATE of the new
		// acquisition; it expires once the scope catches up (or after 2.5 s)
		let scopeFitTimer = null;
		const scopeEstimate = (ax, zoomIn, event, ratio) => {
			zoomAt(ax, zoomIn, event, ratio);
			clearTimeout(scopeFitTimer);
			scopeFitTimer = setTimeout(() => {
				zoomState.x = null;
				zoomState.y = null;
				render();
			}, 2500);
		};

		// ctrl wheel -> scope parameter on the gesture's axis: horizontal
		// scroll steps the timebase (t/div), vertical the channel V/div; the
		// local zoom estimate shows the result before the acquisition lands
		const scopeWheel = (event, ax, zoomIn) => {
			scopeModel().then((model) => {
				if (!model || !plot) {
					return;
				}
				const dev = pane.config.device;
				const step = (cur, next) => {
					// the estimate zooms by the exact ladder ratio so frontend and
					// scope land on the same values
					scopeEstimate(ax, zoomIn, event, zoomIn ? cur / next : next / cur);
				};
				if (ax === "x") {
					const cur = model.timebase && model.timebase.scale;
					if (!cur) {
						return;
					}
					const next = ladderStep(cur, zoomIn ? -1 : 1);
					step(cur, next);
					ctx.api("POST", "/devices/" + dev + "/command", { command: "set", args: { timebase: { scale: next } } }).catch(() => null);
					return;
				}
				const label = plot.series.length > 1 ? String(plot.series[1].label || "") : "";
				const m = /CHAN(\d)/i.exec(label);
				const n = m ? parseInt(m[1], 10) : 1;
				const cur = model.ch && model.ch[String(n)] && model.ch[String(n)].scale;
				if (!cur) {
					return;
				}
				const next = ladderStep(cur, zoomIn ? -1 : 1);
				step(cur, next);
				ctx.api("POST", "/devices/" + dev + "/command", { command: "set", args: { ch: { [n]: { scale: next } } } }).catch(() => null);
			});
		};

		const loaded = () => names().map((n) => ctx.traces[n]).filter(Boolean);

		// trigger markers (scope model): a draggable horizontal trigger-level
		// line and a draggable vertical trigger-position line; committed to the
		// scope through `set` on release
		let trigDrag = null; // {kind: "level"|"offset", value}
		const triggerGeom = () => {
			const model = scopeCache.model;
			if (!model || !pane.config.device || !model.trigger) {
				return null;
			}
			return {
				level: model.trigger.level,
				offset: model.timebase ? model.timebase.offset : undefined
			};
		};
		const drawTriggers = (u) => {
			const g = triggerGeom();
			if (!g) {
				return;
			}
			const level = trigDrag && trigDrag.kind === "level" ? trigDrag.value : g.level;
			const offset = trigDrag && trigDrag.kind === "offset" ? trigDrag.value : g.offset;
			const c = u.ctx;
			const flag = (x, y, dir, color, label) => {
				// scope-style marker: a square on the plot edge with a filled
				// triangle pointer at the trigger value
				const s = 14;
				const t = 9;
				c.fillStyle = color;
				c.beginPath();
				if (dir === "left") {
					c.moveTo(x, y);
					c.lineTo(x + t, y - t / 2);
					c.lineTo(x + t, y + t / 2);
				} else {
					c.moveTo(x, y);
					c.lineTo(x - t / 2, y + t);
					c.lineTo(x + t / 2, y + t);
				}
				c.closePath();
				c.fill();
				c.fillRect(x - s / 2, y - s / 2, s, s);
				c.fillStyle = "#fff";
				c.font = "bold 10px sans-serif";
				c.textAlign = "center";
				c.textBaseline = "middle";
				c.fillText(label, x, y + 0.5);
				c.textAlign = "left";
				c.textBaseline = "alphabetic";
			};
			c.save();
			c.font = "10px sans-serif";
			if (typeof level === "number") {
				const y = u.valToPos(level, "y", true);
				if (y >= u.bbox.top && y <= u.bbox.top + u.bbox.height) {
					c.strokeStyle = "#e0534f";
					c.setLineDash([6, 4]);
					c.beginPath();
					c.moveTo(u.bbox.left, y);
					c.lineTo(u.bbox.left + u.bbox.width, y);
					c.stroke();
					c.setLineDash([]);
					// the flag sits on the plot edge, half inside it, so the grab
					// area stays inside the overlay that receives pointer events
					flag(u.bbox.left + u.bbox.width - 8, y, "left", "#e0534f", "T");
				}
			}
			if (typeof offset === "number") {
				const x = u.valToPos(offset, "x", true);
				if (x >= u.bbox.left && x <= u.bbox.left + u.bbox.width) {
					c.strokeStyle = "#e0a34f";
					c.setLineDash([6, 4]);
					c.beginPath();
					c.moveTo(x, u.bbox.top);
					c.lineTo(x, u.bbox.top + u.bbox.height);
					c.stroke();
					c.setLineDash([]);
					flag(x, u.bbox.top + u.bbox.height - 8, "up", "#e0a34f", "trig");
				}
			}
			c.restore();
		};
		// coordinate helpers: uPlot's valToPos(..., true) is canvas-relative;
		// the overlay element's origin sits bbox.left/top inside the canvas
		const overX = (v) => plot.valToPos(v, "x", true) - plot.bbox.left;
		const overY = (v) => plot.valToPos(v, "y", true) - plot.bbox.top;
		const fromOverX = (px) => plot.posToVal(px + plot.bbox.left, "x");
		const fromOverY = (px) => plot.posToVal(px + plot.bbox.top, "y");

		const teardown = () => {
			trigDrag = null;
			clearTimeout(scopeFitTimer);
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
						drawTriggers(u);
					}]
				}
			}, size()), tables.length === 1 ? tables[0] : uPlot.join(tables), plotEl);
			window.__tracePlot = plot; // debug/verification handle
			plotEl.title = "scroll: zoom (h=time, v=V)" + (pane.config.device ? "; ctrl+scroll: drive the scope" : "");
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
				// trackpads report diagonal deltas and some split one gesture
				// into an X and a Y event: keep the first axis of a burst and
				// drop the other-axis echo
				const now = Date.now();
				if (now - wheelBurst.t < 100 && wheelBurst.ax && wheelBurst.ax !== ax) {
					return;
				}
				wheelBurst = { t: now, ax: ax };
				// ctrl = drive the scope (axis picks the parameter: h -> timebase,
				// v -> V/div) with a local zoom estimate; browsers encode
				// shift+wheel as HORIZONTAL scroll, so shift is ignored here
				if (event.ctrlKey) {
					scopeWheel(event, ax, zoomIn);
					return;
				}
				zoomAt(ax, zoomIn, event);
			}, { passive: false });
			// trigger marker dragging: grab near a line, drag, release to commit.
			// listeners live on the plot root (covers the flags on the edges)
			const grab = plot.root || plot.over;
			grab.addEventListener("mousedown", (event) => {
				const g = triggerGeom();
				if (!g || event.button !== 0) {
					return;
				}
				const rect = plot.over.getBoundingClientRect();
				const mx = event.clientX - rect.left;
				const my = event.clientY - rect.top;
				if (typeof g.level === "number" && Math.abs(overY(g.level) - my) < 8) {
					trigDrag = { kind: "level", value: g.level };
				} else if (typeof g.offset === "number" && Math.abs(overX(g.offset) - mx) < 8) {
					trigDrag = { kind: "offset", value: g.offset };
				}
				if (trigDrag) {
					plot.cursor.drag.x = false;
					event.preventDefault();
					event.stopPropagation();
				}
			});
			grab.addEventListener("mousemove", (event) => {
				const rect = plot.over.getBoundingClientRect();
				const mx = event.clientX - rect.left;
				const my = event.clientY - rect.top;
				if (trigDrag) {
					trigDrag.value = trigDrag.kind === "level" ? fromOverY(my) : fromOverX(mx);
					plot.redraw();
					return;
				}
				// hover affordance: flag the lines as draggable near the cursor
				const g = triggerGeom();
				if (!g) {
					return;
				}
				let cursor = "";
				if (typeof g.level === "number" && Math.abs(overY(g.level) - my) < 8) {
					cursor = "ns-resize";
				} else if (typeof g.offset === "number" && Math.abs(overX(g.offset) - mx) < 8) {
					cursor = "ew-resize";
				}
				if (plot.over.style.cursor !== cursor) {
					plot.over.style.cursor = cursor;
				}
			});
			const trigRelease = () => {
				if (!trigDrag || !plot) {
					return;
				}
				const drag = trigDrag;
				trigDrag = null;
				plot.cursor.drag.x = true;
				plot.redraw();
				const args = drag.kind === "level" ? { trigger: { level: drag.value } } : { timebase: { offset: drag.value } };
				ctx.api("POST", "/devices/" + pane.config.device + "/command", { command: "set", args: args }).catch(() => null);
			};
			grab.addEventListener("mouseup", trigRelease);
			grab.addEventListener("mouseleave", trigRelease);
			// follow the scope's V/div window, and fetch the model for markers
			scopeModel().then((model) => {
				applyScopeRanges(model);
				if (plot) {
					plot.redraw();
				}
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
			if (zoomState.x) {
				plot.setScale("x", zoomState.x);
			}
			if (zoomState.y) {
				plot.setScale("y", zoomState.y);
			} else {
				// no manual zoom: keep following the scope's V/div window
				applyScopeRanges(scopeCache.model);
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
			ctx.on("value", (msg) => {
				// the scope's settings: refresh the cache, follow its V/div, repaint markers
				if (!pane.config.device || msg.name !== pane.config.device + "_settings") {
					return;
				}
				ctx.api("GET", "/values/" + encodeURIComponent(msg.name)).then((entry) => {
					scopeCache = { t: Date.now(), model: entry.value };
					applyScopeRanges(entry.value);
					if (plot) {
						plot.redraw();
					}
				}, () => null);
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
