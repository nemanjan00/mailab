// Collapsible JSON tree, shared by the json and kaitai panes.

import { escapeHtml } from "./util.js";

const MAX_CHILDREN = 500;

const leaf = (value) => {
	if (value === null) {
		return "<span class=\"j-null\">null</span>";
	}
	if (typeof value === "string") {
		return "<span class=\"j-str\">\"" + escapeHtml(value.length > 300 ? value.slice(0, 300) + "…" : value) + "\"</span>";
	}
	if (typeof value === "number") {
		return "<span class=\"j-num\">" + value + "</span>";
	}
	if (typeof value === "boolean") {
		return "<span class=\"j-bool\">" + value + "</span>";
	}
	return escapeHtml(String(value));
};

/**
 * @param {*} value
 * @param {number} openDepth levels expanded initially
 * @param {function(string, *): string} [annotate] extra html after a key (path, value)
 */
export const renderTree = (value, openDepth, annotate, path) => {
	const here = path || "";
	if (value === null || typeof value !== "object") {
		return leaf(value);
	}
	const isArray = Array.isArray(value);
	const keys = Object.keys(value);
	const summary = isArray ? "[" + keys.length + "]" : "{" + keys.length + "}";
	const open = openDepth > 0 ? " open" : "";
	const items = keys.slice(0, MAX_CHILDREN).map((key) => {
		const child = value[key];
		const childPath = here + (isArray ? "[" + key + "]" : "." + key);
		const extra = annotate ? annotate(childPath, child) : "";
		const label = "<span class=\"j-key\">" + escapeHtml(key) + "</span>" + extra + ": ";
		if (child !== null && typeof child === "object") {
			return "<li>" + label + renderTree(child, openDepth - 1, annotate, childPath) + "</li>";
		}
		return "<li>" + label + leaf(child) + "</li>";
	});
	if (keys.length > MAX_CHILDREN) {
		items.push("<li class=\"muted\">… " + (keys.length - MAX_CHILDREN) + " more</li>");
	}
	return "<details data-path=\"" + escapeHtml(here) + "\"" + open + "><summary class=\"muted\">" + summary + "</summary><ul class=\"tree\">" + items.join("") + "</ul></details>";
};

/**
 * Re-render into `el`, keeping whichever nodes the user expanded or collapsed.
 */
export const updateTree = (el, value, openDepth, annotate) => {
	const state = {};
	el.querySelectorAll("details[data-path]").forEach((d) => {
		state[d.dataset.path] = d.open;
	});
	el.innerHTML = renderTree(value, openDepth, annotate);
	el.querySelectorAll("details[data-path]").forEach((d) => {
		if (Object.prototype.hasOwnProperty.call(state, d.dataset.path)) {
			d.open = state[d.dataset.path];
		}
	});
};
