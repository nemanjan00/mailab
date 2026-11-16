// Table of channels and traces with latest values; quick "chart it" actions.

import { escapeHtml, eng } from "./util.js";

export default {
	mount: (body, _initial, ctx) => {
		let last = 0;

		const render = () => {
			const chans = ctx.state.channels;
			const traces = ctx.state.traces;
			if (!chans.length && !traces.length) {
				body.innerHTML = "<div class=\"empty\">no data yet</div>";
				return;
			}
			const rows = chans.map((c) => {
				const buf = ctx.data.series(c.name);
				let v = buf.v[buf.v.length - 1];
				if (v === undefined && c.latest) {
					v = c.latest.v;
				}
				return "<tr data-channel=\"" + escapeHtml(c.name) + "\"><td class=\"mono\">" + escapeHtml(c.name) + "</td>"
					+ "<td class=\"num\">" + eng(v) + escapeHtml(c.unit || "") + "</td>"
					+ "<td class=\"muted\">" + escapeHtml(c.source || "") + "</td>"
					+ "<td><button class=\"icon\" data-act=\"chart\" title=\"chart\">📈</button>"
					+ "<button class=\"icon\" data-act=\"value\" title=\"readout\">#</button></td></tr>";
			}).concat(traces.map((t) => {
				return "<tr data-trace=\"" + escapeHtml(t.name) + "\"><td class=\"mono\">" + escapeHtml(t.name) + "</td>"
					+ "<td class=\"num\">" + t.points + " pts</td>"
					+ "<td class=\"muted\">trace · " + escapeHtml(t.mode) + "</td>"
					+ "<td><button class=\"icon\" data-act=\"trace\" title=\"plot\">📈</button>"
					+ "<button class=\"icon\" data-act=\"waterfall\" title=\"waterfall\">≋</button></td></tr>";
			}));
			body.innerHTML = "<table><thead><tr><th>name</th><th>latest</th><th>source</th><th></th></tr></thead><tbody>"
				+ rows.join("") + "</tbody></table>";
		};

		body.addEventListener("click", (event) => {
			const button = event.target.closest("button[data-act]");
			if (!button) {
				return;
			}
			const row = button.closest("tr");
			const act = button.dataset.act;
			const channel = row.dataset.channel;
			const trace = row.dataset.trace;
			const specs = {
				chart: { type: "chart", title: channel, config: { channels: [channel], seconds: 30 } },
				value: { type: "value", title: channel, w: 3, h: 3, config: { channel: channel } },
				trace: { type: "trace", title: trace, config: { traces: [trace] } },
				waterfall: { type: "waterfall", title: trace + " waterfall", config: { trace: trace } }
			};
			ctx.api("POST", "/panes", specs[act]);
		});

		const offs = [
			ctx.on("state", render),
			ctx.on("samples", () => {
				if (Date.now() - last > 250) {
					last = Date.now();
					render();
				}
			})
		];
		render();
		return {
			destroy: () => {
				offs.forEach((off) => off());
			}
		};
	}
};
