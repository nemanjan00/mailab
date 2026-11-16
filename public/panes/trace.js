// x/y plot of captured traces: spectra, VNA sweeps, scope & logic captures
// (uPlot), and scatter datasets such as glitch campaigns (canvas).

import { axisStyle, cssVar, eng, frameThrottle, plotSize } from "./util.js";

// glitch-result classes -> theme colours
const SCATTER_VARS = {
	success: "--err",
	expected: "--c0",
	"no-reply": "--c1",
	other: "--c2",
	error: "--c4"
};

const drawScatter = (canvas, tr, ctx) => {
	const dpr = window.devicePixelRatio || 1;
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	canvas.width = w * dpr;
	canvas.height = h * dpr;
	const g = canvas.getContext("2d");
	g.scale(dpr, dpr);
	g.clearRect(0, 0, w, h);
	const pad = { l: 56, r: 12, t: 26, b: 28 };
	const all = tr.series.reduce((acc, s) => {
		return { x: acc.x.concat(s.x || []), y: acc.y.concat(s.y) };
	}, { x: [], y: [] });
	if (!all.x.length) {
		return;
	}
	const range = (v) => {
		const min = v.reduce((a, b) => Math.min(a, b), Infinity);
		const max = v.reduce((a, b) => Math.max(a, b), -Infinity);
		const span = max - min || 1;
		return [min - span * 0.03, max + span * 0.03];
	};
	const rx = range(all.x);
	const ry = range(all.y);
	const px = (x) => pad.l + (x - rx[0]) / (rx[1] - rx[0]) * (w - pad.l - pad.r);
	const py = (y) => h - pad.b - (y - ry[0]) / (ry[1] - ry[0]) * (h - pad.t - pad.b);

	g.strokeStyle = cssVar("--grid-line");
	g.fillStyle = cssVar("--muted");
	g.font = "11px " + cssVar("--mono");
	[0, 0.25, 0.5, 0.75, 1].forEach((f) => {
		const x = rx[0] + f * (rx[1] - rx[0]);
		const y = ry[0] + f * (ry[1] - ry[0]);
		g.beginPath();
		g.moveTo(px(x), pad.t);
		g.lineTo(px(x), h - pad.b);
		g.moveTo(pad.l, py(y));
		g.lineTo(w - pad.r, py(y));
		g.stroke();
		g.fillText(eng(x, 1), px(x) - 14, h - 10);
		g.fillText(eng(y, 1), 4, py(y) + 4);
	});
	g.fillText(tr.xUnit + " →", w - pad.r - 70, h - 10);
	g.fillText("↑ " + tr.yUnit, 4, 14);

	let legendX = pad.l + 50;
	tr.series.forEach((s, i) => {
		const color = SCATTER_VARS[s.label] ? cssVar(SCATTER_VARS[s.label]) : ctx.color(i);
		g.fillStyle = color;
		g.globalAlpha = 0.75;
		s.y.forEach((y, j) => {
			g.fillRect(px(s.x[j]) - 1.5, py(y) - 1.5, 3, 3);
		});
		g.globalAlpha = 1;
		const label = s.label + " (" + s.y.length + ")";
		g.fillRect(legendX, 9, 8, 8);
		g.fillStyle = cssVar("--text");
		g.fillText(label, legendX + 12, 17);
		legendX += g.measureText(label).width + 26;
	});
};

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		let plot = null;
		let canvas = null;
		let signature = "";
		body.classList.add("fill");

		const names = () => [].concat(pane.config.traces || pane.config.trace || []);

		const loaded = () => names().map((n) => ctx.traces[n]).filter(Boolean);

		const teardown = () => {
			if (plot) {
				plot.destroy();
				plot = null;
			}
			canvas = null;
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
			plot = new uPlot(Object.assign({
				scales: { x: { time: false, distr: pane.config.logX ? 3 : 1 }, y: scaleY, y2: { auto: true } },
				axes: axes,
				series: series,
				cursor: { drag: { x: true, y: false } }
			}, plotSize(body, true)), tables.length === 1 ? tables[0] : uPlot.join(tables), body);
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
			const scatter = trs[0].mode === "scatter";
			// rebuild uPlot only when the series layout changes
			const sig = JSON.stringify(trs.map((tr) => [tr.name, tr.mode, tr.series.map((s) => s.label)])) + document.documentElement.dataset.theme;
			if (scatter) {
				if (!canvas) {
					teardown();
					canvas = document.createElement("canvas");
					canvas.className = "full";
					body.appendChild(canvas);
				}
				drawScatter(canvas, trs[0], ctx);
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
					plot.setSize(plotSize(body, true));
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
