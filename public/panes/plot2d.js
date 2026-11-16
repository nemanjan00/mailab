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

export const CANVAS_MODES = {
	scatter: drawScatter,
	constellation: drawConstellation,
	eye: drawEye
};
