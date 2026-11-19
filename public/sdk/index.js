// mailab GUI SDK: small, lab-styled qrp components so a pane reads as a
// declaration of what it shows. Everything returns real DOM (qrp el), so
// imperative widgets (uPlot, canvas) compose in as plain nodes.
//
//   export default pane((ctx) => table({
//       rows: () => ctx.state.devices, key: (d) => d.id,
//       columns: [{ title: "id", mono: true, value: (d) => d.id }, ...],
//       empty: "no devices"
//   }));

import { el, list, mount, onDispose, state, when } from "@nemanjan00/qrp";
import { stickToBottom } from "@nemanjan00/qrp/behaviors/stick-to-bottom";
import tableUtil from "../../src/utils/table/index.js";

/**
 * Turn a view function into a pane module: mounts it with qrp and disposes it
 * (effects + DOM) when the pane goes away. `p.pane` is reactive, so thunks
 * reading `p.pane.config.x` follow edits made by the user or the AI.
 * @param {function(Object, {pane: Object}, HTMLElement): *} view (ctx, p, body) -> renderable
 */
export const pane = (view) => {
	return {
		mount: (body, initial, ctx) => {
			const p = state({ pane: initial });
			const mounted = mount(body, () => view(ctx, p, body));
			return {
				update: (next) => {
					p.pane = next;
				},
				destroy: () => {
					mounted.dispose();
				}
			};
		}
	};
};

/**
 * Placeholder text for empty panes.
 */
export const empty = (text) => el("div", { class: "empty" }, text);

/**
 * Small borderless icon button.
 * @param {string|function} icon
 * @param {string|function} title
 * @param {function(Event)} onclick
 */
export const iconButton = (icon, title, onclick) => el("button", { class: "icon", title: title, onclick: onclick }, icon);

// plain text of a rendered cell (string, number, node, array of those)
const textOf = (value) => {
	if (value === null || value === undefined || value === false) {
		return "";
	}
	if (Array.isArray(value)) {
		return value.map(textOf).filter(Boolean).join(" ");
	}
	if (typeof value === "function") {
		return textOf(value());
	}
	if (typeof Node !== "undefined" && value instanceof Node) {
		return value.textContent;
	}
	return String(value);
};

const download = (filename, type, content) => {
	const url = URL.createObjectURL(new Blob([content], { type: type }));
	const link = el("a", { href: url, download: filename });
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const SORT_MARKS = { "1": " ▲", "-1": " ▼" };

/**
 * Sort / filter / export view state for table(); pass one in as `spec.ui` to
 * keep it across a rebuilt table (e.g. when its columns change).
 */
export const tableState = () => state({ filter: "", sort: -1, dir: 0 });

/**
 * Keyed, reactive table with click-to-sort headers (asc → desc → off;
 * numbers and engineering notation by value, text in natural order), a filter
 * box ("text", "col:text", all terms must match) and CSV / JSON export of the
 * visible rows.
 * @param {Object} spec
 * @param {function(): Array} spec.rows thunk returning the rows
 * @param {function(*): *} spec.key unique key per row
 * @param {Array<Object>} spec.columns [{title, value, raw, text, mono, num, muted}]:
 *   value: (row) => renderable, wrapped in a thunk so it stays live;
 *   raw: (row) => value to sort, filter and export (default: the cell's text);
 *   text: (row) => searchable text besides raw. Untitled columns (actions)
 *   are left out of sorting, filtering and export.
 * @param {string} [spec.empty] placeholder when there are no rows at all
 * @param {boolean} [spec.tools] false hides the filter / export row (headers still sort)
 * @param {string} [spec.name] export file name (no extension)
 * @param {string} [spec.className] class of the <table>
 * @param {Object} [spec.ui] state from tableState()
 */
export const table = (spec) => {
	const ui = spec.ui || tableState();
	const cellClass = (c) => [c.mono && "mono", c.num && "num", c.muted && "muted"].filter(Boolean).join(" ");
	const data = spec.columns.filter((c) => c.title).map((c) => ({
		title: c.title,
		raw: c.raw || ((row) => textOf(c.value(row))),
		text: c.text
	}));
	const visible = () => tableUtil.view(spec.rows(), data, { filter: ui.filter, sort: ui.sort, dir: ui.dir });

	const toggle = (index) => {
		if (ui.sort !== index) {
			ui.sort = index;
			ui.dir = 1;
		} else if (ui.dir === 1) {
			ui.dir = -1;
		} else {
			ui.sort = -1;
			ui.dir = 0;
		}
	};

	const header = (c) => {
		const index = data.findIndex((d) => d.title === c.title);
		if (!c.title) {
			return el("th", {});
		}
		return el("th", { class: "sortable", title: "sort", onclick: () => toggle(index) },
			c.title, el("span", { class: "sort-mark" }, () => (ui.sort === index ? SORT_MARKS[ui.dir] || "" : "")));
	};

	const exportAs = (format) => {
		const titles = data.map((d) => d.title);
		const matrix = visible().map((row) => data.map((d) => d.raw(row)));
		const base = String(spec.name || "table").replace(/[^\w.-]+/g, "_");
		if (format === "csv") {
			download(base + ".csv", "text/csv", tableUtil.toCSV(titles, matrix));
			return;
		}
		download(base + ".json", "application/json", tableUtil.toJSON(titles, matrix));
	};

	const tools = spec.tools === false ? "" : el("div", { class: "table-tools" },
		el("input", { type: "search", class: "table-filter", placeholder: "filter… (col:text)", bind: [ui, "filter"] }),
		el("span", { class: "muted mono" }, () => (ui.filter ? visible().length + "/" + spec.rows().length : "")),
		iconButton("csv", "export visible rows as CSV", () => exportAs("csv")),
		iconButton("json", "export visible rows as JSON", () => exportAs("json")));

	const body = el("div", { class: "sdk-table" },
		tools,
		el("table", { class: spec.className || "" },
			el("thead", {}, el("tr", {}, ...spec.columns.map(header))),
			el("tbody", {}, list(visible, spec.key, (row) => el("tr", {},
				...spec.columns.map((c) => el("td", { class: cellClass(c) }, () => c.value(row))))))),
		when(() => ui.filter && visible().length === 0, () => el("div", { class: "empty" }, "no rows match the filter")));
	if (!spec.empty) {
		return body;
	}
	return when(() => spec.rows().length > 0, () => body, () => empty(spec.empty));
};

/**
 * Table of plain objects (a lab value's rows): columns are the union of the
 * rows' keys, rebuilt when the key set changes; sort / filter survive that.
 * @param {{rows: function(): Array, name: string, empty: string, tools: boolean}} spec
 */
export const objectTable = (spec) => {
	const ui = tableState();
	const isObject = (r) => r !== null && typeof r === "object" && !Array.isArray(r);
	const rows = () => spec.rows().map((r, i) => ({ i: i, r: r }));
	const cell = (key) => (x) => {
		if (!isObject(x.r)) {
			return key === "value" ? x.r : undefined;
		}
		return x.r[key];
	};
	return when(() => tableUtil.keysOf(spec.rows()).join("\u0000"), (signature) => table({
		rows: rows,
		key: (x) => x.i,
		ui: ui,
		name: spec.name,
		tools: spec.tools,
		columns: signature.split("\u0000").map((key) => ({
			title: key,
			raw: cell(key),
			value: (x) => tableUtil.text(cell(key)(x))
		}))
	}), () => empty(spec.empty || "no rows"));
};

/**
 * Append-only log-style feed (activity, chat, logs) that keeps the newest in view.
 * @param {{items: function(): Array, key: function(*): *, render: function(*): Node, empty: string, className: string}} spec
 */
export const feed = (spec) => {
	const box = el("div", { class: "feed " + (spec.className || "") },
		when(() => spec.items().length === 0, () => el("div", { class: "muted" }, spec.empty || "")),
		list(spec.items, spec.key, spec.render));
	// follow new content only while the user is at the bottom; scrolling up
	// to read history unpins (disposes with the pane's scope)
	stickToBottom(box);
	return box;
};

/**
 * Row of controls at the top of a pane.
 */
export const toolbar = (...children) => el("div", { class: "toolbar pad" }, ...children);

/**
 * Text input bound to state[key].
 */
export const field = (store, key, props) => el("input", Object.assign({ bind: [store, key] }, props || {}));

/**
 * Wrap an imperative widget (uPlot, canvas…) as a qrp-composable node.
 * @param {function(HTMLElement): {resize: function, destroy: function}} create gets a host div
 */
export const widget = (create) => {
	const host = el("div", { class: "widget" });
	let instance = null;
	const observer = new ResizeObserver(() => {
		if (instance && instance.resize) {
			instance.resize();
		}
	});
	let disposed = false;
	// released with the owning qrp scope (pane removal, when() branch switch)
	onDispose(() => {
		disposed = true;
		observer.disconnect();
		if (instance && instance.destroy) {
			instance.destroy();
		}
	});
	// create after insertion so the widget can measure its host
	requestAnimationFrame(() => {
		if (disposed) {
			return;
		}
		instance = create(host);
		observer.observe(host);
	});
	return host;
};

export { numberField } from "./number-field.js";
