// Markdown notes with KaTeX math ($inline$, $$display$$). Double-click to edit.
import katex from "katex";
import { marked } from "marked";

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
		let pane = initial;
		const view = document.createElement("div");
		view.className = "md";
		body.appendChild(view);

		const render = () => {
			view.innerHTML = renderMarkdown(pane.config.content || "*empty — double-click to edit*");
		};

		view.addEventListener("dblclick", () => {
			ctx.dialog("Edit note", [
				{ name: "content", type: "textarea", value: pane.config.content || "" }
			], (values) => {
				return ctx.api("PATCH", "/panes/" + pane.id, { config: { content: values.content } });
			});
		});
		render();

		return {
			update: (next) => {
				pane = next;
				render();
				body.scrollTop = body.scrollHeight;
			}
		};
	}
};
