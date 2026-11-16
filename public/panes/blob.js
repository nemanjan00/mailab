// Blob analysis: `file` type, entropy profile, binwalk signatures and,
// with config.compare, a byte diff against another blob.

import { el, list, state, when } from "@nemanjan00/qrp";
import { empty, pane, table, widget } from "../sdk/index.js";
import { drawPlot } from "./plot2d.js";
import { eng } from "./util.js";

const hex = (n, width) => "0x" + n.toString(16).padStart(width || 6, "0");
const CONTEXT_ROWS = 1;
const MAX_DIFF_ROWS = 40;

// hex rows (16 bytes) covering the changed ranges, with a little context
const diffRows = (a, b, ranges) => {
	const rows = new Set();
	ranges.forEach((r) => {
		for (let row = Math.floor(r.start / 16) - CONTEXT_ROWS; row <= Math.floor((r.end - 1) / 16) + CONTEXT_ROWS; row++) {
			if (row >= 0) {
				rows.add(row);
			}
		}
	});
	return [...rows].sort((x, y) => x - y).slice(0, MAX_DIFF_ROWS).map((row) => {
		const cells = (buf, other) => Array.from({ length: 16 }, (_, i) => {
			const at = row * 16 + i;
			if (at >= buf.length) {
				return el("span", { class: "muted" }, "  ");
			}
			const changed = at >= other.length || buf[at] !== other[at];
			return el("span", { class: changed ? "hit" : "" }, buf[at].toString(16).padStart(2, "0"));
		});
		const spaced = (spans) => spans.reduce((acc, s, i) => acc.concat(i ? [" ", s] : [s]), []);
		return el("div", { class: "diff-row" },
			el("span", { class: "muted" }, hex(row * 16) + " "),
			el("span", { class: "diff-a" }, ...spaced(cells(a, b))), "  │  ",
			el("span", { class: "diff-b" }, ...spaced(cells(b, a))));
	});
};

const fetchBytes = (name) => fetch("/api/blobs/" + encodeURIComponent(name)).then((res) => {
	if (!res.ok) {
		throw new Error("blob " + name + " not found");
	}
	return res.arrayBuffer();
}).then((buf) => new Uint8Array(buf));

export default pane((ctx, p) => {
	const view = state({ info: null, diff: null, error: "" });
	let canvas = null;

	const draw = () => {
		if (canvas && view.info) {
			const e = view.info.entropy;
			drawPlot(canvas, { x: e.x, xUnit: "offset", yUnit: "bits/byte", series: [{ label: "entropy", x: e.x, y: e.y }] }, ctx.color);
		}
	};

	const load = () => {
		const cfg = p.pane.config;
		if (!cfg.blob) {
			return;
		}
		ctx.api("GET", "/blobs/" + encodeURIComponent(cfg.blob) + "/analysis").then((info) => {
			view.info = Object.freeze(info);
			view.error = "";
			draw();
		}, (err) => {
			view.error = err.message;
		});
		if (cfg.compare) {
			Promise.all([fetchBytes(cfg.blob), fetchBytes(cfg.compare), ctx.api("GET", "/blobs/" + encodeURIComponent(cfg.blob) + "/diff/" + encodeURIComponent(cfg.compare))])
				.then((r) => {
					view.diff = Object.freeze({ summary: r[2], rows: diffRows(r[0], r[1], r[2].ranges) });
				}, (err) => {
					view.error = err.message;
				});
		}
	};
	load();
	const off = ctx.on("blob", (msg) => {
		if (msg.name === p.pane.config.blob || msg.name === p.pane.config.compare) {
			load();
		}
	});

	return when(() => p.pane.config.blob, () => el("div", { class: "blobpane" },
		el("div", { class: "pad blob-head" },
			() => (view.info ? el("span", {},
				el("b", {}, p.pane.config.blob), " · " + eng(view.info.size, 1) + "B · ",
				el("span", { class: "mono" }, view.info.type || "?"), " · sha256 ",
				el("span", { class: "mono muted" }, view.info.sha256.slice(0, 16) + "…"), " · entropy " + view.info.entropy.mean + " bits/byte")
				: el("span", { class: "muted" }, view.error || "analyzing…"))),
		el("div", { class: "blob-plot" }, widget((host) => {
			canvas = el("canvas", { class: "full" });
			host.style.position = "relative";
			host.append(canvas);
			draw();
			return { resize: draw, destroy: off };
		})),
		when(() => view.info && view.info.signatures.length, () => table({
			rows: () => view.info.signatures,
			key: (sig) => sig.offset + ":" + sig.name,
			columns: [
				{ title: "offset", mono: true, value: (sig) => hex(sig.offset) },
				{ title: "type", value: (sig) => sig.name },
				{ title: "size", num: true, value: (sig) => eng(sig.size, 1) + "B" },
				{ title: "description", muted: true, value: (sig) => sig.description }
			]
		})),
		when(() => view.info && view.info.entropy.regions.length, () => el("div", { class: "pad muted" },
			list(() => view.info.entropy.regions, (r) => r.start + r.kind, (r) => el("span", { class: "region " + r.kind },
				r.kind + " entropy " + hex(r.start) + "–" + hex(r.end) + "  ")))),
		when(() => view.diff, () => el("div", { class: "pad blob-diff" },
			el("div", {}, () => "diff vs " + p.pane.config.compare + ": " + view.diff.summary.changedBytes + " bytes changed in "
				+ view.diff.summary.ranges.length + " ranges"),
			el("div", { class: "mono diff-rows" }, () => view.diff.rows)))
	), () => empty("set config.blob (and config.compare to diff two blobs)"));
});
