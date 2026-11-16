// Waterfall (spectrogram): each update of a trace becomes one row, newest on top.

import { cssVar, eng } from "./util.js";

// compact "turbo"-like colormap stops
const STOPS = [
	[0, [48, 18, 59]], [0.15, [70, 107, 227]], [0.3, [40, 187, 236]], [0.45, [49, 241, 152]],
	[0.6, [164, 252, 60]], [0.75, [251, 185, 56]], [0.9, [226, 69, 21]], [1, [122, 4, 3]]
];

const colormap = (f) => {
	const x = Math.max(0, Math.min(1, f));
	const i = STOPS.findIndex((s) => s[0] >= x);
	if (i <= 0) {
		return STOPS[0][1];
	}
	const a = STOPS[i - 1];
	const b = STOPS[i];
	const k = (x - a[0]) / (b[0] - a[0]);
	return [0, 1, 2].map((c) => Math.round(a[1][c] + (b[1][c] - a[1][c]) * k));
};

const LUT = Array.from({ length: 256 }, (_, i) => colormap(i / 255));
const AXIS_HEIGHT = 18;

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		body.classList.add("fill");
		const canvas = document.createElement("canvas");
		canvas.className = "full";
		body.appendChild(canvas);
		let rows = [];
		let lastX = null;

		const draw = () => {
			const w = Math.max(10, body.clientWidth);
			const h = Math.max(10, body.clientHeight);
			canvas.width = w;
			canvas.height = h;
			const g = canvas.getContext("2d");
			g.fillStyle = cssVar("--panel");
			g.fillRect(0, 0, w, h);
			if (!rows.length) {
				g.fillStyle = cssVar("--muted");
				g.fillText(pane.config.trace ? "waiting for " + pane.config.trace + "…" : "set config.trace", 12, 20);
				return;
			}
			const all = rows[0];
			let min = Number(pane.config.min);
			let max = Number(pane.config.max);
			if (!Number.isFinite(min) || !Number.isFinite(max) || pane.config.min === undefined) {
				min = all.reduce((a, b) => Math.min(a, b), Infinity);
				max = all.reduce((a, b) => Math.max(a, b), -Infinity);
			}
			const span = max - min || 1;
			const plotH = h - AXIS_HEIGHT;
			const rowH = Math.max(1, plotH / (Number(pane.config.rows) || 200));
			const img = g.createImageData(w, 1);
			rows.forEach((row, r) => {
				const y = Math.floor(r * rowH);
				if (y >= plotH) {
					return;
				}
				for (let px = 0; px < w; px++) {
					const v = row[Math.floor(px / w * row.length)];
					const c = LUT[Math.max(0, Math.min(255, Math.round((v - min) / span * 255)))];
					img.data[px * 4] = c[0];
					img.data[px * 4 + 1] = c[1];
					img.data[px * 4 + 2] = c[2];
					img.data[px * 4 + 3] = 255;
				}
				for (let k = 0; k < Math.ceil(rowH); k++) {
					g.putImageData(img, 0, y + k);
				}
			});
			if (lastX && lastX.length) {
				g.fillStyle = cssVar("--muted");
				g.font = "11px " + cssVar("--mono");
				[0, 0.25, 0.5, 0.75, 1].forEach((f) => {
					const x = lastX[Math.min(lastX.length - 1, Math.floor(f * (lastX.length - 1)))];
					const label = eng(x, 2) + "Hz";
					const px = Math.min(w - g.measureText(label).width - 2, Math.max(2, f * w - 20));
					g.fillText(label, px, h - 5);
				});
			}
		};

		const off = ctx.on("trace", (tr) => {
			if (tr.name !== pane.config.trace || !tr.series.length) {
				return;
			}
			lastX = tr.x;
			rows.unshift(tr.series[0].y.slice());
			rows = rows.slice(0, Number(pane.config.rows) || 200);
			draw();
		});
		draw();

		return {
			update: (next) => {
				if (next.config.trace !== pane.config.trace) {
					rows = [];
				}
				pane = next;
				draw();
			},
			resize: draw,
			destroy: off
		};
	}
};
