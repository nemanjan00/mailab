// Live math: a mathjs expression over channels, rendered as LaTeX with its
// result, re-evaluated on the server every refreshMs.
import katex from "katex";

import { escapeHtml } from "./util.js";

const formatValue = (value, text) => {
	if (Array.isArray(value)) {
		return "[" + value.length + " values] " + text.slice(0, 200);
	}
	return text;
};

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		let timer = null;
		body.innerHTML = "<div class=\"mathpane\"><div class=\"tex\"></div><div class=\"result\"></div></div>";
		const texEl = body.querySelector(".tex");
		const resultEl = body.querySelector(".result");

		const tick = () => {
			clearTimeout(timer);
			if (!pane.config.expression) {
				texEl.innerHTML = "<span class=\"muted\">set config.expression, e.g. rms(sim_sine)</span>";
				resultEl.textContent = "";
				return;
			}
			ctx.api("POST", "/eval", { expression: pane.config.expression, samples: pane.config.samples })
				.then((res) => {
					texEl.innerHTML = katex.renderToString(res.tex || pane.config.expression, { displayMode: true, throwOnError: false });
					resultEl.textContent = "= " + formatValue(res.value, res.text);
				}, (err) => {
					texEl.textContent = pane.config.expression;
					resultEl.innerHTML = "<span class=\"err\">" + escapeHtml(err.message) + "</span>";
				})
				.then(() => {
					timer = setTimeout(tick, Number(pane.config.refreshMs) || 1000);
				});
		};
		tick();

		return {
			update: (next) => {
				pane = next;
				tick();
			},
			destroy: () => {
				clearTimeout(timer);
				pane = { config: {} };
			}
		};
	}
};
