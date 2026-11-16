// Markdown notes with KaTeX math ($inline$, $$display$$). Double-click to edit.
// {{channel}} / {{channel|digits}} placeholders follow live channel values.
import { effect, scope, state } from "@nemanjan00/qrp";
import { throttle } from "@nemanjan00/qrp/utils";
import katex from "katex";
import { marked } from "marked";
import placeholders from "../../src/utils/placeholders/index.js";
import { formatPlaceholder } from "./util.js";

// live values re-render the note at most this often (5 Hz)
const LIVE_INTERVAL_MS = 200;
const EMPTY = "*empty — double-click to edit*";

const renderMath = (tex, display) => {
	try {
		return katex.renderToString(tex, { displayMode: display, throwOnError: false });
	} catch (_err) {
		return tex;
	}
};

// math first (into placeholders) so markdown doesn't mangle it
export const renderMarkdown = (source) => {
	const stash = [];
	const keep = (html) => {
		stash.push(html);
		return "@@MATH" + (stash.length - 1) + "@@";
	};
	const withMath = String(source || "")
		.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => keep(renderMath(tex, true)))
		.replace(/\$([^$\n]+?)\$/g, (_m, tex) => keep(renderMath(tex, false)));
	const html = marked.parse(withMath);
	return html.replace(/@@MATH(\d+)@@/g, (_m, i) => stash[Number(i)]);
};

export default {
	mount: (body, initial, ctx) => {
		const p = state({ pane: initial });
		const view = document.createElement("div");
		view.className = "md";
		body.appendChild(view);

		view.addEventListener("dblclick", () => {
			ctx.dialog("Edit note", [
				{ name: "content", type: "textarea", value: p.pane.config.content || "" }
			], (values) => {
				return ctx.api("PATCH", "/panes/" + p.pane.id, { config: { content: values.content } });
			});
		});

		let shown = null;
		const live = scope(() => {
			const draw = throttle((source) => {
				view.innerHTML = renderMarkdown(source);
			}, LIVE_INTERVAL_MS);
			// reads the note and every live value it references; only a changed
			// text (not every sample) reaches the throttled render
			effect(() => {
				const source = placeholders.fill(p.pane.config.content || EMPTY, (name, precision) => formatPlaceholder(ctx, name, precision));
				if (source !== shown) {
					shown = source;
					draw(source);
				}
			}, { name: "markdown " + initial.id });
		});

		return {
			update: (next) => {
				p.pane = next;
				body.scrollTop = body.scrollHeight;
			},
			destroy: () => {
				live.dispose();
			}
		};
	}
};
