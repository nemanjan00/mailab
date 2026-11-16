// Canvas renderers for trace modes uPlot doesn't cover: scatter (glitch
// campaigns), constellation (I/Q, equal axes) and eye diagrams.

import { cssVar, eng } from "./util.js";

// glitch-result classes -> theme colours
const SCATTER_VARS = {
	success: "--err",
	expected: "--c0",
	"no-reply": "--c1",
	other: "--c2",
	error: "--c4"
};

const setup = (canvas) => {
	const dpr = window.devicePixelRatio || 1;
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	canvas.width = w * dpr;
	canvas.height = h * dpr;
	const g = canvas.getContext("2d");
	g.scale(dpr, dpr);
	g.clearRect(0, 0, w, h);
	g.font = "11px " + cssVar("--mono");
	return { g: g, w: w, h: h };
};

const extent = (values) => {
	const min = values.reduce((a, b) => Math.min(a, b), Infinity);
	const max = values.reduce((a, b) => Math.max(a, b), -Infinity);
	const span = max - min || 1;
	return [min - span * 0.03, max + span * 0.03];
};

/**
 * Axes + grid inside `box`; returns value->pixel mappers.
 */
const axes = (g, box, rx, ry, labels) => {
	const px = (x) => box.l + (x - rx[0]) / (rx[1] - rx[0]) * (box.r - box.l);
	const py = (y) => box.b - (y - ry[0]) / (ry[1] - ry[0]) * (box.b - box.t);
	g.strokeStyle = cssVar("--grid-line");
	g.fillStyle = cssVar("--muted");
	g.lineWidth = 1;
	[0, 0.25, 0.5, 0.75, 1].forEach((f) => {
		const x = rx[0] + f * (rx[1] - rx[0]);
		const y = ry[0] + f * (ry[1] - ry[0]);
		g.beginPath();
		g.moveTo(px(x), box.t);
		g.lineTo(px(x), box.b);
		g.moveTo(box.l, py(y));
		g.lineTo(box.r, py(y));
		g.stroke();
		g.fillText(eng(x, 1), px(x) - 14, box.b + 16);
		g.fillText(eng(y, 1), 4, py(y) + 4);
	});
	if (labels) {
		g.fillText(labels.x + " →", box.r - 70, box.b + 16);
		g.fillText("↑ " + labels.y, 4, box.t - 8);
	}
	return { px: px, py: py };
};

export const drawScatter = (canvas, tr, color) => {
	const c = setup(canvas);
	const all = tr.series.reduce((acc, s) => {
		return { x: acc.x.concat(s.x || []), y: acc.y.concat(s.y) };
	}, { x: [], y: [] });
	if (!all.x.length) {
		return;
	}
	const box = { l: 56, r: c.w - 12, t: 26, b: c.h - 28 };
	const m = axes(c.g, box, extent(all.x), extent(all.y), { x: tr.xUnit, y: tr.yUnit });
	let legendX = box.l + 50;
	tr.series.forEach((s, i) => {
		const col = SCATTER_VARS[s.label] ? cssVar(SCATTER_VARS[s.label]) : color(i);
		c.g.fillStyle = col;
		c.g.globalAlpha = 0.75;
		s.y.forEach((y, j) => {
			c.g.fillRect(m.px(s.x[j]) - 1.5, m.py(y) - 1.5, 3, 3);
		});
		c.g.globalAlpha = 1;
		const label = s.label + " (" + s.y.length + ")";
		c.g.fillRect(legendX, 9, 8, 8);
		c.g.fillStyle = cssVar("--text");
		c.g.fillText(label, legendX + 12, 17);
		legendX += c.g.measureText(label).width + 26;
	});
};

// I/Q points, equal axis scales, centred on the origin
export const drawConstellation = (canvas, tr, color) => {
	const c = setup(canvas);
	const s = tr.series[0];
	if (!s || !s.x || !s.x.length) {
		return;
	}
	const peak = s.x.concat(s.y).reduce((a, b) => Math.max(a, Math.abs(b)), 0) * 1.15 || 1;
	const size = Math.min(c.w - 60, c.h - 40);
	const box = { l: (c.w - size) / 2 + 20, t: 20, r: (c.w - size) / 2 + 20 + size, b: 20 + size };
	const m = axes(c.g, box, [-peak, peak], [-peak, peak], { x: "I", y: "Q" });
	c.g.strokeStyle = cssVar("--muted");
	c.g.beginPath();
	c.g.moveTo(m.px(0), box.t);
	c.g.lineTo(m.px(0), box.b);
	c.g.moveTo(box.l, m.py(0));
	c.g.lineTo(box.r, m.py(0));
	c.g.stroke();
	// low alpha so dense clusters read as brighter
	c.g.fillStyle = color(0);
	c.g.globalAlpha = Math.max(0.08, Math.min(0.8, 300 / s.x.length));
	s.x.forEach((x, i) => {
		c.g.fillRect(m.px(x) - 1.25, m.py(s.y[i]) - 1.25, 2.5, 2.5);
	});
	c.g.globalAlpha = 1;
	c.g.fillStyle = cssVar("--muted");
	c.g.fillText(s.x.length + " symbols", box.l, c.h - 6);
};

// overlaid 2-symbol segments
export const drawEye = (canvas, tr, color) => {
	const c = setup(canvas);
	if (!tr.series.length || !tr.x.length) {
		return;
	}
	const ys = tr.series.reduce((acc, s) => acc.concat(s.y), []);
	const box = { l: 56, r: c.w - 12, t: 16, b: c.h - 28 };
	const m = axes(c.g, box, [tr.x[0], tr.x[tr.x.length - 1]], extent(ys), { x: tr.xUnit, y: tr.yUnit });
	c.g.strokeStyle = color(0);
	c.g.lineWidth = 1.2;
	c.g.globalAlpha = Math.max(0.12, Math.min(0.7, 12 / tr.series.length));
	tr.series.forEach((s) => {
		c.g.beginPath();
		s.y.forEach((y, i) => {
			const x = m.px(tr.x[i]);
			if (i === 0) {
				c.g.moveTo(x, m.py(y));
			} else {
				c.g.lineTo(x, m.py(y));
			}
		});
		c.g.stroke();
	});
	c.g.globalAlpha = 1;
};

/**
 * findus-style parameter map of a scatter dataset: delay × length grid,
 * cell colour = share of `success` attempts, opacity = attempts in the cell.
 * @param {{bins: number, success: string}} [opts]
 */
export const drawMap = (canvas, tr, color, opts) => {
	const o = opts || {};
	const c = setup(canvas);
	const points = tr.series.reduce((acc, s) => {
		return acc.concat(s.y.map((y, i) => ({ x: s.x[i], y: y, cls: s.label })));
	}, []);
	if (!points.length) {
		return;
	}
	const target = o.success || "success";
	const bins = Number(o.bins) || 40;
	const rx = extent(points.map((p) => p.x));
	const ry = extent(points.map((p) => p.y));
	const box = { l: 56, r: c.w - 100, t: 20, b: c.h - 28 };
	const m = axes(c.g, box, rx, ry, { x: tr.xUnit, y: tr.yUnit });
	const rows = Math.max(4, Math.round(bins * (box.b - box.t) / (box.r - box.l)));
	const cells = {};
	points.forEach((p) => {
		const cx = Math.min(bins - 1, Math.floor((p.x - rx[0]) / (rx[1] - rx[0]) * bins));
		const cy = Math.min(rows - 1, Math.floor((p.y - ry[0]) / (ry[1] - ry[0]) * rows));
		const key = cx + ":" + cy;
		const cell = cells[key] || (cells[key] = { n: 0, hit: 0, cx: cx, cy: cy });
		cell.n++;
		if (p.cls === target) {
			cell.hit++;
		}
	});
	const maxN = Object.values(cells).reduce((a, cell) => Math.max(a, cell.n), 1);
	const cw = (box.r - box.l) / bins;
	const ch = (box.b - box.t) / rows;
	const hot = cssVar("--err");
	const cold = cssVar("--c1");
	Object.values(cells).forEach((cell) => {
		const rate = cell.hit / cell.n;
		c.g.globalAlpha = 0.25 + 0.75 * Math.sqrt(cell.n / maxN);
		c.g.fillStyle = rate > 0 ? hot : cold;
		if (rate > 0) {
			// brighter = higher success rate
			c.g.globalAlpha = Math.min(1, 0.35 + rate);
		}
		c.g.fillRect(box.l + cell.cx * cw, box.b - (cell.cy + 1) * ch, cw - 1, ch - 1);
	});
	c.g.globalAlpha = 1;
	// legend
	c.g.fillStyle = cssVar("--text");
	const best = Object.values(cells).filter((cell) => cell.hit).sort((a, b) => b.hit / b.n - a.hit / a.n)[0];
	c.g.fillText(points.length + " attempts", box.r + 8, box.t + 10);
	c.g.fillStyle = hot;
	c.g.fillText(target, box.r + 8, box.t + 28);
	c.g.fillStyle = cold;
	c.g.fillText("none", box.r + 8, box.t + 44);
	if (best) {
		c.g.fillStyle = cssVar("--muted");
		c.g.fillText("best " + Math.round(best.hit / best.n * 100) + "%", box.r + 8, box.t + 62);
		c.g.fillText("x≈" + eng(rx[0] + (best.cx + 0.5) * (rx[1] - rx[0]) / bins, 0), box.r + 8, box.t + 76);
		c.g.fillText("y≈" + eng(ry[0] + (best.cy + 0.5) * (ry[1] - ry[0]) / rows, 0), box.r + 8, box.t + 90);
	}
	return m;
};

/**
 * matplotlib-style x/y lines; every series has its own x (functions,
 * parametric curves, data), nulls break the line.
 */
export const drawPlot = (canvas, tr, color) => {
	const c = setup(canvas);
	const xs = [];
	const ys = [];
	tr.series.forEach((s) => {
		(s.x || tr.x).forEach((x, i) => {
			if (x !== null && s.y[i] !== null && Number.isFinite(x) && Number.isFinite(s.y[i])) {
				xs.push(x);
				ys.push(s.y[i]);
			}
		});
	});
	if (!xs.length) {
		return;
	}
	const box = { l: 56, r: c.w - 12, t: 24, b: c.h - 28 };
	const m = axes(c.g, box, extent(xs), extent(ys), { x: tr.xUnit || "x", y: tr.yUnit || "y" });
	// zero axes, like a graphing calculator
	c.g.strokeStyle = cssVar("--muted");
	c.g.beginPath();
	const x0 = m.px(0);
	const y0 = m.py(0);
	if (x0 >= box.l && x0 <= box.r) {
		c.g.moveTo(x0, box.t);
		c.g.lineTo(x0, box.b);
	}
	if (y0 >= box.t && y0 <= box.b) {
		c.g.moveTo(box.l, y0);
		c.g.lineTo(box.r, y0);
	}
	c.g.stroke();
	c.g.save();
	c.g.beginPath();
	c.g.rect(box.l, box.t, box.r - box.l, box.b - box.t);
	c.g.clip();
	tr.series.forEach((s, k) => {
		c.g.strokeStyle = color(k);
		c.g.lineWidth = 1.6;
		c.g.beginPath();
		let pen = false;
		(s.x || tr.x).forEach((x, i) => {
			const y = s.y[i];
			if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
				pen = false;
				return;
			}
			if (pen) {
				c.g.lineTo(m.px(x), m.py(y));
			} else {
				c.g.moveTo(m.px(x), m.py(y));
				pen = true;
			}
		});
		c.g.stroke();
	});
	c.g.restore();
	let lx = box.l + 60;
	tr.series.forEach((s, k) => {
		c.g.fillStyle = color(k);
		c.g.fillRect(lx, 8, 10, 3);
		c.g.fillStyle = cssVar("--text");
		c.g.fillText(s.label, lx + 14, 13);
		lx += c.g.measureText(s.label).width + 30;
	});
};

export const CANVAS_MODES = {
	plot: drawPlot,
	scatter: drawScatter,
	constellation: drawConstellation,
	eye: drawEye
};
