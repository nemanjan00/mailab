// Spectrum-analyzer style markers for trace panes, plus their readings table.
//
// pane.config.markers: [{mode: "peak" | "x", x, trace, series, ref}]
//   peak   highest point of the trace (series 0 unless `series`)
//   x      the point nearest `x` (e.g. a frequency)
//   ref    index of another marker: the table shows Δx / Δy to it
// pane.config.peaks: N   adds the N highest local maxima as extra markers

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

export const readingsTable = (readings) => {
	if (!readings.length) {
		return "";
	}
	const rows = readings.map((r) => {
		const tr = r.trace;
		let delta = "<td></td><td></td>";
		if (r.dx !== undefined) {
			delta = "<td class=\"num\">Δ" + escapeHtml(r.refLabel) + " " + eng(r.dx, 4) + tr.xUnit + "</td><td class=\"num\">" + (r.dy >= 0 ? "+" : "") + r.dy.toFixed(2) + " " + escapeHtml(tr.yUnit) + "</td>";
		}
		let remove = "";
		if (r.removable !== undefined) {
			remove = "<button class=\"icon\" data-remove=\"" + r.removable + "\" title=\"remove\">×</button>";
		}
		return "<tr><td class=\"mono\">" + escapeHtml(r.label) + "</td><td class=\"muted\">" + escapeHtml(r.mode) + "</td>"
			+ "<td class=\"num\">" + eng(r.x, 4) + escapeHtml(tr.xUnit) + "</td><td class=\"num\">" + r.y.toFixed(2) + " " + escapeHtml(tr.yUnit) + "</td>"
			+ delta + "<td>" + remove + "</td></tr>";
	}).join("");
	return "<table class=\"readings\"><thead><tr><th>mk</th><th>mode</th><th>x</th><th>level</th><th>Δx</th><th>Δlevel</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>";
};
