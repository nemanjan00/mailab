// Big numeric readout of the latest value of one channel.

import { escapeHtml } from "./util.js";

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		body.classList.add("value-wrap");

		const render = () => {
			const name = pane.config.channel;
			if (!name) {
				body.innerHTML = "<div class=\"empty\">set config.channel</div>";
				return;
			}
			const buf = ctx.data.series(name);
			const ch = ctx.state.channels.find((c) => c.name === name) || {};
			let v = buf.v[buf.v.length - 1];
			if (v === undefined && ch.latest) {
				v = ch.latest.v;
			}
			const precision = pane.config.precision === undefined ? 4 : Number(pane.config.precision);
			const text = v === undefined ? "—" : Number(v).toFixed(precision);
			body.innerHTML = "<div class=\"value\"><div class=\"num\">" + escapeHtml(text) + "</div>"
				+ "<div class=\"unit\">" + escapeHtml(ch.unit || "") + "</div>"
				+ "<div class=\"muted\">" + escapeHtml(pane.config.label || name) + "</div></div>";
		};

		let last = 0;
		const offs = [
			ctx.on("samples", (samples) => {
				// ~10 updates/s is plenty for a readout
				if (samples[pane.config.channel] && Date.now() - last > 100) {
					last = Date.now();
					render();
				}
			}),
			ctx.on("state", render)
		];
		render();

		return {
			update: (next) => {
				pane = next;
				render();
			},
			destroy: () => {
				offs.forEach((off) => off());
			}
		};
	}
};
