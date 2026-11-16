// Live time-series chart of one or more channels (uPlot).
import uPlot from "uplot";

import { axisStyle, frameThrottle, plotSize, eng } from "./util.js";

const pickChannels = (pane, ctx) => {
	const wanted = pane.config.channels || [];
	if (wanted.length) {
		return wanted;
	}
	// empty config = every channel
	return ctx.state.channels.map((c) => c.name);
};

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		let names = [];
		let plot = null;
		body.classList.add("fill");

		const unitOf = (name) => {
			const ch = ctx.state.channels.find((c) => c.name === name);
			return (ch && ch.unit) || "";
		};

		const build = () => {
			if (plot) {
				plot.destroy();
				plot = null;
			}
			body.innerHTML = "";
			names = pickChannels(pane, ctx);
			if (!names.length) {
				body.innerHTML = "<div class=\"empty\">no channels yet — add a device, or set config.channels</div>";
				return;
			}
			names.forEach(ctx.data.backfill);
			const axis = axisStyle();
			const scaleY = { auto: true };
			if (pane.config.yMin !== undefined && pane.config.yMax !== undefined && pane.config.yMin !== "") {
				scaleY.auto = false;
				scaleY.range = [Number(pane.config.yMin), Number(pane.config.yMax)];
			}
			plot = new uPlot(Object.assign({
				scales: { x: { time: true }, y: scaleY },
				axes: [axis, Object.assign({}, axis, { size: 72, values: (_u, ticks) => ticks.map((v) => eng(v, 1)) })],
				series: [{}].concat(names.map((name, i) => {
					const unit = unitOf(name);
					return {
						label: name + (unit ? " [" + unit + "]" : ""),
						stroke: ctx.color(i),
						width: 1.5,
						points: { show: false },
						value: (_u, v) => (v === null || v === undefined ? "—" : eng(v) + unit)
					};
				})),
				cursor: { drag: { x: true, y: false } },
				legend: { live: true }
			}, plotSize(body, true)), [[]].concat(names.map(() => [])), body);
			redraw();
		};

		const redraw = frameThrottle(() => {
			if (!plot) {
				return;
			}
			const seconds = Number(pane.config.seconds) || 30;
			const from = Date.now() / 1000 - seconds;
			const tables = names.map((name) => {
				const buf = ctx.data.series(name);
				let i = buf.t.length;
				while (i > 0 && buf.t[i - 1] >= from) {
					i--;
				}
				return [buf.t.slice(i), buf.v.slice(i)];
			});
			let aligned;
			if (tables.length === 1) {
				aligned = tables[0];
			} else {
				aligned = uPlot.join(tables);
			}
			plot.setData(aligned, false);
			plot.setScale("x", { min: from, max: Date.now() / 1000 });
		});

		const offs = [
			ctx.on("samples", redraw),
			ctx.on("theme", build),
			ctx.on("state", () => {
				// rebuild when "all channels" grows or units change
				const next = pickChannels(pane, ctx);
				if (next.join() !== names.join()) {
					build();
				}
			})
		];
		build();

		return {
			update: (next) => {
				pane = next;
				build();
			},
			resize: () => {
				if (plot) {
					plot.setSize(plotSize(body, true));
				}
			},
			destroy: () => {
				offs.forEach((off) => off());
				if (plot) {
					plot.destroy();
				}
			}
		};
	}
};
