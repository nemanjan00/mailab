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

/**
 * Keyed, reactive table.
 * @param {{rows: function(): Array, key: function(*): *, columns: Array, empty: string}} spec
 *   columns: [{title, value: (row) => renderable, mono, num, muted}]; value is wrapped
 *   in a thunk, so it stays live as the row changes
 */
export const table = (spec) => {
	const cellClass = (c) => [c.mono && "mono", c.num && "num", c.muted && "muted"].filter(Boolean).join(" ");
	const body = el("table", {},
		el("thead", {}, el("tr", {}, ...spec.columns.map((c) => el("th", {}, c.title || "")))),
		el("tbody", {}, list(spec.rows, spec.key, (row) => el("tr", {},
			...spec.columns.map((c) => el("td", { class: cellClass(c) }, () => c.value(row)))))));
	if (!spec.empty) {
		return body;
	}
	return when(() => spec.rows().length > 0, () => body, () => empty(spec.empty));
};

/**
 * Append-only log-style feed (activity, chat, logs) that keeps the newest in view.
 * @param {{items: function(): Array, key: function(*): *, render: function(*): Node, empty: string, className: string}} spec
 */
export const feed = (spec) => {
	const box = el("div", { class: "feed " + (spec.className || "") },
		when(() => spec.items().length === 0, () => el("div", { class: "muted" }, spec.empty || "")),
		list(spec.items, spec.key, spec.render));
	// stick to the bottom while new items arrive
	new MutationObserver(() => {
		box.scrollTop = box.scrollHeight;
	}).observe(box, { childList: true });
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
