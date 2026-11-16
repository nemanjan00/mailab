// Spectrum-analyzer style markers for trace panes, plus their readings table.
//
// pane.config.markers: [{mode: "peak" | "x", x, trace, series, ref}]
//   peak   highest point of the trace (series 0 unless `series`)
//   x      the point nearest `x` (e.g. a frequency)
//   ref    index of another marker: the table shows Δx / Δy to it
// pane.config.peaks: N   adds the N highest local maxima as extra markers

import { when } from "@nemanjan00/qrp";
import { iconButton, table } from "../sdk/index.js";
import { cssVar, escapeHtml, eng } from "./util.js";

const MIN_PEAK_SEPARATION = 0.01;

// index of the sample nearest x (x ascending)
const nearest = (xs, x) => {
	let lo = 0;
	let hi = xs.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (xs[mid] < x) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
};

const argmax = (ys) => {
	return ys.reduce((best, y, i) => (y > ys[best] ? i : best), 0);
};

// N highest local maxima, at least MIN_PEAK_SEPARATION of the span apart
const topPeaks = (ys, n) => {
	const separation = Math.max(1, Math.floor(ys.length * MIN_PEAK_SEPARATION));
	const candidates = ys.map((y, i) => ({ i: i, y: y })).filter((p) => {
		return (p.i === 0 || ys[p.i - 1] <= p.y) && (p.i === ys.length - 1 || ys[p.i + 1] < p.y);
	}).sort((a, b) => b.y - a.y);
	return candidates.reduce((picked, p) => {
		if (picked.length < n && picked.every((q) => Math.abs(q.i - p.i) >= separation)) {
			picked.push(p);
		}
		return picked;
	}, []).map((p) => p.i);
};

/**
 * @param {Object[]} trs traces shown in the pane
 * @param {Object} config pane config
 * @returns {Object[]} readings: {label, mode, x, y, dx, dy, trace, removable}
 */
export const computeReadings = (trs, config) => {
	const byName = {};
	trs.forEach((tr) => {
		byName[tr.name] = tr;
	});
	const pick = (m) => {
		const tr = byName[m.trace] || trs[0];
		const s = tr.series[m.series || 0];
		if (!s || !tr.x.length) {
			return null;
		}
		let i;
		if (m.mode === "x") {
			i = nearest(tr.x, Number(m.x));
		} else {
			i = argmax(s.y);
		}
		return { x: tr.x[i], y: s.y[i], trace: tr };
	};
	const explicit = (config.markers || []).map((m, k) => {
		const p = pick(m);
		if (!p) {
			return null;
		}
		return { label: "M" + (k + 1), mode: m.mode || "peak", x: p.x, y: p.y, ref: m.ref, trace: p.trace, removable: k };
	});
	let auto = [];
	if (Number(config.peaks) > 0 && trs[0] && trs[0].series[0]) {
		const tr = trs[0];
		auto = topPeaks(tr.series[0].y, Number(config.peaks)).map((i, k) => {
			return { label: "P" + (k + 1), mode: "peak", x: tr.x[i], y: tr.series[0].y[i], trace: tr };
		});
	}
	const all = explicit.concat(auto);
	return all.filter(Boolean).map((r) => {
		const ref = r.ref !== undefined && all[r.ref];
		if (ref) {
			return Object.assign({}, r, { dx: r.x - ref.x, dy: r.y - ref.y, refLabel: ref.label });
		}
		return r;
	});
};

/**
 * uPlot draw hook: dashed line + diamond + label per reading.
 */
export const drawMarkers = (u, readings) => {
	const g = u.ctx;
	const dpr = window.devicePixelRatio || 1;
	g.save();
	g.font = (11 * dpr) + "px " + cssVar("--mono");
	readings.forEach((r) => {
		const x = u.valToPos(r.x, "x", true);
		const y = u.valToPos(r.y, "y", true);
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			return;
		}
		const color = r.label[0] === "P" ? cssVar("--c2") : cssVar("--c3");
		g.strokeStyle = color;
		g.fillStyle = color;
		g.setLineDash([3 * dpr, 3 * dpr]);
		g.beginPath();
		g.moveTo(x, u.bbox.top);
		g.lineTo(x, u.bbox.top + u.bbox.height);
		g.stroke();
		g.setLineDash([]);
		const d = 5 * dpr;
		g.beginPath();
		g.moveTo(x, y - d);
		g.lineTo(x + d, y);
		g.lineTo(x, y + d);
		g.lineTo(x - d, y);
		g.closePath();
		g.fill();
		// auto peaks label below, manual markers above, so coinciding ones stay readable
		const labelY = r.label[0] === "P" ? y + 16 * dpr : y - 7 * dpr;
		g.fillText(r.label, x + 7 * dpr, labelY);
	});
	g.restore();
};

/**
 * Plain, export-friendly rows for readingsTable (numbers in base units).
 */
export const readingRows = (readings) => readings.map((r) => {
	const tr = r.trace;
	const row = {
		label: r.label,
		mode: r.mode,
		x: r.x,
		xText: eng(r.x, 4) + tr.xUnit,
		level: r.y,
		levelText: r.y.toFixed(2) + " " + tr.yUnit,
		dx: null,
		dxText: "",
		dy: null,
		dyText: "",
		removable: r.removable === undefined ? null : r.removable
	};
	if (r.dx !== undefined) {
		row.dx = r.dx;
		row.dxText = "Δ" + r.refLabel + " " + eng(r.dx, 4) + tr.xUnit;
		row.dy = r.dy;
		row.dyText = (r.dy >= 0 ? "+" : "") + r.dy.toFixed(2) + " " + tr.yUnit;
	}
	return row;
});

/**
 * Readings table (sortable, filterable, exportable) over reactive rows from readingRows.
 * @param {function(): Array} rows
 * @param {function(number)} onRemove removes the manual marker at that index
 * @param {Object} [ui] tableState(), kept by the caller so sort / filter survive a rebuild
 */
export const readingsTable = (rows, onRemove, ui) => when(() => rows().length > 0, () => table({
	rows: rows,
	ui: ui,
	key: (r) => r.label,
	name: "readings",
	className: "readings",
	columns: [
		{ title: "mk", mono: true, value: (r) => r.label },
		{ title: "mode", muted: true, value: (r) => r.mode },
		{ title: "x", num: true, raw: (r) => r.x, text: (r) => r.xText, value: (r) => r.xText },
		{ title: "level", num: true, raw: (r) => r.level, text: (r) => r.levelText, value: (r) => r.levelText },
		{ title: "Δx", num: true, raw: (r) => r.dx, text: (r) => r.dxText, value: (r) => r.dxText },
		{ title: "Δlevel", num: true, raw: (r) => r.dy, text: (r) => r.dyText, value: (r) => r.dyText },
		{ value: (r) => (r.removable === null ? "" : iconButton("×", "remove", () => onRemove(r.removable))) }
	]
}));

/**
 * Scope-style measurement table from trace.measurements: [{name, value, unit}]
 */
export const measurementsTable = (measurements) => {
	if (!measurements || !measurements.length) {
		return "";
	}
	const cells = measurements.map((m) => {
		let text = "—";
		if (m.value !== null && m.value !== undefined) {
			if (m.name === "duty") {
				text = (m.value * 100).toFixed(1) + " %";
			} else {
				text = eng(m.value, 4) + escapeHtml(m.unit);
			}
		}
		return "<span><span class=\"muted\">" + escapeHtml(m.name) + "</span> " + text + "</span>";
	}).join("");
	return "<div class=\"measurements\">" + cells + "</div>";
};
