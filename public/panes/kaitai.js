// Kaitai Struct view: parse a lab blob with a .ksy (parsed on the server),
// show the field tree with byte ranges next to a hex dump; click a field to
// highlight its bytes.

import { updateTree } from "./tree.js";
import { escapeHtml } from "./util.js";

const HEX_BYTES = 4096;
const ROW = 16;

const hexDump = (bytes, range) => {
	const rows = [];
	for (let off = 0; off < bytes.length; off += ROW) {
		const cells = [];
		const chars = [];
		for (let i = off; i < Math.min(off + ROW, bytes.length); i++) {
			const hit = range && i >= range[0] && i < range[1];
			const b = bytes[i];
			cells.push("<span" + (hit ? " class=\"hit\"" : "") + ">" + b.toString(16).padStart(2, "0") + "</span>");
			const ch = b >= 32 && b < 127 ? escapeHtml(String.fromCharCode(b)) : ".";
			chars.push(hit ? "<span class=\"hit\">" + ch + "</span>" : ch);
		}
		rows.push("<div><span class=\"muted\">" + off.toString(16).padStart(6, "0") + "</span> " + cells.join(" ") + "  " + chars.join("") + "</div>");
	}
	return rows.join("");
};

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		let bytes = new Uint8Array(0);
		let result = null;
		let selected = null;
		body.innerHTML = "<div class=\"kaitai\"><div class=\"k-tree pad mono jsonview\"></div><div class=\"k-hex mono\"></div></div>";
		const treeEl = body.querySelector(".k-tree");
		const hexEl = body.querySelector(".k-hex");

		const annotate = (path) => {
			const r = result && result.ranges[path];
			if (!r) {
				return "";
			}
			return " <span class=\"k-range\" data-path=\"" + escapeHtml(path) + "\">[" + r[0].toString(16) + "–" + r[1].toString(16) + ")</span>";
		};

		const renderHex = () => {
			let range = null;
			if (selected && result) {
				range = result.ranges[selected];
			}
			hexEl.innerHTML = hexDump(bytes.slice(0, HEX_BYTES), range)
				+ (bytes.length > HEX_BYTES ? "<div class=\"muted\">… " + (bytes.length - HEX_BYTES) + " more bytes</div>" : "");
			const hit = hexEl.querySelector(".hit");
			if (hit) {
				hit.scrollIntoView({ block: "nearest" });
			}
		};

		const load = () => {
			if (!pane.config.blob || !pane.config.ksy) {
				treeEl.innerHTML = "<span class=\"muted\">set config.blob (a lab blob) and config.ksy (.ksy YAML)</span>";
				hexEl.innerHTML = "";
				return;
			}
			fetch("/api/blobs/" + encodeURIComponent(pane.config.blob))
				.then((res) => {
					if (!res.ok) {
						throw new Error("blob " + pane.config.blob + " not found");
					}
					return res.arrayBuffer();
				})
				.then((buf) => {
					bytes = new Uint8Array(buf);
					return ctx.api("POST", "/kaitai", { blob: pane.config.blob, ksy: pane.config.ksy });
				})
				.then((res) => {
					result = res;
					const header = "<div class=\"muted\">" + escapeHtml(res.type) + " · " + bytes.length + " bytes"
						+ (res.error ? " · <span class=\"err\">stopped: " + escapeHtml(res.error) + "</span>" : "") + "</div>";
					updateTree(treeEl, res.tree, Number(pane.config.depth) || 2, annotate);
					treeEl.insertAdjacentHTML("afterbegin", header);
					renderHex();
				}, (err) => {
					treeEl.innerHTML = "<span class=\"err\">" + escapeHtml(err.message) + "</span>";
					renderHex();
				});
		};

		treeEl.addEventListener("click", (event) => {
			const tag = event.target.closest(".k-range");
			if (!tag) {
				return;
			}
			selected = tag.dataset.path;
			treeEl.querySelectorAll(".k-range.on").forEach((el) => el.classList.remove("on"));
			tag.classList.add("on");
			renderHex();
		});

		const off = ctx.on("blob", (msg) => {
			if (msg.name === pane.config.blob) {
				load();
			}
		});
		load();

		return {
			update: (next) => {
				pane = next;
				load();
			},
			destroy: off
		};
	}
};
