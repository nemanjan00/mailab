// Hex editor on a lab blob: virtual-scrolled hex + ASCII rows (only visible
// rows rendered, bytes fetched in pages, fine on 64 MB dumps), keyboard and
// mouse selection, poke / insert / delete / fill with undo saved to the
// server, search & replace, data inspector, checksums, side-by-side diff
// against config.compare, bookmarks, and analysis / kaitai overlays in the
// scroll gutter. The grid is imperative (innerHTML per frame); toolbar and
// side panels are qrp.

import { effect, el, list, onDispose, state, untracked, when } from "@nemanjan00/qrp";
import { empty, iconButton, pane, table } from "../sdk/index.js";
import bytesUtil from "../../src/utils/bytes/index.js";
import offsetexpr from "../../src/utils/offsetexpr/index.js";
import { createPager, createWriter } from "./hex-pager.js";

const ROW_H = 18;
const ROW_SIZES = [8, 16, 32];
const WHEEL_ROWS = 3;
const COPY_MAX = 1024 * 1024;
const DIFF_DELAY_MS = 800;
const MIN_BAND_PX = 2;
const INT_TYPES = ["u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64"];
const TABS = ["inspect", "find", "select", "calc", "diff", "marks"];
const CALC_PRESETS = { common: null, all: "all", crc8: /^crc8/, crc16: /^crc16/, crc32: /^crc32/, sums: /^(sum|xor|twos|inet|adler)/, hashes: /^(md5|sha)/ };

const hex = (n, width) => "0x" + n.toString(16).padStart(width || 1, "0");

const copyText = (text) => {
	const fallback = () => {
		const area = el("textarea", { style: "position:fixed;opacity:0" });
		area.value = text;
		document.body.append(area);
		area.select();
		document.execCommand("copy");
		area.remove();
	};
	if (navigator.clipboard && window.isSecureContext) {
		return navigator.clipboard.writeText(text).catch(fallback);
	}
	fallback();
	return Promise.resolve();
};

// offset of a value given as number or "0x..." string
const toOffset = (value, fallback) => {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}
	try {
		return offsetexpr.evaluate(String(value));
	} catch (_err) {
		return fallback;
	}
};

const fmtValue = (v, type) => {
	if (v === undefined) {
		return "";
	}
	if (typeof v === "bigint") {
		return v.toString();
	}
	if (type && type[0] === "f") {
		return type === "f32" ? String(Number(v.toPrecision(8))) : String(v);
	}
	return String(v);
};

const editor = (ctx, p) => {
	const cfg = () => p.pane.config;
	const name = cfg().blob;
	const compare = cfg().compare || "";
	const enc = encodeURIComponent;

	const ui = state({
		cursor: 0, selStart: 0, selEnd: 0, size: null, sizeB: null, tab: "inspect", panel: true,
		save: "saved", error: "", note: "", canUndo: false, canRedo: false, insert: false, col: "hex",
		inspect: null, jump: "", jumpError: "",
		find: { mode: "hex", query: "", encoding: "ascii", ignoreCase: false, inSel: false, replace: "", msg: "" },
		hits: [], hitsTruncated: false,
		calc: null, calcPreset: "common", calcWhole: false, catalogue: [],
		diff: null, fill: "00", insertHex: "", markLabel: "", overlays: null, kaitai: [], status: ""
	});

	// imperative view state (changes every keystroke; not reactive on purpose)
	const ed = { top: 0, cursor: 0, anchor: 0, nibble: 0, nibbleValue: 0, visible: 20, dragging: false, hit: null, hits: [], gutterDrag: false };

	let gridEl = null;
	let rowsEl = null;
	let gutterEl = null;
	let queued = false;

	const schedule = () => {
		if (queued) {
			return;
		}
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			render();
		});
	};

	const pager = createPager(name, schedule);
	const pagerB = compare ? createPager(compare, schedule) : null;
	const writer = createWriter({
		name: name,
		pager: pager,
		api: ctx.api,
		onState: (s) => {
			ui.save = s.save;
			ui.error = s.error;
			ui.note = s.note;
			ui.canUndo = s.canUndo;
			ui.canRedo = s.canRedo;
		}
	});
	pager.want(0, 1);
	if (pagerB) {
		pagerB.want(0, 1);
	}

	const bpr = () => (ROW_SIZES.indexOf(Number(cfg().bytesPerRow)) !== -1 ? Number(cfg().bytesPerRow) : 16);
	const base = () => toOffset(cfg().base, 0);
	const size = () => pager.size || 0;
	const sel = () => ({ start: Math.min(ed.anchor, ed.cursor), end: Math.max(ed.anchor, ed.cursor) });
	const selLength = () => {
		const s = sel();
		return Math.min(s.end, size() - 1) - s.start + 1;
	};
	const bookmarks = () => (Array.isArray(cfg().bookmarks) ? cfg().bookmarks : []);

	// ---- navigation -------------------------------------------------------

	const totalRows = () => Math.floor(size() / bpr()) + 1;
	const clampTop = () => {
		ed.top = Math.max(0, Math.min(ed.top, totalRows() - ed.visible));
	};

	const reveal = (o, center) => {
		const row = Math.floor(o / bpr());
		if (center) {
			ed.top = row - Math.floor(ed.visible / 2);
		} else if (row < ed.top) {
			ed.top = row;
		} else if (row >= ed.top + ed.visible) {
			ed.top = row - ed.visible + 1;
		}
		clampTop();
	};

	/**
	 * Move the cursor; extend keeps the selection anchor.
	 */
	const moveTo = (o, extend, center) => {
		ed.cursor = Math.max(0, Math.min(size(), o));
		if (!extend) {
			ed.anchor = ed.cursor;
		}
		ed.nibble = 0;
		reveal(ed.cursor, center);
		schedule();
	};

	const selectRange = (start, end) => {
		ed.anchor = Math.max(0, Math.min(size(), start));
		ed.cursor = Math.max(0, Math.min(size(), end - 1));
		ed.nibble = 0;
		reveal(ed.anchor, true);
		schedule();
	};

	const exprVars = () => {
		const s = sel();
		return { end: size(), size: size(), cur: ed.cursor, here: ed.cursor, sel: s.start, sel_end: s.end + 1, sel_len: s.end - s.start + 1, base: base(), top: ed.top * bpr() };
	};

	const jump = () => {
		try {
			const text = ui.jump.trim();
			let target;
			if (text[0] === "@") {
				target = offsetexpr.evaluate(text.slice(1), exprVars()) - base();
			} else {
				target = offsetexpr.evaluate(text, exprVars());
			}
			if (target < 0 || target > size()) {
				throw new Error(hex(target) + " is outside the blob (0…" + hex(size()) + ")");
			}
			ui.jumpError = "";
			moveTo(target, false, true);
			gridEl.focus();
		} catch (err) {
			ui.jumpError = err.message;
		}
	};

	// ---- editing ----------------------------------------------------------

	const typeNibble = (v) => {
		const o = ed.cursor;
		if (o > size()) {
			return;
		}
		if (ed.nibble === 0) {
			const old = o < size() ? writer.byte(o) : 0;
			if (old === undefined && !ui.insert) {
				return;
			}
			ed.nibbleValue = (v << 4) | ((ui.insert ? 0 : old) & 0x0F);
			if (ui.insert) {
				writer.commit([{ op: "insert", offset: o, hex: hex(ed.nibbleValue, 2).slice(2) }]);
			} else {
				writer.poke(o, [ed.nibbleValue]);
			}
			ed.nibble = 1;
		} else {
			ed.nibbleValue = (ed.nibbleValue & 0xF0) | v;
			writer.poke(o, [ed.nibbleValue], !ui.insert);
			ed.nibble = 0;
			ed.cursor = o + 1;
		}
		ed.anchor = ed.cursor;
		reveal(ed.cursor);
		schedule();
	};

	const typeChar = (code) => {
		const o = ed.cursor;
		if (code > 0xFF || o > size()) {
			return;
		}
		if (ui.insert) {
			writer.commit([{ op: "insert", offset: o, hex: hex(code, 2).slice(2) }]);
		} else {
			writer.poke(o, [code]);
		}
		ed.cursor = o + 1;
		ed.anchor = ed.cursor;
		ed.nibble = 0;
		reveal(ed.cursor);
		schedule();
	};

	const deleteSelection = () => {
		const s = sel();
		const length = Math.min(s.end, size() - 1) - s.start + 1;
		if (length <= 0) {
			return;
		}
		writer.commit([{ op: "delete", offset: s.start, length: length }]);
		moveTo(s.start);
	};

	const fillSelection = () => {
		const s = sel();
		try {
			const pattern = bytesUtil.toHex(bytesUtil.parseHex(ui.fill || "00"));
			writer.commit([{ op: "fill", offset: s.start, length: selLength(), hex: pattern }]);
			ui.error = "";
		} catch (err) {
			ui.error = err.message;
		}
	};

	const insertBytes = () => {
		try {
			const data = bytesUtil.toHex(bytesUtil.parseHex(ui.insertHex));
			if (!data) {
				return;
			}
			writer.commit([{ op: "insert", offset: ed.cursor, hex: data }]);
			ui.error = "";
		} catch (err) {
			ui.error = err.message;
		}
	};

	const writeTyped = (type, value) => {
		try {
			writer.poke(ed.cursor, Array.from(bytesUtil.encode(type, value)));
			ui.error = "";
			schedule();
		} catch (err) {
			ui.error = err.message;
		}
	};

	// bytes of a range with unsaved edits applied
	const fetchRange = (start, length) => {
		if (length > COPY_MAX) {
			return Promise.reject(new Error("selection larger than " + COPY_MAX + " bytes"));
		}
		return writer.flush().then(() => fetch("/api/blobs/" + enc(name) + "/range?offset=" + start + "&length=" + length))
			.then((res) => res.arrayBuffer())
			.then((buf) => new Uint8Array(buf));
	};

	const copyAs = (format) => {
		const s = sel();
		fetchRange(s.start, selLength()).then((data) => {
			return copyText(bytesUtil.format(data, format, { name: name.replace(/\W/g, "_") }));
		}).then(() => {
			ui.note = "copied " + selLength() + " bytes as " + format;
		}, (err) => {
			ui.error = err.message;
		});
	};

	const saveAs = (selectionOnly) => {
		const s = sel();
		ctx.dialog(selectionOnly ? "Save selection as blob" : "Save blob as", [
			{ name: "to", label: "new blob name", value: name + (selectionOnly ? "_" + s.start.toString(16) : "_copy") }
		]).then((values) => {
			if (!values || !values.to) {
				return null;
			}
			const body = { to: values.to };
			if (selectionOnly) {
				body.offset = s.start;
				body.length = selLength();
			}
			return writer.flush().then(() => ctx.api("POST", "/blobs/" + enc(name) + "/slice", body)).then((r) => {
				ui.note = "saved " + r.bytes + " bytes as " + r.name;
			});
		}).catch((err) => {
			ui.error = err.message;
		});
	};

	// ---- search / replace -------------------------------------------------

	const findSpec = () => {
		const f = ui.find;
		if (f.mode === "hex") {
			return { hex: f.query };
		}
		if (f.mode === "text") {
			return { text: f.query, encoding: f.encoding, ignoreCase: f.ignoreCase };
		}
		return { regex: f.query, flags: f.ignoreCase ? "i" : "" };
	};

	const searchQuery = (extra) => {
		const params = new URLSearchParams();
		const spec = Object.assign(findSpec(), extra);
		Object.keys(spec).forEach((key) => {
			if (spec[key] !== undefined && spec[key] !== "" && spec[key] !== false) {
				params.set(key, String(spec[key]));
			}
		});
		if (ui.find.inSel && selLength() > 1) {
			params.set("start", String(sel().start));
			params.set("end", String(sel().end + 1));
		}
		return "/blobs/" + enc(name) + "/search?" + params.toString();
	};

	const find = (dir) => {
		if (!ui.find.query) {
			return;
		}
		const from = dir === "prev" ? sel().start : sel().start + 1;
		writer.flush().then(() => ctx.api("GET", searchQuery({ dir: dir, from: from, wrap: true }))).then((r) => {
			if (!r.hits.length) {
				ui.find.msg = "not found";
				return;
			}
			const h = r.hits[0];
			ed.hit = h;
			ui.find.msg = "at " + hex(h.offset);
			selectRange(h.offset, h.offset + h.length);
		}, (err) => {
			ui.find.msg = err.message;
		});
	};

	const findAll = () => {
		if (!ui.find.query) {
			return;
		}
		writer.flush().then(() => ctx.api("GET", searchQuery({ dir: "all", max: 10000 }))).then((r) => {
			ed.hits = r.hits;
			ui.hits = Object.freeze(r.hits.slice(0, 2000));
			ui.hitsTruncated = r.truncated;
			ui.find.msg = r.hits.length + (r.truncated ? "+" : "") + " hits";
			schedule();
		}, (err) => {
			ui.find.msg = err.message;
		});
	};

	const replace = (all) => {
		const f = ui.find;
		if (!f.query) {
			return;
		}
		const rep = f.mode === "hex" ? { hex: f.replace } : { text: f.replace, encoding: f.encoding };
		const body = { find: findSpec(), replace: rep, all: all, from: sel().start };
		if (f.inSel && selLength() > 1) {
			body.start = sel().start;
			body.end = sel().end + 1;
		}
		writer.flush().then(() => ctx.api("POST", "/blobs/" + enc(name) + "/replace", body)).then((r) => {
			writer.recordUndo(r.undo);
			ui.find.msg = "replaced " + r.replaced + (r.truncated ? "+" : "");
			pager.invalidate();
			if (!all && r.hits.length) {
				const h = r.hits[0];
				moveTo(h.offset + Math.max(1, (f.mode === "hex" ? f.replace.replace(/[^0-9a-f?]/gi, "").length / 2 : f.replace.length)));
				find("next");
			}
		}, (err) => {
			ui.find.msg = err.message;
		});
	};

	const nextHit = (dir) => {
		if (ed.hits.length) {
			const at = dir === "prev"
				? ed.hits.filter((h) => h.offset < sel().start).pop() || ed.hits[ed.hits.length - 1]
				: ed.hits.find((h) => h.offset > sel().start) || ed.hits[0];
			ed.hit = at;
			selectRange(at.offset, at.offset + at.length);
			return;
		}
		find(dir);
	};

	// ---- calculators ------------------------------------------------------

	const runCalc = () => {
		const preset = CALC_PRESETS[ui.calcPreset];
		let algorithms = "";
		if (preset === "all") {
			algorithms = "all";
		} else if (preset) {
			algorithms = ui.catalogue.map((c) => c.name).filter((n) => preset.test(n)).join(",");
		}
		const whole = ui.calcWhole || selLength() <= 1;
		const params = new URLSearchParams();
		if (!whole) {
			params.set("offset", String(sel().start));
			params.set("length", String(selLength()));
		}
		if (algorithms) {
			params.set("algorithms", algorithms + (preset === "all" ? "" : ",histogram"));
		} else {
			params.set("algorithms", "crc8,crc16-ccitt-false,crc16-xmodem,crc16-modbus,crc32,crc32c,crc32-mpeg2,adler32,sum8,sum16,sum32,xor8,twos8,md5,sha1,sha256,entropy,histogram");
		}
		ui.calc = Object.freeze({ busy: true });
		writer.flush().then(() => ctx.api("GET", "/blobs/" + enc(name) + "/checksum?" + params.toString())).then((r) => {
			ui.calc = Object.freeze(r);
		}, (err) => {
			ui.calc = Object.freeze({ error: err.message });
		});
	};

	// ---- diff -------------------------------------------------------------

	let diffTimer = null;
	const loadDiff = () => {
		if (!compare) {
			return;
		}
		clearTimeout(diffTimer);
		diffTimer = setTimeout(() => {
			ctx.api("GET", "/blobs/" + enc(name) + "/diff/" + enc(compare)).then((r) => {
				ui.diff = Object.freeze(r);
				schedule();
			}, (err) => {
				ui.diff = Object.freeze({ error: err.message, ranges: [] });
			});
		}, DIFF_DELAY_MS);
	};

	const jumpChange = (dir) => {
		const from = dir === "prev" ? sel().start : sel().end + 1;
		writer.flush().then(() => ctx.api("GET", "/blobs/" + enc(name) + "/change/" + enc(compare) + "?from=" + from + "&dir=" + dir)).then((r) => {
			if (r.change) {
				selectRange(r.change.start, r.change.end);
				ui.note = "change " + hex(r.change.start) + "–" + hex(r.change.end) + " (" + (r.change.end - r.change.start) + " bytes)";
			} else {
				ui.note = "no more changes " + (dir === "prev" ? "before" : "after") + " the cursor";
			}
		}, (err) => {
			ui.error = err.message;
		});
	};

	// ---- overlays ---------------------------------------------------------

	const loadOverlays = () => {
		if (cfg().overlays === false) {
			return;
		}
		ctx.api("GET", "/blobs/" + enc(name) + "/analysis").then((r) => {
			ui.overlays = Object.freeze({ regions: r.entropy.regions, signatures: Array.isArray(r.signatures) ? r.signatures : [], type: r.type });
			schedule();
		}, () => null);
		if (cfg().ksy) {
			ctx.api("POST", "/kaitai", { blob: name, ksy: cfg().ksy }).then((r) => {
				const top = Object.keys(r.ranges || {}).filter((path) => /^\.?[^.[]+$/.test(path));
				ui.kaitai = Object.freeze(top.map((path) => ({ path: path.replace(/^\./, ""), start: r.ranges[path][0], end: r.ranges[path][1] })));
				schedule();
			}, () => null);
		}
	};

	const saveBookmarks = (next) => ctx.api("PATCH", "/panes/" + p.pane.id, { config: { bookmarks: next } });

	// ---- rendering --------------------------------------------------------

	// per-byte flags for the visible window: 1 hit, 2 current hit, 4 diff, 8 bookmark, 16 overlay start
	const flagsFor = (start, end) => {
		const flags = new Uint8Array(end - start);
		const mark = (s, e, bit) => {
			for (let o = Math.max(s, start); o < Math.min(e, end); o++) {
				flags[o - start] |= bit;
			}
		};
		// hits are sorted: binary search the first one ending after start
		let lo = 0;
		let hi = ed.hits.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (ed.hits[mid].offset + ed.hits[mid].length <= start) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		for (let i = lo; i < ed.hits.length && ed.hits[i].offset < end; i++) {
			mark(ed.hits[i].offset, ed.hits[i].offset + ed.hits[i].length, 1);
		}
		if (ed.hit) {
			mark(ed.hit.offset, ed.hit.offset + ed.hit.length, 2);
		}
		if (pagerB) {
			const sb = pagerB.size === null ? Infinity : pagerB.size;
			for (let o = start; o < end; o++) {
				const inA = o < size();
				const inB = o < sb;
				if (inA !== inB) {
					flags[o - start] |= 4;
				} else if (inA) {
					const a = writer.byte(o);
					const b = pagerB.byte(o);
					if (a !== undefined && b !== undefined && a !== b) {
						flags[o - start] |= 4;
					}
				}
			}
		}
		bookmarks().forEach((b) => {
			const o = toOffset(b.offset, -1);
			mark(o, o + 1, 8);
		});
		return flags;
	};

	const cellClass = (o, flag, s, column) => {
		const cls = [];
		if (o >= s.start && o <= s.end && s.end > s.start) {
			cls.push("sel");
		}
		if (o === ed.cursor) {
			cls.push(ui.col === column ? "cur" : "cur2");
		}
		if (flag & 2) {
			cls.push("hitc");
		} else if (flag & 1) {
			cls.push("hit");
		}
		if (flag & 4) {
			cls.push("dif");
		}
		if (flag & 8) {
			cls.push("bm");
		}
		if (writer.isDirty(o)) {
			cls.push("dirty");
		}
		return cls.join(" ");
	};

	const rowHtml = (rowStart, n, flags, start, s, source) => {
		const hexCells = [];
		const ascCells = [];
		const total = source.size;
		for (let i = 0; i < n; i++) {
			const o = rowStart + i;
			const gap = i && i % 8 === 0 ? " g" : "";
			if (o > total || (o === total && !source.editable)) {
				hexCells.push("<i class=\"nb" + gap + "\">  </i>");
				ascCells.push("<i class=\"nb\"> </i>");
				continue;
			}
			const flag = o < start + flags.length ? flags[o - start] : 0;
			if (o === total) {
				// append slot: typing here extends the blob
				hexCells.push("<i data-o=\"" + o + "\" class=\"end" + gap + " " + cellClass(o, 0, s, "hex") + "\">__</i>");
				ascCells.push("<i data-o=\"" + o + "\" class=\"end " + cellClass(o, 0, s, "ascii") + "\"> </i>");
				continue;
			}
			const v = source.byte(o);
			if (v === undefined) {
				hexCells.push("<i data-o=\"" + o + "\" class=\"na" + gap + "\">··</i>");
				ascCells.push("<i data-o=\"" + o + "\" class=\"na\">·</i>");
				continue;
			}
			const cls = source.editable ? cellClass(o, flag, s, "hex") : (flag & 4 ? "dif" : "") + (o === ed.cursor ? " cur2" : "");
			const zero = v === 0 ? " z" : "";
			hexCells.push("<i data-o=\"" + o + "\" class=\"" + cls + zero + gap + "\">" + (v < 16 ? "0" : "") + v.toString(16) + "</i>");
			const printable = v >= 0x20 && v < 0x7F;
			let ch = ".";
			if (printable) {
				ch = v === 0x3C ? "&lt;" : v === 0x3E ? "&gt;" : v === 0x26 ? "&amp;" : String.fromCharCode(v);
			}
			const acls = source.editable ? cellClass(o, flag, s, "ascii") : (flag & 4 ? "dif" : "");
			ascCells.push("<i data-o=\"" + o + "\" class=\"" + acls + (printable ? "" : " np") + "\">" + ch + "</i>");
		}
		return "<span class=\"hx-hex" + (source.editable ? "" : " hx-b") + "\">" + hexCells.join("") + "</span><span class=\"hx-asc"
			+ (source.editable ? "" : " hx-b") + "\">" + ascCells.join("") + "</span>";
	};

	const offsetLabel = (o) => {
		const addr = base() + o;
		if (cfg().radix === "dec") {
			return String(addr).padStart(10, " ");
		}
		return addr.toString(16).padStart(8, "0");
	};

	const render = () => {
		if (!rowsEl) {
			return;
		}
		const n = bpr();
		ed.visible = Math.max(1, Math.floor(gridEl.clientHeight / ROW_H));
		clampTop();
		const start = ed.top * n;
		const end = Math.min(start + ed.visible * n, size() + 1);
		if (size() > 0) {
			pager.want(start, Math.min(end, size()));
		}
		if (pagerB && pagerB.size) {
			pagerB.want(Math.min(start, pagerB.size - 1), Math.min(end, pagerB.size));
		}
		const flags = flagsFor(start, end);
		const s = sel();
		const srcA = { byte: writer.byte, size: size(), editable: true };
		const srcB = pagerB ? { byte: pagerB.byte, size: pagerB.size === null ? 0 : pagerB.size, editable: false } : null;
		const rows = [];
		for (let r = 0; r < ed.visible; r++) {
			const rowStart = start + r * n;
			if (rowStart > size() && (!srcB || rowStart >= srcB.size)) {
				break;
			}
			rows.push("<div class=\"hx-row\"><span class=\"hx-off\">" + offsetLabel(rowStart) + "</span>" + rowHtml(rowStart, n, flags, start, s, srcA)
				+ (srcB ? "<span class=\"hx-sep\">│</span>" + rowHtml(rowStart, n, flags, start, s, srcB) : "") + "</div>");
		}
		if (pager.size === null) {
			rows.push("<div class=\"hx-row muted\">" + (pager.error ? "error: " + pager.error.replace(/</g, "&lt;") : "loading…") + "</div>");
		}
		rowsEl.innerHTML = rows.join("");
		drawGutter();
		syncUi();
	};

	const syncUi = () => {
		const s = sel();
		ui.cursor = ed.cursor;
		ui.selStart = s.start;
		ui.selEnd = s.end;
		ui.size = pager.size;
		ui.sizeB = pagerB ? pagerB.size : null;
		// inspector: up to 8 bytes at the cursor, only once they are loaded
		const window8 = [];
		for (let o = ed.cursor; o < Math.min(ed.cursor + 8, size()); o++) {
			const v = writer.byte(o);
			if (v === undefined) {
				break;
			}
			window8.push(v);
		}
		const key = ed.cursor + ":" + window8.join(",");
		if (!ui.inspect || ui.inspect.key !== key) {
			ui.inspect = Object.freeze({ key: key, values: bytesUtil.inspect(Uint8Array.from(window8), 0), bytes: window8 });
		}
	};

	const drawGutter = () => {
		if (!gutterEl) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		const w = gutterEl.clientWidth;
		const h = gutterEl.clientHeight;
		if (!w || !h) {
			return;
		}
		gutterEl.width = w * dpr;
		gutterEl.height = h * dpr;
		const g = gutterEl.getContext("2d");
		g.scale(dpr, dpr);
		const total = Math.max(1, size());
		const y = (o) => (o / total) * h;
		const band = (s, e, color, x, width) => {
			g.fillStyle = color;
			const top = y(s);
			g.fillRect(x, top, width, Math.max(MIN_BAND_PX, y(e) - top));
		};
		const css = getComputedStyle(gutterEl);
		g.fillStyle = css.getPropertyValue("--panel-2") || "#333";
		g.fillRect(0, 0, w, h);
		const third = w / 3;
		const ov = ui.overlays;
		if (ov) {
			ov.regions.forEach((r) => band(r.start, r.end, r.kind === "high" ? ctx.color(2) : ctx.color(7), 0, third));
			ov.signatures.forEach((sig) => band(sig.offset, sig.offset + Math.max(1, sig.size || 1), ctx.color(3), 0, third));
		}
		ui.kaitai.forEach((k, i) => band(k.start, k.end, ctx.color(i % 2 ? 4 : 1), third, third));
		if (ui.diff && ui.diff.ranges) {
			ui.diff.ranges.forEach((r) => band(r.start, r.end, ctx.color(6), 2 * third, third));
		}
		ed.hits.forEach((hit) => band(hit.offset, hit.offset + hit.length, ctx.color(5), 2 * third, third));
		bookmarks().forEach((b) => {
			const o = toOffset(b.offset, 0);
			band(o, o + 1, ctx.color(0), 0, w);
		});
		// viewport
		const vs = ed.top * bpr();
		const ve = Math.min(total, vs + ed.visible * bpr());
		g.strokeStyle = css.getPropertyValue("--text") || "#fff";
		g.lineWidth = 1;
		g.strokeRect(0.5, y(vs) + 0.5, w - 1, Math.max(3, y(ve) - y(vs)) - 1);
		g.fillStyle = css.getPropertyValue("--accent") || "#0f0";
		g.fillRect(0, y(ed.cursor) - 1, w, 2);
	};

	// ---- input handlers ---------------------------------------------------

	const onKey = (e) => {
		const n = bpr();
		const mod = e.ctrlKey || e.metaKey;
		const k = e.key;
		const moves = {
			ArrowLeft: () => ed.cursor - 1,
			ArrowRight: () => ed.cursor + 1,
			ArrowUp: () => ed.cursor - n,
			ArrowDown: () => ed.cursor + n,
			PageUp: () => ed.cursor - n * ed.visible,
			PageDown: () => ed.cursor + n * ed.visible,
			Home: () => (mod ? 0 : ed.cursor - (ed.cursor % n)),
			End: () => (mod ? Math.max(0, size() - 1) : Math.min(size() - 1, ed.cursor - (ed.cursor % n) + n - 1))
		};
		if (moves[k]) {
			e.preventDefault();
			if (k === "PageUp" || k === "PageDown") {
				ed.top += (k === "PageUp" ? -1 : 1) * ed.visible;
				clampTop();
			}
			moveTo(moves[k](), e.shiftKey);
			return;
		}
		if (mod && (k === "z" || k === "Z")) {
			e.preventDefault();
			(e.shiftKey ? writer.redo() : writer.undo()).then(schedule);
			return;
		}
		if (mod && k === "y") {
			e.preventDefault();
			writer.redo().then(schedule);
			return;
		}
		if (mod && k === "c") {
			e.preventDefault();
			copyAs(ui.col === "ascii" ? "escaped" : "hex");
			return;
		}
		if (mod && k === "a") {
			e.preventDefault();
			ed.anchor = 0;
			ed.cursor = Math.max(0, size() - 1);
			schedule();
			return;
		}
		if (k === "F3" || (mod && k === "n")) {
			e.preventDefault();
			nextHit(e.shiftKey ? "prev" : "next");
			return;
		}
		if (mod) {
			return;
		}
		if (k === "Tab") {
			e.preventDefault();
			ui.col = ui.col === "hex" ? "ascii" : "hex";
			ed.nibble = 0;
			schedule();
			return;
		}
		if (k === "Insert") {
			e.preventDefault();
			ui.insert = !ui.insert;
			return;
		}
		if (k === "Delete") {
			e.preventDefault();
			deleteSelection();
			return;
		}
		if (k === "Backspace") {
			e.preventDefault();
			if (ui.insert && ed.cursor > 0) {
				writer.commit([{ op: "delete", offset: ed.cursor - 1, length: 1 }]);
			}
			moveTo(ed.cursor - 1);
			return;
		}
		if (k === "Escape") {
			ed.anchor = ed.cursor;
			ed.hit = null;
			schedule();
			return;
		}
		if (k.length === 1 && !e.altKey) {
			if (ui.col === "hex") {
				if (/^[0-9a-f]$/i.test(k)) {
					e.preventDefault();
					typeNibble(parseInt(k, 16));
				}
			} else {
				e.preventDefault();
				typeChar(k.charCodeAt(0));
			}
		}
	};

	const cellAt = (e) => {
		const t = e.target.closest && e.target.closest("[data-o]");
		return t ? { o: Number(t.dataset.o), ascii: Boolean(t.closest(".hx-asc")) } : null;
	};

	const onDown = (e) => {
		const c = cellAt(e);
		gridEl.focus();
		if (!c || e.button !== 0) {
			return;
		}
		e.preventDefault();
		ui.col = c.ascii ? "ascii" : "hex";
		ed.cursor = c.o;
		if (!e.shiftKey) {
			ed.anchor = c.o;
		}
		ed.nibble = 0;
		ed.dragging = true;
		schedule();
	};

	const onMove = (e) => {
		if (!ed.dragging) {
			return;
		}
		const c = cellAt(e);
		if (c && c.o !== ed.cursor) {
			ed.cursor = c.o;
			schedule();
		}
	};

	const onUp = () => {
		ed.dragging = false;
		ed.gutterDrag = false;
	};

	const onWheel = (e) => {
		e.preventDefault();
		const rows = e.deltaMode === 1 ? e.deltaY : e.deltaY / ROW_H;
		ed.top += Math.sign(rows) * Math.max(WHEEL_ROWS, Math.round(Math.abs(rows)));
		clampTop();
		schedule();
	};

	const gutterJump = (e) => {
		const rect = gutterEl.getBoundingClientRect();
		const frac = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
		ed.top = Math.round(frac * totalRows() - ed.visible / 2);
		clampTop();
		schedule();
	};

	const onGlobalMove = (e) => {
		if (ed.gutterDrag) {
			gutterJump(e);
		}
	};

	// ---- lab events -------------------------------------------------------

	const off = ctx.on("blob", (msg) => {
		if (msg.name === name) {
			pager.invalidate();
			loadDiff();
		} else if (msg.name === compare) {
			pagerB.invalidate();
			loadDiff();
		}
	});
	onDispose(() => {
		off();
		writer.destroy();
		clearTimeout(diffTimer);
		window.removeEventListener("mouseup", onUp);
		window.removeEventListener("mousemove", onGlobalMove);
	});
	window.addEventListener("mouseup", onUp);
	window.addEventListener("mousemove", onGlobalMove);

	// config edits (bytes per row, radix, base, bookmarks) re-render the grid
	effect(() => {
		[cfg().bytesPerRow, cfg().radix, cfg().base, JSON.stringify(cfg().bookmarks || [])].join("|");
		untracked(schedule);
	});

	loadOverlays();
	loadDiff();
	ctx.api("GET", "/checksums").then((c) => {
		ui.catalogue = Object.freeze(c);
	}, () => null);

	// ---- view -------------------------------------------------------------

	const grid = () => {
		gutterEl = el("canvas", { class: "hx-gutter", title: "overview: entropy / signatures | kaitai | diff, hits; click or drag to scroll",
			onmousedown: (e) => {
				ed.gutterDrag = true;
				gutterJump(e);
			} });
		rowsEl = el("div", { class: "hx-rows mono" });
		gridEl = el("div", { class: "hx-grid", tabindex: "0", onkeydown: onKey, onmousedown: onDown, onmousemove: onMove }, rowsEl);
		gridEl.addEventListener("wheel", onWheel, { passive: false });
		const observer = new ResizeObserver(schedule);
		observer.observe(gridEl);
		onDispose(() => observer.disconnect());
		schedule();
		return el("div", { class: "hx-main" }, gridEl, gutterEl);
	};

	const saveLabel = () => {
		if (ui.save === "dirty") {
			return "● unsaved";
		}
		if (ui.save === "saving") {
			return "saving…";
		}
		if (ui.save === "error") {
			return "✕ save failed";
		}
		return "✓ saved";
	};

	const setConfig = (key, value) => ctx.api("PATCH", "/panes/" + p.pane.id, { config: { [key]: value } });

	const bar = el("div", { class: "toolbar pad hx-bar" },
		el("input", { class: "hx-jump mono", placeholder: "jump: 0x1000, end-0x100, @addr", title: "offset expression (Ctrl-G): 0x/0b/0o/123/1fh, + - * / % << >> & | ^ ~, names end, cur, sel, sel_end, sel_len, base, top; @expr = address (minus base)",
			bind: [ui, "jump"], onkeydown: (e) => {
				if (e.key === "Enter") {
					jump();
				}
			} }),
		el("select", { title: "bytes per row", onchange: (e) => setConfig("bytesPerRow", Number(e.target.value)) },
			...ROW_SIZES.map((n) => el("option", { value: String(n), selected: () => bpr() === n }, n + "/row"))),
		el("select", { title: "offset column", onchange: (e) => setConfig("radix", e.target.value) },
			el("option", { value: "hex", selected: () => cfg().radix !== "dec" }, "hex"),
			el("option", { value: "dec", selected: () => cfg().radix === "dec" }, "dec")),
		el("button", { class: () => (ui.insert ? "primary" : ""), title: "insert mode (Insert key): typing inserts bytes instead of overwriting", onclick: () => {
			ui.insert = !ui.insert;
		} }, () => (ui.insert ? "INS" : "OVR")),
		iconButton("↶", "undo (Ctrl-Z)", () => writer.undo().then(schedule)),
		iconButton("↷", "redo (Ctrl-Y)", () => writer.redo().then(schedule)),
		el("span", { class: () => "hx-save " + ui.save, title: () => ui.error || "edits save automatically" }, saveLabel),
		el("button", { title: "copy the whole blob to a new name", onclick: () => saveAs(false) }, "save as"),
		el("span", { class: "hx-spacer" }),
		iconButton(() => (ui.panel ? "⇥" : "⇤"), "side panel", () => {
			ui.panel = !ui.panel;
			schedule();
		}));

	const status = el("div", { class: "hx-status mono" },
		() => {
			const len = ui.selEnd - ui.selStart + 1;
			const parts = [name + " " + (ui.size === null ? "…" : hex(ui.size) + " (" + ui.size + " B)")];
			parts.push("cur " + hex(ui.cursor) + " (" + ui.cursor + ")");
			if (len > 1) {
				parts.push("sel " + hex(ui.selStart) + "–" + hex(ui.selEnd) + " len " + hex(len) + " (" + len + ")");
			}
			if (compare) {
				parts.push("vs " + compare + (ui.sizeB === null ? "" : " " + hex(ui.sizeB)));
			}
			return parts.join(" · ");
		},
		el("span", { class: "err" }, () => (ui.jumpError || ui.error ? " " + (ui.jumpError || ui.error) : "")),
		el("span", { class: "muted" }, () => (ui.note ? " " + ui.note : "")));

	// -- side panels --

	const inspectPanel = () => el("div", { class: "hx-panel" },
		when(() => Boolean(ui.inspect), () => el("table", { class: "hx-inspect" },
			el("tr", {}, el("th", {}, "type"), el("th", {}, "LE"), el("th", {}, "BE")),
			el("tr", {}, el("td", {}, "u8"), el("td", { colspan: "2" }, el("input", { class: "mono", value: () => fmtValue(ui.inspect.values.u8),
				onchange: (e) => writeTyped("u8", e.target.value) }))),
			el("tr", {}, el("td", {}, "i8"), el("td", { colspan: "2" }, el("input", { class: "mono", value: () => fmtValue(ui.inspect.values.i8),
				onchange: (e) => writeTyped("i8", e.target.value) }))),
			...INT_TYPES.map((t) => el("tr", {}, el("td", {}, t),
				...["le", "be"].map((order) => el("td", {}, el("input", { class: "mono", value: () => fmtValue(ui.inspect.values[t + order], t),
					disabled: () => ui.inspect.values[t + order] === undefined, title: "Enter writes " + t + order + " at the cursor",
					onchange: (e) => writeTyped(t + order, e.target.value) }))))),
			el("tr", {}, el("td", {}, "bits"), el("td", { colspan: "2", class: "mono" }, () => ui.inspect.values.bits || "")),
			el("tr", {}, el("td", {}, "char"), el("td", { colspan: "2", class: "mono" },
				() => "ascii " + JSON.stringify(ui.inspect.values.ascii || "") + " · utf8 " + JSON.stringify(ui.inspect.values.utf8 || "") + " · utf16 " + JSON.stringify(ui.inspect.values.utf16le || ""))),
			el("tr", {}, el("td", {}, "time_t"), el("td", { class: "mono small" }, () => ui.inspect.values.unix32le || ""), el("td", { class: "mono small" }, () => ui.inspect.values.unix32be || "")),
			el("tr", {}, el("td", {}, "hex"), el("td", { colspan: "2", class: "mono" }, () => ui.inspect.bytes.map((b) => hex(b, 2).slice(2)).join(" "))))));

	const findPanel = () => el("div", { class: "hx-panel" },
		el("div", { class: "hx-form" },
			el("select", { bind: [ui.find, "mode"] }, el("option", { value: "hex" }, "hex (?? any)"), el("option", { value: "text" }, "text"), el("option", { value: "regex" }, "regex")),
			when(() => ui.find.mode !== "hex", () => el("select", { bind: [ui.find, "encoding"] },
				el("option", { value: "ascii" }, "ascii"), el("option", { value: "utf8" }, "utf-8"), el("option", { value: "utf16le" }, "utf-16le"))),
			el("label", { title: "ASCII case-insensitive" }, el("input", { type: "checkbox", bind: [ui.find, "ignoreCase"] }), "Aa"),
			el("label", { title: "only inside the selection" }, el("input", { type: "checkbox", bind: [ui.find, "inSel"] }), "in sel")),
		el("input", { class: "mono hx-find", placeholder: () => (ui.find.mode === "hex" ? "de ad ?? ef" : ui.find.mode === "regex" ? "\\x7fELF|U-Boot" : "text"), bind: [ui.find, "query"],
			onkeydown: (e) => {
				if (e.key === "Enter") {
					find(e.shiftKey ? "prev" : "next");
				}
			} }),
		el("div", { class: "hx-form" },
			el("button", { onclick: () => find("prev"), title: "previous (Shift-F3)" }, "◀ prev"),
			el("button", { onclick: () => find("next"), title: "next (F3)" }, "next ▶"),
			el("button", { onclick: findAll }, "all"),
			el("span", { class: "muted" }, () => ui.find.msg)),
		el("input", { class: "mono", placeholder: () => (ui.find.mode === "hex" ? "replace hex (?? keeps byte)" : "replace text"), bind: [ui.find, "replace"] }),
		el("div", { class: "hx-form" },
			el("button", { onclick: () => replace(false) }, "replace"),
			el("button", { onclick: () => replace(true) }, "replace all")),
		when(() => ui.hits.length, () => table({
			rows: () => ui.hits,
			key: (h) => h.offset,
			name: name + "_hits",
			columns: [
				{ title: "offset", mono: true, value: (h) => el("a", { href: "#", onclick: (e) => {
					e.preventDefault();
					ed.hit = h;
					selectRange(h.offset, h.offset + h.length);
				} }, hex(h.offset)), raw: (h) => h.offset },
				{ title: "len", num: true, value: (h) => h.length }
			]
		})));

	const selectPanel = () => el("div", { class: "hx-panel" },
		el("div", { class: "mono" }, () => "start " + hex(ui.selStart) + " end " + hex(ui.selEnd) + " length " + (ui.selEnd - ui.selStart + 1)),
		el("div", { class: "hx-form" }, el("span", { class: "muted" }, "copy as"),
			...bytesUtil.FORMATS.map((f) => el("button", { onclick: () => copyAs(f) }, f))),
		el("div", { class: "hx-form" },
			el("input", { class: "mono short", bind: [ui, "fill"], title: "fill pattern (hex)" }),
			el("button", { onclick: fillSelection, title: "repeat the pattern over the selection" }, "fill"),
			el("button", { onclick: deleteSelection, title: "delete the selected bytes (Delete)" }, "delete")),
		el("div", { class: "hx-form" },
			el("input", { class: "mono", bind: [ui, "insertHex"], placeholder: "hex to insert at cursor" }),
			el("button", { onclick: insertBytes }, "insert")),
		el("div", { class: "hx-form" },
			el("button", { onclick: () => saveAs(true) }, "save selection as blob"),
			el("button", { onclick: () => {
				ed.anchor = 0;
				ed.cursor = Math.max(0, size() - 1);
				schedule();
			} }, "select all")));

	const histogram = (counts) => {
		const max = Math.max(1, ...counts);
		return el("svg", { class: "hx-hist", viewBox: "0 0 256 64", preserveAspectRatio: "none" },
			...counts.map((c, i) => el("rect", { x: String(i), width: "1", y: String(64 - (c / max) * 64), height: String((c / max) * 64), fill: "var(--c1)" })));
	};

	const calcPanel = () => el("div", { class: "hx-panel" },
		el("div", { class: "hx-form" },
			el("select", { bind: [ui, "calcPreset"] }, ...Object.keys(CALC_PRESETS).map((k) => el("option", { value: k }, k))),
			el("label", {}, el("input", { type: "checkbox", bind: [ui, "calcWhole"] }), "whole blob"),
			el("button", { class: "primary", onclick: runCalc }, "run")),
		el("div", { class: "muted" }, () => (ui.calcWhole || ui.selEnd <= ui.selStart ? "over the whole blob" : "over the selection (" + (ui.selEnd - ui.selStart + 1) + " bytes)")),
		when(() => ui.calc, () => {
			const c = ui.calc;
			if (c.busy) {
				return el("div", { class: "muted" }, "computing…");
			}
			if (c.error) {
				return el("div", { class: "err" }, c.error);
			}
			const rows = Object.keys(c.results).filter((k) => k !== "histogram").map((k) => ({ name: k, value: c.results[k].hex || (c.results[k].value + " " + (c.results[k].unit || "")) }));
			return el("div", {},
				el("div", { class: "muted" }, hex(c.offset) + " + " + c.length + " bytes"),
				table({ rows: () => rows, key: (r) => r.name, name: name + "_checksums", columns: [
					{ title: "algorithm", value: (r) => r.name },
					{ title: "value", mono: true, value: (r) => el("span", { class: "hx-copyable", title: "click to copy", onclick: () => copyText(String(r.value).trim()) }, r.value) }
				] }),
				c.results.histogram ? histogram(c.results.histogram.counts) : "");
		}));

	const diffPanel = () => el("div", { class: "hx-panel" },
		when(() => compare, () => el("div", {},
			el("div", { class: "hx-form" },
				el("button", { onclick: () => jumpChange("prev") }, "◀ prev change"),
				el("button", { onclick: () => jumpChange("next") }, "next change ▶")),
			when(() => ui.diff, () => (ui.diff.error ? el("div", { class: "err" }, ui.diff.error) : el("div", {},
				el("div", {}, ui.diff.changedBytes + " bytes differ in " + ui.diff.ranges.length + (ui.diff.truncated ? "+" : "") + " ranges · sizes "
					+ hex(ui.diff.sizeA) + " / " + hex(ui.diff.sizeB)),
				table({ rows: () => ui.diff.ranges, key: (r) => r.start, name: name + "_diff", columns: [
					{ title: "start", mono: true, raw: (r) => r.start, value: (r) => el("a", { href: "#", onclick: (e) => {
						e.preventDefault();
						selectRange(r.start, r.end);
					} }, hex(r.start)) },
					{ title: "end", mono: true, raw: (r) => r.end, value: (r) => hex(r.end) },
					{ title: "len", num: true, value: (r) => r.end - r.start }
				] }))), () => el("div", { class: "muted" }, "diffing…"))),
		() => empty("set config.compare to a second blob for a side-by-side diff")));

	const jumpLink = (offset, label) => el("a", { href: "#", onclick: (e) => {
		e.preventDefault();
		moveTo(offset, false, true);
	} }, label);

	const marksPanel = () => el("div", { class: "hx-panel" },
		el("div", { class: "hx-form" },
			el("input", { bind: [ui, "markLabel"], placeholder: "label" }),
			el("button", { onclick: () => {
				saveBookmarks(bookmarks().concat([{ offset: ed.cursor, label: ui.markLabel || hex(ed.cursor) }]).sort((a, b) => toOffset(a.offset, 0) - toOffset(b.offset, 0)));
				ui.markLabel = "";
			} }, "bookmark cursor")),
		list(() => bookmarks(), (b) => b.offset + ":" + b.label, (b) => el("div", { class: "hx-mark" },
			jumpLink(toOffset(b.offset, 0), hex(toOffset(b.offset, 0))), " " + (b.label || ""),
			iconButton("×", "remove", () => saveBookmarks(bookmarks().filter((x) => x !== b && !(x.offset === b.offset && x.label === b.label)))))),
		when(() => ui.overlays && ui.overlays.signatures.length, () => el("div", {},
			el("h4", {}, "signatures"),
			list(() => ui.overlays.signatures, (s) => s.offset + s.name, (s) => el("div", { class: "hx-mark" },
				jumpLink(s.offset, hex(s.offset)), " " + s.name, el("span", { class: "muted" }, " " + (s.description || "").slice(0, 80)))))),
		when(() => ui.overlays && ui.overlays.regions.length, () => el("div", {},
			el("h4", {}, "entropy regions"),
			list(() => ui.overlays.regions, (r) => r.start + r.kind, (r) => el("div", { class: "hx-mark region " + r.kind },
				jumpLink(r.start, hex(r.start)), "–" + hex(r.end) + " " + r.kind)))),
		when(() => ui.kaitai.length, () => el("div", {},
			el("h4", {}, "kaitai"),
			list(() => ui.kaitai, (k) => k.path, (k) => el("div", { class: "hx-mark" },
				el("a", { href: "#", onclick: (e) => {
					e.preventDefault();
					selectRange(k.start, k.end);
				} }, hex(k.start)), " " + k.path + " (" + (k.end - k.start) + " B)")))),
		el("button", { onclick: loadOverlays, title: "re-run analysis (entropy, binwalk) and kaitai" }, "refresh overlays"));

	const PANELS = { inspect: inspectPanel, find: findPanel, select: selectPanel, calc: calcPanel, diff: diffPanel, marks: marksPanel };

	const side = el("div", { class: "hx-side" },
		el("div", { class: "hx-tabs" }, ...TABS.map((t) => el("button", { class: () => (ui.tab === t ? "on" : ""), onclick: () => {
			ui.tab = t;
		} }, t))),
		when(() => ui.tab, (t) => PANELS[t]()));

	const root = el("div", { class: "hexpane", onkeydown: (e) => {
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key === "g") {
			e.preventDefault();
			const input = root.querySelector(".hx-jump");
			input.focus();
			input.select();
		} else if (mod && e.key === "f") {
			e.preventDefault();
			ui.tab = "find";
			ui.panel = true;
			requestAnimationFrame(() => {
				const input = root.querySelector(".hx-find");
				if (input) {
					input.focus();
				}
			});
		}
	} },
	bar,
	el("div", { class: () => "hx-body" + (ui.panel ? "" : " nopanel") }, grid(), side),
	status);
	return root;
};

export default pane((ctx, p) => when(() => (p.pane.config.blob ? p.pane.config.blob + "\u0000" + (p.pane.config.compare || "") : ""),
	() => editor(ctx, p),
	() => empty("set config.blob (a lab blob) — and config.compare for a side-by-side diff")));
