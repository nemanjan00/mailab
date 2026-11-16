// Graphing calculator: mathjs expressions plotted live (functions of x,
// parametric "x(t); y(t)", or data like db(mag(fft(scope_ch1)))).
// Edits are saved to the pane config, so the AI sees them too.

import { el, list, state } from "@nemanjan00/qrp";
import { iconButton, pane, toolbar, widget } from "../sdk/index.js";
import { drawPlot } from "./plot2d.js";

const REPLOT_DELAY_MS = 300;

// "cos(t); sin(2*t)" is parametric
const toSpec = (text) => {
	const parts = text.split(";");
	if (parts.length === 2) {
		return { x: parts[0].trim(), y: parts[1].trim() };
	}
	return text.trim();
};

export default pane((ctx, p) => {
	const cfg = p.pane.config;
	const form = state({
		exprs: (cfg.exprs || ["sin(x)", "cos(x) * exp(-x / 5)"]).map((e, i) => ({ id: i, text: typeof e === "string" ? e : e.x + "; " + e.y })),
		xmin: cfg.xmin === undefined ? -10 : cfg.xmin,
		xmax: cfg.xmax === undefined ? 10 : cfg.xmax,
		error: ""
	});
	let nextId = form.exprs.length;
	let canvas = null;
	let last = null;
	let timer = null;

	const draw = () => {
		if (canvas && last) {
			drawPlot(canvas, last, ctx.color);
		}
	};

	const replot = () => {
		const exprs = form.exprs.map((e) => e.text).filter((t) => t.trim()).map(toSpec);
		if (!exprs.length) {
			return;
		}
		ctx.api("POST", "/plot", {
			exprs: exprs, xmin: Number(form.xmin), xmax: Number(form.xmax), points: 600,
			ymin: cfg.ymin, ymax: cfg.ymax, equal: cfg.equal
		}).then((res) => {
			last = res;
			form.error = "";
			draw();
		}, (err) => {
			form.error = err.message;
		});
	};

	// save + replot shortly after typing stops
	const changed = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			ctx.api("PATCH", "/panes/" + p.pane.id, { config: {
				exprs: form.exprs.map((e) => toSpec(e.text)), xmin: Number(form.xmin), xmax: Number(form.xmax)
			} });
			replot();
		}, REPLOT_DELAY_MS);
	};

	const exprRow = (e) => el("div", { class: "graph-expr" },
		el("span", { class: "graph-dot", style: () => ({ background: ctx.color(form.exprs.indexOf(e)) }) }),
		el("input", { value: e.text, oninput: (ev) => { e.text = ev.target.value; changed(); }, placeholder: "f(x)  or  x(t); y(t)" }),
		iconButton("×", "remove", () => {
			form.exprs.splice(form.exprs.indexOf(e), 1);
			changed();
		}));

	// data expressions change as the lab runs
	const refresh = setInterval(replot, Number(cfg.refreshMs) || 2000);
	replot();

	return el("div", { class: "graph" },
		el("div", { class: "graph-side" },
			list(() => form.exprs, (e) => e.id, exprRow),
			toolbar(
				el("button", { onclick: () => { form.exprs.push({ id: nextId++, text: "" }); } }, "+ f"),
				el("label", {}, "x ", el("input", { class: "graph-range", value: form.xmin, oninput: (ev) => { form.xmin = ev.target.value; changed(); } })),
				el("label", {}, "… ", el("input", { class: "graph-range", value: form.xmax, oninput: (ev) => { form.xmax = ev.target.value; changed(); } }))),
			el("div", { class: "error" }, () => form.error)),
		widget((host) => {
			canvas = el("canvas", { class: "full" });
			host.style.position = "relative";
			host.append(canvas);
			draw();
			return {
				resize: draw,
				destroy: () => clearInterval(refresh)
			};
		}));
});
