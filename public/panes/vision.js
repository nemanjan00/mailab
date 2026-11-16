// OpenCV ROI editor: a live lab image with the regions of a vision watch drawn
// over it. Drag on the image to add a region (of the kind picked in the
// toolbar), drag a region to move it, drag its corner to resize; the table
// edits names / kinds / params and shows each region's live state and value.
// Every edit saves the watch (PUT /api/vision/watches/<name>), which the
// server evaluates on each new frame (src/vision).

import { effect, el, list, onDispose, state, untracked, when } from "@nemanjan00/qrp";
import { empty, iconButton, pane } from "../sdk/index.js";

const KINDS = ["led", "seven_seg", "value_ocr", "color", "motion", "template"];
const SAVE_DEBOUNCE_MS = 400;
const MIN_SIZE_PX = 4;
const HANDLE_PX = 10;
// default params per kind for a new region
const DEFAULT_PARAMS = { seven_seg: { count: 4 }, value_ocr: { digits: true } };

const round = (v) => Math.round(v);

const format = (r) => {
	if (!r) {
		return "";
	}
	if (r.error) {
		return "⚠ " + r.error;
	}
	const value = typeof r.value === "number" ? (Number.isInteger(r.value) ? String(r.value) : r.value.toFixed(3)) : "";
	if (r.state !== undefined && r.state !== null && String(r.state) !== value) {
		return value ? r.state + " · " + value : String(r.state);
	}
	return value;
};

export default pane((ctx, p) => {
	const v = state({
		rois: [],
		image: "",
		fps: 2,
		loaded: false,
		exists: false,
		selected: "",
		draft: null,
		kind: "led",
		results: {},
		status: "",
		error: "",
		w: 0,
		h: 0,
		src: "",
		nameDraft: ""
	});
	const watch = () => p.pane.config.watch || "";
	const showName = () => (p.pane.config.show === "annotated" && watch() ? watch() + "_annotated" : v.image);

	// ---- load / save -----------------------------------------------------

	const load = () => {
		if (!watch()) {
			v.image = p.pane.config.image || "";
			v.loaded = true;
			return;
		}
		ctx.api("GET", "/vision/watches/" + encodeURIComponent(watch())).then((w) => {
			v.rois = w.rois;
			v.image = p.pane.config.image || w.image;
			v.fps = w.fps;
			v.exists = true;
			v.results = Object.assign({}, w.last);
		}, () => {
			v.rois = [];
			v.image = p.pane.config.image || "";
			v.exists = false;
		}).then(() => {
			v.loaded = true;
			refresh();
		});
		ctx.api("GET", "/values/" + encodeURIComponent(watch() + "_vision")).then((doc) => {
			v.results = doc.value.rois || {};
		}, () => null);
	};

	let saveTimer = null;
	const save = () => {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			if (!watch() || !v.image) {
				v.status = watch() ? "pick an image" : "name the watch first";
				return;
			}
			v.status = "saving…";
			// keep what the table doesn't edit (above / below / stable / cooldownMs / notify, set by the AI)
			const rois = v.rois.map((r) => Object.assign({}, r, { rect: r.rect.map(round), params: r.params || {} }));
			ctx.api("PUT", "/vision/watches/" + encodeURIComponent(watch()), { image: v.image, fps: Number(v.fps) || 2, rois: rois }).then(() => {
				v.status = "saved";
				v.error = "";
				v.exists = true;
			}, (err) => {
				v.status = "";
				v.error = err.message;
			});
		}, SAVE_DEBOUNCE_MS);
	};
	onDispose(() => clearTimeout(saveTimer));

	const remove = () => {
		if (!watch() || !confirm("Remove vision watch " + watch() + "?")) {
			return;
		}
		ctx.api("DELETE", "/vision/watches/" + encodeURIComponent(watch())).then(() => {
			v.rois = [];
			v.exists = false;
			v.results = {};
			v.status = "removed";
		}, (err) => {
			v.error = err.message;
		});
	};

	const setWatch = () => {
		const name = v.nameDraft.trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			v.error = "watch names are letters, digits and _";
			return;
		}
		ctx.api("PATCH", "/panes/" + p.pane.id, { config: { watch: name, image: v.image } }).catch((err) => {
			v.error = err.message;
		});
	};

	// ---- live updates ------------------------------------------------------

	const refresh = () => {
		const name = showName();
		v.src = name && ctx.state.images.some((i) => i.name === name) ? "/api/images/" + encodeURIComponent(name) + "?t=" + Date.now() : "";
	};
	onDispose(ctx.on("image", (msg) => {
		if (msg.name === showName()) {
			refresh();
		}
	}));
	onDispose(ctx.on("state", refresh));
	onDispose(ctx.on("value", (msg) => {
		if (msg.value && msg.value.name === watch() + "_vision") {
			v.results = msg.value.value.rois || {};
		}
	}));

	// config edits (another watch / image) reload; raw <-> overlay just swaps the picture
	let lastConfig = "";
	effect(() => {
		const key = watch() + "|" + (p.pane.config.image || "");
		const show = p.pane.config.show;
		untracked(() => {
			if (key !== lastConfig) {
				lastConfig = key;
				load();
			} else if (show !== undefined) {
				refresh();
			}
		});
	});

	// ---- drawing -----------------------------------------------------------

	let svg = null;
	let drag = null;

	const toImage = (event) => {
		const pt = svg.createSVGPoint();
		pt.x = event.clientX;
		pt.y = event.clientY;
		const m = svg.getScreenCTM();
		const out = m ? pt.matrixTransform(m.inverse()) : pt;
		return { x: Math.max(0, Math.min(v.w, out.x)), y: Math.max(0, Math.min(v.h, out.y)) };
	};

	const nextName = () => {
		let n = v.rois.length + 1;
		const taken = (name) => v.rois.some((r) => r.name === name);
		while (taken(v.kind + n)) {
			n++;
		}
		return v.kind + n;
	};

	const roiOf = (name) => v.rois.find((r) => r.name === name);

	const down = (event, name, corner) => {
		if (!v.w || event.button !== 0) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		try {
			svg.setPointerCapture(event.pointerId);
		} catch (_err) {
			// synthetic / already released pointers can't be captured; moves still arrive over the svg
		}
		const at = toImage(event);
		if (name) {
			v.selected = name;
			drag = { mode: corner ? "resize" : "move", name: name, start: at, rect: roiOf(name).rect.slice() };
			return;
		}
		// a draft until release: adding the table row now would reflow (rescale) the image mid-drag
		v.draft = [at.x, at.y, 0, 0];
		drag = { mode: "create", start: at };
	};

	const move = (event) => {
		if (!drag) {
			return;
		}
		const at = toImage(event);
		const dx = at.x - drag.start.x;
		const dy = at.y - drag.start.y;
		if (drag.mode === "create") {
			v.draft = [Math.min(at.x, drag.start.x), Math.min(at.y, drag.start.y), Math.abs(dx), Math.abs(dy)];
			return;
		}
		const roi = roiOf(drag.name);
		if (!roi) {
			return;
		}
		const r = drag.rect;
		if (drag.mode === "move") {
			roi.rect = [Math.max(0, Math.min(v.w - r[2], r[0] + dx)), Math.max(0, Math.min(v.h - r[3], r[1] + dy)), r[2], r[3]];
		} else {
			roi.rect = [r[0], r[1], Math.max(MIN_SIZE_PX, Math.min(v.w - r[0], r[2] + dx)), Math.max(MIN_SIZE_PX, Math.min(v.h - r[1], r[3] + dy))];
		}
	};

	const up = () => {
		if (!drag) {
			return;
		}
		const created = drag.mode === "create";
		drag = null;
		if (created) {
			const rect = v.draft;
			v.draft = null;
			if (!rect || rect[2] < MIN_SIZE_PX || rect[3] < MIN_SIZE_PX) {
				return;
			}
			const roi = { name: nextName(), kind: v.kind, rect: rect, params: Object.assign({}, DEFAULT_PARAMS[v.kind] || {}) };
			v.rois = v.rois.concat([roi]);
			v.selected = roi.name;
		}
		save();
	};

	const rectOf = (name) => {
		const roi = roiOf(name);
		return roi ? roi.rect : [0, 0, 0, 0];
	};

	const handle = (name) => el("rect", {
		class: "vision-handle",
		x: () => rectOf(name)[0] + rectOf(name)[2] - HANDLE_PX * v.w / 1000,
		y: () => rectOf(name)[1] + rectOf(name)[3] - HANDLE_PX * v.w / 1000,
		width: () => HANDLE_PX * 2 * v.w / 1000,
		height: () => HANDLE_PX * 2 * v.w / 1000,
		onpointerdown: (e) => down(e, name, true)
	});

	const roiShape = (roi) => el("g", { class: () => "vision-roi" + (v.selected === roi.name ? " selected" : "") + (v.results[roi.name] && v.results[roi.name].error ? " error" : "") },
		el("rect", {
			x: () => rectOf(roi.name)[0], y: () => rectOf(roi.name)[1], width: () => rectOf(roi.name)[2], height: () => rectOf(roi.name)[3],
			"stroke-width": () => Math.max(1, v.w / 400),
			onpointerdown: (e) => down(e, roi.name, false)
		}),
		el("text", {
			x: () => rectOf(roi.name)[0] + 2,
			y: () => Math.max(v.w / 60, rectOf(roi.name)[1] - 4),
			"font-size": () => Math.max(10, v.w / 60)
		}, () => roi.name + " " + format(v.results[roi.name])),
		when(() => v.selected === roi.name, () => handle(roi.name)));

	const stage = () => {
		const img = el("img", {
			alt: "",
			src: () => v.src || null,
			onload: (e) => {
				v.w = e.target.naturalWidth;
				v.h = e.target.naturalHeight;
			}
		});
		svg = el("svg", {
			class: "vision-overlay",
			viewBox: () => "0 0 " + (v.w || 1) + " " + (v.h || 1),
			preserveAspectRatio: "xMidYMid meet",
			onpointerdown: (e) => down(e, null, false),
			onpointermove: move,
			onpointerup: up,
			onpointercancel: up
		}, list(() => v.rois, (r) => r.name, roiShape),
		when(() => Boolean(v.draft), () => el("rect", {
			class: "vision-draft",
			x: () => (v.draft ? v.draft[0] : 0), y: () => (v.draft ? v.draft[1] : 0),
			width: () => (v.draft ? v.draft[2] : 0), height: () => (v.draft ? v.draft[3] : 0),
			"stroke-width": () => Math.max(1, v.w / 400)
		})));
		return el("div", { class: () => "vision-stage" + (p.pane.config.show === "annotated" ? " annotated" : "") }, img, svg,
			when(() => !v.src, () => el("div", { class: "empty vision-hint" }, () => (v.image ? "waiting for image " + v.image : "pick an image to watch"))));
	};

	// ---- table -----------------------------------------------------------------

	const updateRoi = (name, changes) => {
		v.rois = v.rois.map((r) => (r.name === name ? Object.assign({}, r, changes) : r));
		save();
	};

	const paramsField = (roi) => el("input", {
		class: "mono vision-params",
		value: JSON.stringify(roi.params || {}),
		title: "params (JSON), e.g. {\"count\": 4} for seven_seg, {\"threshold\": 160} for led, {\"template\": \"icon\"}",
		onchange: (e) => {
			try {
				updateRoi(roi.name, { params: JSON.parse(e.target.value || "{}") });
				v.error = "";
			} catch (err) {
				v.error = "params: " + err.message;
			}
		}
	});

	const row = (roi) => el("tr", { class: () => (v.selected === roi.name ? "selected" : ""), onclick: () => {
		v.selected = roi.name;
	} },
	el("td", { class: "mono" }, el("input", {
		class: "vision-name",
		value: roi.name,
		onchange: (e) => {
			const name = e.target.value.trim();
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !roiOf(name)) {
				v.selected = name;
				updateRoi(roi.name, { name: name });
			} else {
				e.target.value = roi.name;
			}
		}
	})),
	el("td", {}, el("select", {
		value: roi.kind,
		onchange: (e) => updateRoi(roi.name, { kind: e.target.value, params: Object.assign({}, DEFAULT_PARAMS[e.target.value] || {}) })
	}, ...KINDS.map((k) => el("option", { value: k, selected: k === roi.kind }, k)))),
	el("td", {}, paramsField(roi)),
	el("td", { class: "mono num" }, () => format(v.results[roi.name])),
	el("td", { class: "mono muted" }, () => (watch() ? watch() + "_" + roi.name : "")),
	el("td", {}, iconButton("✕", "remove region", (e) => {
		e.stopPropagation();
		v.rois = v.rois.filter((r) => r.name !== roi.name);
		save();
	})));

	const table = () => el("div", { class: "vision-table" },
		when(() => v.rois.length > 0, () => el("table", {},
			el("thead", {}, el("tr", {}, el("th", {}, "roi"), el("th", {}, "kind"), el("th", {}, "params"), el("th", {}, "live"), el("th", {}, "channel"), el("th", {}))),
			el("tbody", {}, list(() => v.rois, (r) => r.name + "|" + r.kind + "|" + JSON.stringify(r.params || {}), row))),
		() => el("div", { class: "muted pad" }, "drag on the image to add a region")));

	// ---- toolbar -------------------------------------------------------------------

	const imageSelect = () => el("select", {
		title: "image to watch",
		onchange: (e) => {
			v.image = e.target.value;
			refresh();
			save();
		}
	}, el("option", { value: "" }, "image…"),
	list(() => ctx.state.images.filter((i) => !/_annotated$/.test(i.name) || i.name === v.image), (i) => i.name,
		(i) => el("option", { value: i.name, selected: () => i.name === v.image }, i.name)));

	const toolbar = () => el("div", { class: "toolbar pad vision-toolbar" },
		when(() => Boolean(watch()), () => el("b", { class: "mono" }, watch),
			() => el("span", {}, el("input", { placeholder: "watch name", bind: [v, "nameDraft"], size: 10 }), el("button", { onclick: setWatch }, "use"))),
		imageSelect(),
		el("label", { class: "muted", title: "kind of new regions" }, "new ", el("select", { bind: [v, "kind"] }, ...KINDS.map((k) => el("option", { value: k }, k)))),
		el("label", { class: "muted", title: "evaluation rate cap" }, "fps ", el("input", { type: "number", min: 0.1, max: 30, step: 0.5, bind: [v, "fps"], onchange: save, style: "width: 4em" })),
		el("button", {
			title: "show the server's overlay image",
			class: () => (p.pane.config.show === "annotated" ? "primary" : ""),
			onclick: () => ctx.api("PATCH", "/panes/" + p.pane.id, { config: { show: p.pane.config.show === "annotated" ? "" : "annotated" } })
		}, "overlay"),
		el("span", { class: "muted" }, () => v.status),
		el("span", { class: "error" }, () => v.error),
		el("span", { style: "flex: 1" }),
		when(() => v.exists, () => iconButton("🗑", "remove this watch", remove)));

	return when(() => v.loaded, () => el("div", { class: "vision" }, toolbar(), stage(), table()), () => empty("loading…"));
});
