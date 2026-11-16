// Board tracing: PDF pages / photos as background layers, traced components,
// pins, wires (copper / schematic lines), vias, net labels and test points
// drawn over them. The server derives nets from the drawn geometry; this pane
// shows them on the board and as an auto-laid-out schematic graph, with
// cross-probing (select a pin / wire / part / net in one view, it lights up in
// the other).

import { el, list, onDispose, state, when } from "@nemanjan00/qrp";
import { pane, widget } from "../sdk/index.js";
import affine from "../../src/utils/affine/index.js";

const SNAP_PX = 10;
const HIT_PX = 6;
const ZOOM_STEP = 1.15;
const DRAG_PX = 4;
const POWER_FANOUT = 8;
const POWER_RE = /^(a|d|p)?(gnd|vcc|vdd|vss|vee|vbat|v\+|\+?\d+(\.\d+)?v\d*)/i;
const LAYOUT_ITERATIONS = 250;
const SIDE_COLORS = { top: "#ff5555", bottom: "#8be9fd" };
const OTHER_COLOR = "#bd93f9";
const LIT = "#ff3df0";
const HIT_COLOR = "#f1fa8c";
const TOOLS = [
	["select", "⬚", "select / pan (click a pin or wire to light its net)"],
	["wire", "╱", "wire: click points, double-click / Enter to finish, Esc cancels"],
	["component", "▭", "component: drag a box"],
	["pin", "•", "pin: click inside / next to a component"],
	["via", "◎", "via (joins all sides)"],
	["label", "⚑", "net label: names the net it touches"],
	["testpoint", "◇", "test point (optionally linked to a lab channel)"],
	["note", "✎", "note"]
];

const enc = encodeURIComponent;
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const byNatural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

// pins auto-placed in a freshly drawn box: 2 = ends of the long axis, more = dual row (DIP/SOIC numbering)
const autoPins = (box, count) => {
	const x = box[0];
	const y = box[1];
	const w = box[2];
	const h = box[3];
	if (count === 1) {
		return [{ name: "1", x: x + w / 2, y: y + h / 2 }];
	}
	if (count === 2) {
		return w >= h ? [{ name: "1", x: x, y: y + h / 2 }, { name: "2", x: x + w, y: y + h / 2 }]
			: [{ name: "1", x: x + w / 2, y: y }, { name: "2", x: x + w / 2, y: y + h }];
	}
	const half = Math.ceil(count / 2);
	const vertical = h >= w;
	return Array.from({ length: count }, (_, i) => {
		const row = i < half ? i : count - 1 - i;
		const t = (row + 0.5) / half;
		const first = i < half;
		if (vertical) {
			return { name: String(i + 1), x: first ? x : x + w, y: y + t * h };
		}
		return { name: String(i + 1), x: x + t * w, y: first ? y + h : y };
	});
};

const distToSegment = (p, a, b) => {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
	const q = [a[0] + t * dx, a[1] + t * dy];
	return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), at: q };
};

// ---- derived indexes ----------------------------------------------------------

const indexBoard = (b) => {
	const netOfPin = {};
	const netOfWire = {};
	const netOfItem = {};
	const nets = (b.netlist && b.netlist.nets) || [];
	nets.forEach((n) => {
		n.pins.forEach((p) => {
			netOfPin[p] = n.name;
		});
		n.wires.forEach((w) => {
			netOfWire[w] = n.name;
		});
		n.vias.concat(n.testpoints, n.labels).forEach((id) => {
			netOfItem[id] = n.name;
		});
	});
	return { nets: nets, netOfPin: netOfPin, netOfWire: netOfWire, netOfItem: netOfItem };
};

// ---- schematic-style graph layout ---------------------------------------------

const isPower = (net) => net.pins.length >= POWER_FANOUT || POWER_RE.test(net.name);

const layoutGraph = (b, idx) => {
	const comps = b.components;
	const n = comps.length;
	const k = 140;
	// start from the board positions, so the graph resembles the board
	const centers = comps.map((c, i) => {
		if (c.box) {
			return [c.box[0] + c.box[2] / 2, c.box[1] + c.box[3] / 2];
		}
		if (c.pins.length) {
			return [c.pins.reduce((s, p) => s + p.x, 0) / c.pins.length, c.pins.reduce((s, p) => s + p.y, 0) / c.pins.length];
		}
		return [i * 37 % 500, i * 91 % 500];
	});
	const xs = centers.map((c) => c[0]);
	const ys = centers.map((c) => c[1]);
	const span = Math.max(1, Math.max.apply(null, xs.concat([1])) - Math.min.apply(null, xs.concat([0])), Math.max.apply(null, ys.concat([1])) - Math.min.apply(null, ys.concat([0])));
	const scale = (k * Math.sqrt(Math.max(n, 1)) * 1.5) / span;
	const pos = centers.map((c, i) => [c[0] * scale + (i % 7) * 0.01, c[1] * scale + (i % 5) * 0.01]);
	const refIndex = {};
	comps.forEach((c, i) => {
		refIndex[c.id] = i;
	});
	// springs between parts sharing a signal net
	const springs = [];
	idx.nets.filter((net) => !isPower(net)).forEach((net) => {
		const members = Array.from(new Set(net.pins.map((p) => refIndex[p.slice(0, p.lastIndexOf("."))]).filter((i) => i !== undefined)));
		members.slice(1).forEach((m) => springs.push([members[0], m]));
		if (members.length > 2) {
			members.slice(2).forEach((m, j) => springs.push([members[j + 1], m]));
		}
	});
	const iterations = n > 400 ? 60 : LAYOUT_ITERATIONS;
	for (let it = 0; it < iterations; it++) {
		const temp = k * (1 - it / iterations) * 0.5 + 1;
		const disp = pos.map(() => [0, 0]);
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const dx = pos[i][0] - pos[j][0];
				const dy = pos[i][1] - pos[j][1];
				const d = Math.max(1, Math.hypot(dx, dy));
				const f = (k * k) / d / d;
				disp[i][0] += dx * f;
				disp[i][1] += dy * f;
				disp[j][0] -= dx * f;
				disp[j][1] -= dy * f;
			}
		}
		springs.forEach((s) => {
			const dx = pos[s[0]][0] - pos[s[1]][0];
			const dy = pos[s[0]][1] - pos[s[1]][1];
			const d = Math.max(1, Math.hypot(dx, dy));
			const f = d / k;
			disp[s[0]][0] -= dx * f;
			disp[s[0]][1] -= dy * f;
			disp[s[1]][0] += dx * f;
			disp[s[1]][1] += dy * f;
		});
		// gravity keeps unconnected parts from drifting off
		const cx = pos.reduce((s, q) => s + q[0], 0) / Math.max(n, 1);
		const cy = pos.reduce((s, q) => s + q[1], 0) / Math.max(n, 1);
		pos.forEach((q, i) => {
			const d = Math.hypot(q[0] - cx, q[1] - cy) / k;
			disp[i][0] -= (q[0] - cx) * d * 0.3;
			disp[i][1] -= (q[1] - cy) * d * 0.3;
		});
		pos.forEach((p, i) => {
			const d = Math.max(1e-6, Math.hypot(disp[i][0], disp[i][1]));
			const step = Math.min(d, temp);
			p[0] += disp[i][0] / d * step;
			p[1] += disp[i][1] / d * step;
		});
	}
	// boxes with pin stubs: first half of the pins on the left, the rest on the right
	const nodes = comps.map((c, i) => {
		const pins = c.pins.slice().sort((a, b2) => byNatural(a.name, b2.name));
		const half = pins.length <= 2 ? 1 : Math.ceil(pins.length / 2);
		const rows = Math.max(1, half, pins.length - half);
		const w = 70;
		const h = rows * 14 + 30;
		const x = Math.round(pos[i][0] - w / 2);
		const y = Math.round(pos[i][1] - h / 2);
		const stubs = pins.map((p, j) => {
			const left = j < half;
			const row = left ? j : j - half;
			const py = y + 30 + row * 14 + 3;
			return { key: c.id + "." + p.name, name: p.name, x: left ? x - 12 : x + w + 12, y: py, ax: left ? x : x + w, left: left };
		});
		return { ref: c.id, value: c.value || "", x: x, y: y, w: w, h: h, pins: stubs };
	});
	const pinAt = {};
	nodes.forEach((node) => node.pins.forEach((p) => {
		pinAt[p.key] = p;
	}));
	const edges = idx.nets.map((net) => {
		const pts = net.pins.map((p) => pinAt[p]).filter(Boolean);
		const power = isPower(net);
		const hub = pts.length ? [pts.reduce((s, p) => s + p.x, 0) / pts.length, pts.reduce((s, p) => s + p.y, 0) / pts.length] : [0, 0];
		return { net: net.name, pins: pts, hub: hub, power: power };
	});
	return { nodes: nodes, edges: edges };
};

// ---- pan / zoom / pinch camera ----------------------------------------------------

const camera = (onChange) => {
	// touched: the user zoomed / panned, so stop auto-fitting on resize
	const cam = { s: 1, tx: 0, ty: 0, touched: false };
	return {
		cam: cam,
		toBoard: (sx, sy) => [(sx - cam.tx) / cam.s, (sy - cam.ty) / cam.s],
		toScreen: (p) => [p[0] * cam.s + cam.tx, p[1] * cam.s + cam.ty],
		zoomAt: (sx, sy, factor) => {
			cam.touched = true;
			const s = Math.max(1e-3, Math.min(200, cam.s * factor));
			cam.tx = sx - (sx - cam.tx) * (s / cam.s);
			cam.ty = sy - (sy - cam.ty) * (s / cam.s);
			cam.s = s;
			onChange();
		},
		panBy: (dx, dy) => {
			cam.touched = true;
			cam.tx += dx;
			cam.ty += dy;
			onChange();
		},
		fit: (box, w, h) => {
			if (!box || !box.w || !box.h || !w || !h) {
				return;
			}
			cam.s = Math.min(w / box.w, h / box.h) * 0.92;
			cam.tx = w / 2 - (box.x + box.w / 2) * cam.s;
			cam.ty = h / 2 - (box.y + box.h / 2) * cam.s;
			onChange();
		}
	};
};

/**
 * Canvas with wheel zoom, drag pan, touch pinch; `handlers` get board coords.
 * @param {HTMLElement} host
 * @param {{draw: function, down: function, move: function, up: function, dbl: function, key: function, panButton: function}} handlers
 */
const viewport = (host, handlers) => {
	const canvas = document.createElement("canvas");
	canvas.className = "full";
	canvas.tabIndex = 0;
	host.style.position = "relative";
	host.append(canvas);
	const g = canvas.getContext("2d");
	let frame = 0;
	const redraw = () => {
		if (!frame) {
			frame = requestAnimationFrame(() => {
				frame = 0;
				const dpr = window.devicePixelRatio || 1;
				const w = host.clientWidth;
				const h = host.clientHeight;
				if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
					canvas.width = Math.round(w * dpr);
					canvas.height = Math.round(h * dpr);
					canvas.style.width = w + "px";
					canvas.style.height = h + "px";
				}
				g.setTransform(dpr, 0, 0, dpr, 0, 0);
				g.clearRect(0, 0, w, h);
				handlers.draw(g, cam, w, h);
			});
		}
	};
	const cam = camera(redraw);
	const pointers = new Map();
	let drag = null;
	let pinch = null;
	const local = (e) => {
		const r = canvas.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	};
	canvas.addEventListener("wheel", (e) => {
		e.preventDefault();
		const p = local(e);
		cam.zoomAt(p[0], p[1], e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
	}, { passive: false });
	canvas.addEventListener("pointerdown", (e) => {
		canvas.focus();
		try {
			canvas.setPointerCapture(e.pointerId);
		} catch (_err) {
			// synthetic events (tests, automation) have no active pointer
		}
		pointers.set(e.pointerId, local(e));
		if (pointers.size === 2) {
			const pts = Array.from(pointers.values());
			pinch = { d: Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]), c: [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] };
			drag = null;
			return;
		}
		const p = local(e);
		const pan = e.button === 1 || e.button === 2 || handlers.panButton(e);
		drag = { start: p, last: p, moved: false, pan: pan, button: e.button };
		if (!pan && e.button === 0) {
			handlers.down(cam.toBoard(p[0], p[1]), e);
		}
	});
	canvas.addEventListener("pointermove", (e) => {
		const p = local(e);
		if (pointers.has(e.pointerId)) {
			pointers.set(e.pointerId, p);
		}
		if (pinch && pointers.size === 2) {
			const pts = Array.from(pointers.values());
			const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
			const c = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
			cam.panBy(c[0] - pinch.c[0], c[1] - pinch.c[1]);
			cam.zoomAt(c[0], c[1], d / Math.max(1, pinch.d));
			pinch = { d: d, c: c };
			return;
		}
		if (drag) {
			if (Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) > DRAG_PX) {
				drag.moved = true;
			}
			// handlers.move returns true when it consumes the drag (box drawing)
			const consumed = !drag.pan && handlers.move(cam.toBoard(p[0], p[1]), e, true);
			if (!consumed && drag.moved) {
				cam.panBy(p[0] - drag.last[0], p[1] - drag.last[1]);
			}
			drag.last = p;
			return;
		}
		handlers.move(cam.toBoard(p[0], p[1]), e, false);
	});
	const end = (e) => {
		pointers.delete(e.pointerId);
		if (pointers.size < 2) {
			pinch = null;
		}
		if (drag && e.type === "pointerup" && !drag.pan && drag.button === 0) {
			const p = local(e);
			handlers.up(cam.toBoard(p[0], p[1]), e, drag.moved);
		}
		drag = null;
	};
	canvas.addEventListener("pointerup", end);
	canvas.addEventListener("pointercancel", end);
	canvas.addEventListener("dblclick", (e) => {
		const p = local(e);
		handlers.dbl(cam.toBoard(p[0], p[1]), e);
	});
	canvas.addEventListener("contextmenu", (e) => e.preventDefault());
	canvas.addEventListener("keydown", (e) => handlers.key(e));
	return { canvas: canvas, cam: cam, redraw: redraw, size: () => [host.clientWidth, host.clientHeight] };
};

// ---- pane -------------------------------------------------------------------------

export default pane((ctx, p) => {
	const view = state({
		boards: [], board: null, tool: "select", side: "", status: "", error: "",
		sel: null, net: "", query: "", hits: null, tab: "parts", filter: "", sort: "name", alignLayer: "", alignPairs: 0,
		mode: p.pane.config.view || "split", rev: 0
	});
	const name = () => p.pane.config.board;
	let board = null;
	let idx = indexBoard({ netlist: { nets: [] } });
	let graphLayout = null;
	const images = {};
	let draft = null;
	let snapMark = null;
	let hover = null;
	let pcb = null;
	let sch = null;
	let fitted = false;
	let align = null;

	const redrawAll = () => {
		if (pcb) {
			pcb.redraw();
		}
		if (sch) {
			sch.redraw();
		}
	};

	const api = (method, path, body) => ctx.api(method, "/boards/" + enc(name()) + path, body);
	const draw = (ops) => api("POST", "/draw", { ops: ops }).then((r) => {
		view.error = "";
		return r;
	}, (err) => {
		view.error = err.message;
		throw err;
	});

	const loadList = () => ctx.api("GET", "/boards").then((list) => {
		view.boards = Object.freeze(list);
	}, () => null);

	const load = () => {
		if (!name()) {
			loadList();
			return;
		}
		api("GET", "").then((b) => {
			board = b;
			idx = indexBoard(b);
			graphLayout = null;
			b.layers.forEach((l) => {
				const key = l.id + ":" + l.file;
				if (!images[key]) {
					const img = new Image();
					img.onload = redrawAll;
					img.src = "/api/boards/" + enc(b.name) + "/layers/" + enc(l.id) + "/image";
					images[key] = img;
				}
			});
			view.board = Object.freeze({ name: b.name, title: b.title, layers: b.layers, components: b.components, nets: idx.nets, unconnected: b.netlist.unconnected });
			view.error = "";
			ensureFit();
			redrawAll();
		}, (err) => {
			view.error = err.message;
		});
	};

	const off = ctx.on("board", (msg) => {
		if (msg.name === name()) {
			load();
		} else {
			loadList();
		}
	});
	// test points linked to lab channels show live readings
	const ticker = setInterval(() => {
		if (pcb && board && board.testpoints.some((t) => t.channel)) {
			pcb.redraw();
		}
	}, 1000);
	onDispose(() => {
		off();
		clearInterval(ticker);
	});
	load();
	loadList();

	// ---- geometry helpers --------------------------------------------------------------

	const boardBounds = () => {
		if (!board) {
			return null;
		}
		const boxes = board.layers.filter((l) => l.visible).map((l) => affine.boundsOf(l.matrix, { x: 0, y: 0, w: l.width, h: l.height }));
		board.components.forEach((c) => c.box && boxes.push({ x: c.box[0], y: c.box[1], w: c.box[2], h: c.box[3] }));
		board.wires.forEach((w) => w.points.forEach((pt) => boxes.push({ x: pt[0], y: pt[1], w: 0, h: 0 })));
		if (!boxes.length) {
			return { x: 0, y: 0, w: 1000, h: 1000 };
		}
		const x0 = Math.min.apply(null, boxes.map((b) => b.x));
		const y0 = Math.min.apply(null, boxes.map((b) => b.y));
		const x1 = Math.max.apply(null, boxes.map((b) => b.x + b.w));
		const y1 = Math.max.apply(null, boxes.map((b) => b.y + b.h));
		return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
	};

	const fitBoard = () => {
		if (pcb) {
			const s = pcb.size();
			pcb.cam.fit(boardBounds(), s[0], s[1]);
		}
	};

	// fit once per opened board, as soon as both the board and a sized canvas exist
	const ensureFit = () => {
		if (fitted || !pcb || !board) {
			return;
		}
		const s = pcb.size();
		if (s[0] > 0 && s[1] > 0) {
			fitted = true;
			fitBoard();
		}
	};

	const centerOn = (box) => {
		if (!pcb) {
			return;
		}
		const s = pcb.size();
		pcb.cam.cam.touched = true;
		const pad = Math.max(box.w, box.h, 40 / pcb.cam.cam.s) * 3;
		pcb.cam.fit({ x: box.x + box.w / 2 - pad / 2, y: box.y + box.h / 2 - pad / 2, w: pad, h: pad }, s[0], s[1]);
	};

	const sideMeets = (a) => !view.side || !a || a === view.side;

	// nearest connectable point within SNAP_PX: pins, vertices, vias, labels, test points; then segments
	const snap = (pt) => {
		if (!board) {
			return { at: pt };
		}
		const r = SNAP_PX / pcb.cam.cam.s;
		let best = null;
		const consider = (q, what) => {
			const d = Math.hypot(q[0] - pt[0], q[1] - pt[1]);
			if (d <= r && (!best || d < best.d)) {
				best = { d: d, at: [q[0], q[1]], what: what };
			}
		};
		board.components.forEach((c) => sideMeets(c.side) && c.pins.forEach((pin) => consider([pin.x, pin.y], "pin " + c.id + "." + pin.name)));
		board.wires.forEach((w) => sideMeets(w.side) && w.points.forEach((q) => consider(q, "wire " + w.id)));
		board.vias.forEach((v) => consider([v.x, v.y], "via " + v.id));
		board.labels.forEach((l) => consider([l.x, l.y], "label " + l.name));
		board.testpoints.forEach((t) => consider([t.x, t.y], "testpoint " + t.id));
		if (draft && draft.kind === "wire") {
			draft.points.slice(0, -1).forEach((q) => consider(q, "own vertex"));
		}
		if (best) {
			return best;
		}
		board.wires.forEach((w) => {
			if (!sideMeets(w.side)) {
				return;
			}
			w.points.slice(1).forEach((b, i) => {
				const s = distToSegment(pt, w.points[i], b);
				if (s.d <= r && (!best || s.d < best.d)) {
					best = { d: s.d, at: s.at, what: "on wire " + w.id };
				}
			});
		});
		return best || { at: pt };
	};

	// what's under the cursor (for select)
	const hitTest = (pt) => {
		if (!board) {
			return null;
		}
		const r = HIT_PX / pcb.cam.cam.s;
		let best = null;
		const consider = (d, item) => {
			if (d <= r && (!best || d < best.d)) {
				best = Object.assign({ d: d }, item);
			}
		};
		board.components.forEach((c) => c.pins.forEach((pin) => consider(Math.hypot(pin.x - pt[0], pin.y - pt[1]), { kind: "pin", id: c.id + "." + pin.name, ref: c.id, net: idx.netOfPin[c.id + "." + pin.name] })));
		board.vias.forEach((v) => consider(Math.hypot(v.x - pt[0], v.y - pt[1]), { kind: "via", id: v.id, net: idx.netOfItem[v.id] }));
		board.testpoints.forEach((t) => consider(Math.hypot(t.x - pt[0], t.y - pt[1]), { kind: "testpoint", id: t.id, net: idx.netOfItem[t.id] }));
		board.labels.forEach((l) => consider(Math.hypot(l.x - pt[0], l.y - pt[1]), { kind: "label", id: l.id, net: idx.netOfItem[l.id] }));
		board.notes.forEach((n) => consider(Math.hypot(n.x - pt[0], n.y - pt[1]), { kind: "note", id: n.id }));
		if (best) {
			return best;
		}
		board.wires.forEach((w) => w.points.slice(1).forEach((b, i) => consider(distToSegment(pt, w.points[i], b).d, { kind: "wire", id: w.id, net: idx.netOfWire[w.id] })));
		if (best) {
			return best;
		}
		const comp = board.components.find((c) => c.box && pt[0] >= c.box[0] && pt[0] <= c.box[0] + c.box[2] && pt[1] >= c.box[1] && pt[1] <= c.box[1] + c.box[3]);
		if (comp) {
			return { kind: "component", id: comp.id, ref: comp.id };
		}
		const word = wordAt(pt);
		return word ? { kind: "word", text: word.text, box: word } : null;
	};

	// words only move when layers change, not on every traced edit
	let wordsLoaded = null;
	let layerWords = [];
	const loadWords = () => {
		const key = board && board.name + ":" + board.layers.map((l) => l.id + l.matrix.join(",")).join(";");
		if (!board || wordsLoaded === key) {
			return;
		}
		wordsLoaded = key;
		api("GET", "/text?limit=200000").then((words) => {
			layerWords = words;
		}, () => null);
	};
	const wordAt = (pt) => layerWords.find((w) => pt[0] >= w.x && pt[0] <= w.x + w.w && pt[1] >= w.y && pt[1] <= w.y + w.h);

	const select = (item) => {
		view.sel = item ? Object.freeze(Object.assign({}, item)) : null;
		view.net = (item && item.net) || "";
		redrawAll();
	};

	const runSearch = (q) => {
		view.query = q;
		if (!q || !name()) {
			view.hits = null;
			redrawAll();
			return;
		}
		api("GET", "/search?q=" + enc(q)).then((r) => {
			view.hits = Object.freeze(r);
			view.tab = "hits";
			redrawAll();
		}, (err) => {
			view.error = err.message;
		});
	};

	const ask = (title, fields) => ctx.dialog(title, fields).then((v) => {
		if (!v) {
			throw new Error("cancelled");
		}
		return v;
	});

	// ---- tools ---------------------------------------------------------------------------

	const nearestComponent = (pt) => {
		const inside = board.components.find((c) => c.box && pt[0] >= c.box[0] - 2 && pt[0] <= c.box[0] + c.box[2] + 2 && pt[1] >= c.box[1] - 2 && pt[1] <= c.box[1] + c.box[3] + 2);
		if (inside) {
			return inside;
		}
		const dist = (c) => (c.box ? Math.hypot(c.box[0] + c.box[2] / 2 - pt[0], c.box[1] + c.box[3] / 2 - pt[1]) : Infinity);
		return board.components.slice().sort((a, b) => dist(a) - dist(b))[0];
	};

	const sideArg = () => (view.side ? { side: view.side } : {});

	const finishWire = () => {
		if (!draft || draft.kind !== "wire") {
			return;
		}
		// a double-click also delivers two clicks: drop repeated points
		const pts = draft.points.slice(0, -1).filter((q, i, all) => i === 0 || q[0] !== all[i - 1][0] || q[1] !== all[i - 1][1]);
		draft = null;
		if (pts.length >= 2) {
			draw([Object.assign({ op: "add", kind: "wire", points: pts }, sideArg())]).catch(() => null);
		}
		redrawAll();
	};

	const place = (pt) => {
		const at = snap(pt).at;
		const tool = view.tool;
		if (tool === "wire") {
			if (!draft) {
				draft = { kind: "wire", points: [at, at] };
			} else {
				draft.points[draft.points.length - 1] = at;
				draft.points.push(at);
			}
			redrawAll();
			return;
		}
		if (tool === "via") {
			draw([{ op: "add", kind: "via", x: at[0], y: at[1] }]).catch(() => null);
		} else if (tool === "pin") {
			const comp = nearestComponent(at);
			if (!comp) {
				view.error = "draw a component first";
				return;
			}
			const used = comp.pins.map((x) => Number(x.name)).filter(Number.isFinite);
			ask("Pin on " + comp.id, [{ name: "name", label: "pin", value: String(used.length ? Math.max.apply(null, used) + 1 : 1) }])
				.then((v) => draw([{ op: "add", kind: "pin", component: comp.id, name: v.name.trim(), x: at[0], y: at[1] }])).catch(() => null);
		} else if (tool === "label") {
			ask("Net label", [{ name: "name", label: "net name" }])
				.then((v) => draw([Object.assign({ op: "add", kind: "label", x: at[0], y: at[1], name: v.name.trim() }, sideArg())])).catch(() => null);
		} else if (tool === "testpoint") {
			ask("Test point", [{ name: "id", label: "name (blank = auto)" }, { name: "channel", label: "lab channel measuring it (optional)" }])
				.then((v) => draw([Object.assign({ op: "add", kind: "testpoint", x: at[0], y: at[1] }, v.id.trim() ? { id: v.id.trim() } : {},
					v.channel.trim() ? { channel: v.channel.trim() } : {}, sideArg())])).catch(() => null);
		} else if (tool === "note") {
			ask("Note", [{ name: "text", type: "textarea" }])
				.then((v) => draw([{ op: "add", kind: "note", x: at[0], y: at[1], text: v.text }])).catch(() => null);
		}
	};

	const finishComponent = (box) => {
		// refdes guess: a refdes-looking word centred in the box, else the nearest one around it
		const cx = box[0] + box[2] / 2;
		const cy = box[1] + box[3] / 2;
		const reach = Math.max(box[2], box[3]);
		const refLike = layerWords.filter((w) => /^[A-Z]{1,3}\d+[A-Z]?$/.test(w.text))
			.map((w) => ({ text: w.text, d: Math.hypot(w.x + w.w / 2 - cx, w.y + w.h / 2 - cy) }))
			.filter((w) => w.d <= reach)
			.sort((a, b) => a.d - b.d);
		const guess = refLike.length ? refLike[0].text : "";
		ask("Component", [
			{ name: "id", label: "refdes", value: guess },
			{ name: "value", label: "value" },
			{ name: "footprint", label: "footprint" },
			{ name: "pins", label: "pins to place now (2 = ends, more = dual row; blank = none)", value: "2" }
		]).then((v) => {
			const count = Math.max(0, Math.min(256, Number(v.pins) || 0));
			return draw([Object.assign({
				op: "add", kind: "component", id: v.id.trim(), value: v.value, footprint: v.footprint, box: box, pins: autoPins(box, count)
			}, sideArg())]);
		}).catch(() => null);
	};

	const removeSelected = () => {
		const s = view.sel;
		if (!s || !name()) {
			return;
		}
		let op;
		if (s.kind === "pin") {
			op = { op: "remove", kind: "pin", component: s.ref, name: s.id.slice(s.ref.length + 1) };
		} else if (["component", "wire", "via", "label", "testpoint", "note"].indexOf(s.kind) !== -1) {
			op = { op: "remove", kind: s.kind, id: s.id };
		}
		if (op) {
			draw([op]).then(() => select(null), () => null);
		}
	};

	// alignment: click a point on the moving layer, then where it belongs; 2 pairs = similarity, 3 = affine
	const startAlign = (layer) => {
		align = { layer: layer.id, pairs: [], from: null };
		view.alignLayer = layer.id;
		view.alignPairs = 0;
		view.tool = "align";
		view.status = "align " + layer.name + ": click a feature on this layer";
	};
	const alignClick = (pt) => {
		const layer = board.layers.find((l) => l.id === align.layer);
		if (!align.from) {
			align.from = affine.apply(affine.invert(layer.matrix), pt);
			align.fromBoard = pt;
			view.status = "now click where that point belongs (on the reference)";
		} else {
			align.pairs.push({ from: align.from, to: snap(pt).at, fromBoard: align.fromBoard });
			align.from = null;
			view.alignPairs = align.pairs.length;
			view.status = align.pairs.length + " pair(s): " + (align.pairs.length >= 2 ? "apply, or add a 3rd for a full affine fit" : "click the next feature on the layer");
			if (align.pairs.length === 3) {
				applyAlign(false);
			}
		}
		redrawAll();
	};
	const applyAlign = (flip) => {
		if (!align || align.pairs.length < 2) {
			return;
		}
		api("POST", "/layers/" + enc(align.layer) + "/align", { pairs: align.pairs.map((x) => ({ from: x.from, to: x.to })), flip: flip }).then(() => {
			cancelAlign();
		}, (err) => {
			view.error = err.message;
		});
	};
	const cancelAlign = () => {
		align = null;
		view.alignLayer = "";
		view.alignPairs = 0;
		view.tool = "select";
		view.status = "";
		redrawAll();
	};

	// mirror / rotate a layer about its centre (board coords)
	const transformLayer = (layer, m) => {
		const b = affine.boundsOf(layer.matrix, { x: 0, y: 0, w: layer.width, h: layer.height });
		const c = [b.x + b.w / 2, b.y + b.h / 2];
		const about = affine.multiply([1, 0, 0, 1, c[0], c[1]], affine.multiply(m, [1, 0, 0, 1, -c[0], -c[1]]));
		api("PATCH", "/layers/" + enc(layer.id), { matrix: affine.multiply(about, layer.matrix) }).catch((err) => {
			view.error = err.message;
		});
	};

	// ---- board view drawing ------------------------------------------------------------

	const netColor = (net, fallback) => {
		const meta = net && board.nets && board.nets[net];
		return (meta && meta.color) || fallback;
	};

	const drawPcb = (g, cam, w, h) => {
		const c = cam.cam;
		const dpr = window.devicePixelRatio || 1;
		g.fillStyle = cssVar("--bg") || "#111";
		g.fillRect(0, 0, w, h);
		if (!board) {
			return;
		}
		board.layers.forEach((l) => {
			const img = images[l.id + ":" + l.file];
			if (!l.visible || !img || !img.complete || !img.naturalWidth) {
				return;
			}
			const m = affine.multiply([c.s, 0, 0, c.s, c.tx, c.ty], l.matrix);
			g.save();
			g.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
			g.globalAlpha = l.opacity;
			g.imageSmoothingEnabled = c.s < 2;
			g.drawImage(img, 0, 0, l.width, l.height);
			g.restore();
		});
		g.save();
		g.setTransform(dpr * c.s, 0, 0, dpr * c.s, dpr * c.tx, dpr * c.ty);
		const px = 1 / c.s;
		const lit = view.net;
		const dim = (net) => lit && net !== lit;
		// search hits
		if (view.hits) {
			g.strokeStyle = HIT_COLOR;
			g.lineWidth = 2 * px;
			view.hits.text.forEach((t) => g.strokeRect(t.x - 2 * px, t.y - 2 * px, t.w + 4 * px, t.h + 4 * px));
		}
		// wires
		g.lineCap = "round";
		g.lineJoin = "round";
		board.wires.forEach((wire) => {
			const net = idx.netOfWire[wire.id];
			const on = lit && net === lit;
			g.globalAlpha = dim(net) ? 0.35 : 0.9;
			g.strokeStyle = on ? LIT : netColor(net, SIDE_COLORS[wire.side] || OTHER_COLOR);
			g.lineWidth = Math.max((wire.width || 0), (on ? 4 : 2.5) * px);
			g.beginPath();
			wire.points.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])));
			g.stroke();
			if (view.sel && view.sel.kind === "wire" && view.sel.id === wire.id) {
				g.fillStyle = LIT;
				wire.points.forEach((q) => g.fillRect(q[0] - 3 * px, q[1] - 3 * px, 6 * px, 6 * px));
			}
		});
		g.globalAlpha = 1;
		// components
		g.font = (11 * px) + "px monospace";
		board.components.forEach((comp) => {
			const selected = view.sel && view.sel.ref === comp.id;
			if (comp.box) {
				g.strokeStyle = selected ? LIT : "#ffb86c";
				g.lineWidth = (selected ? 2.5 : 1.2) * px;
				g.strokeRect(comp.box[0], comp.box[1], comp.box[2], comp.box[3]);
				g.fillStyle = selected ? LIT : "#ffb86c";
				g.fillText(comp.id + (comp.value ? " " + comp.value : ""), comp.box[0], comp.box[1] - 3 * px);
			}
			comp.pins.forEach((pin) => {
				const net = idx.netOfPin[comp.id + "." + pin.name];
				const on = lit && net === lit;
				g.globalAlpha = dim(net) && !selected ? 0.45 : 1;
				g.fillStyle = on ? LIT : net ? "#50fa7b" : "#ff5555";
				g.beginPath();
				g.arc(pin.x, pin.y, (on ? 5 : 3.5) * px, 0, Math.PI * 2);
				g.fill();
				if (c.s > 1.5 || on) {
					g.fillStyle = cssVar("--text") || "#fff";
					g.fillText(pin.name, pin.x + 5 * px, pin.y - 4 * px);
				}
			});
			g.globalAlpha = 1;
		});
		board.vias.forEach((v) => {
			const on = lit && idx.netOfItem[v.id] === lit;
			g.strokeStyle = on ? LIT : "#50fa7b";
			g.lineWidth = 2 * px;
			g.beginPath();
			g.arc(v.x, v.y, 4 * px, 0, Math.PI * 2);
			g.stroke();
		});
		board.labels.forEach((l) => {
			const on = lit && idx.netOfItem[l.id] === lit;
			g.fillStyle = on ? LIT : "#f1fa8c";
			g.beginPath();
			g.moveTo(l.x, l.y);
			g.lineTo(l.x + 6 * px, l.y - 6 * px);
			g.lineTo(l.x + 6 * px, l.y + 6 * px);
			g.fill();
			g.fillText(l.name, l.x + 9 * px, l.y + 4 * px);
		});
		board.testpoints.forEach((t) => {
			const on = lit && idx.netOfItem[t.id] === lit;
			g.fillStyle = on ? LIT : "#8be9fd";
			g.beginPath();
			g.moveTo(t.x, t.y - 6 * px);
			g.lineTo(t.x + 6 * px, t.y);
			g.lineTo(t.x, t.y + 6 * px);
			g.lineTo(t.x - 6 * px, t.y);
			g.fill();
			const live = t.channel && ctx.store.live[t.channel];
			const reading = live !== undefined && live !== null && t.channel ? Number(live).toPrecision(4) : t.reading !== undefined ? t.reading + (t.unit || "") : "";
			g.fillText(t.id + (reading !== "" ? " = " + reading : ""), t.x + 9 * px, t.y + 4 * px);
		});
		board.notes.forEach((n) => {
			g.fillStyle = "#ff79c6";
			g.fillText("✎ " + n.text.split("\n")[0].slice(0, 60), n.x, n.y);
		});
		// draft and helpers
		if (draft && draft.kind === "wire") {
			g.strokeStyle = SIDE_COLORS[view.side] || OTHER_COLOR;
			g.lineWidth = 2 * px;
			g.setLineDash([6 * px, 4 * px]);
			g.beginPath();
			draft.points.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])));
			g.stroke();
			g.setLineDash([]);
		}
		if (draft && draft.kind === "box") {
			g.strokeStyle = "#ffb86c";
			g.lineWidth = 1.5 * px;
			g.setLineDash([4 * px, 3 * px]);
			g.strokeRect(Math.min(draft.a[0], draft.b[0]), Math.min(draft.a[1], draft.b[1]), Math.abs(draft.b[0] - draft.a[0]), Math.abs(draft.b[1] - draft.a[1]));
			g.setLineDash([]);
		}
		if (align) {
			g.strokeStyle = HIT_COLOR;
			g.lineWidth = 1.5 * px;
			align.pairs.forEach((pr, i) => {
				g.beginPath();
				g.moveTo(pr.fromBoard[0], pr.fromBoard[1]);
				g.lineTo(pr.to[0], pr.to[1]);
				g.stroke();
				g.fillStyle = HIT_COLOR;
				g.fillText(String(i + 1), pr.to[0] + 4 * px, pr.to[1] - 4 * px);
			});
			if (align.from) {
				g.beginPath();
				g.arc(align.fromBoard[0], align.fromBoard[1], 6 * px, 0, Math.PI * 2);
				g.stroke();
			}
		}
		if (snapMark) {
			g.strokeStyle = LIT;
			g.lineWidth = 1.5 * px;
			g.strokeRect(snapMark[0] - 5 * px, snapMark[1] - 5 * px, 10 * px, 10 * px);
		}
		if (hover && hover.kind === "word") {
			g.strokeStyle = cssVar("--accent-2") || "#8be9fd";
			g.lineWidth = 1 * px;
			g.strokeRect(hover.box.x, hover.box.y, hover.box.w, hover.box.h);
		}
		g.restore();
	};

	const pcbHandlers = {
		draw: drawPcb,
		panButton: (e) => e.shiftKey || (view.tool === "select" && !hitTest(pcb.cam.toBoard(e.offsetX, e.offsetY))),
		down: (pt) => {
			if (view.tool === "component") {
				draft = { kind: "box", a: pt, b: pt };
			}
		},
		move: (pt, _e, dragging) => {
			if (dragging && draft && draft.kind === "box") {
				draft.b = pt;
				pcb.redraw();
				return true;
			}
			if (["wire", "pin", "via", "label", "testpoint", "align"].indexOf(view.tool) !== -1) {
				const s = snap(pt);
				snapMark = s.what ? s.at : null;
				view.status = s.what ? "→ " + s.what : (align ? view.status : "");
				if (draft && draft.kind === "wire") {
					draft.points[draft.points.length - 1] = s.at;
				}
				pcb.redraw();
			} else if (!dragging) {
				const h = hitTest(pt);
				const changed = (h && h.kind + h.id + h.text) !== (hover && hover.kind + hover.id + hover.text);
				hover = h;
				if (changed) {
					view.status = h ? (h.kind === "word" ? "text " + h.text + " (click to search)" : h.kind + " " + h.id + (h.net ? " · net " + h.net : "")) : "";
					pcb.redraw();
				}
			}
			return false;
		},
		up: (pt, _e, moved) => {
			if (draft && draft.kind === "box") {
				const box = [Math.min(draft.a[0], pt[0]), Math.min(draft.a[1], pt[1]), Math.abs(pt[0] - draft.a[0]), Math.abs(pt[1] - draft.a[1])];
				draft = null;
				pcb.redraw();
				if (box[2] * pcb.cam.cam.s > 4 && box[3] * pcb.cam.cam.s > 4) {
					finishComponent(box);
				}
				return;
			}
			if (moved) {
				return;
			}
			if (view.tool === "align") {
				alignClick(pt);
			} else if (view.tool === "select") {
				const h = hitTest(pt);
				if (h && h.kind === "word") {
					runSearch(h.text);
				} else {
					select(h);
				}
			} else {
				place(pt);
			}
		},
		dbl: () => finishWire(),
		key: (e) => {
			if (e.key === "Escape") {
				draft = null;
				snapMark = null;
				if (align) {
					cancelAlign();
				} else if (view.tool === "select") {
					select(null);
				}
				pcb.redraw();
			} else if (e.key === "Enter") {
				finishWire();
			} else if (e.key === "Delete" || e.key === "Backspace") {
				removeSelected();
			} else if (e.key === "f") {
				fitBoard();
			}
		}
	};

	// ---- graph (schematic) view --------------------------------------------------------

	const graph = () => {
		if (!graphLayout && board) {
			graphLayout = layoutGraph(board, idx);
			graphFitted = Boolean(sch && sch.cam.cam.touched) && graphFitted;
		}
		return graphLayout;
	};
	let graphFitted = false;

	const drawSch = (g, cam, w, h) => {
		const c = cam.cam;
		const dpr = window.devicePixelRatio || 1;
		g.fillStyle = cssVar("--panel") || "#222";
		g.fillRect(0, 0, w, h);
		const lay = graph();
		if (!lay) {
			return;
		}
		if (!graphFitted && lay.nodes.length && w > 0 && h > 0) {
			graphFitted = true;
			const xs = lay.nodes.map((n) => n.x);
			const ys = lay.nodes.map((n) => n.y);
			const x0 = Math.min.apply(null, xs) - 40;
			const y0 = Math.min.apply(null, ys) - 40;
			cam.fit({ x: x0, y: y0, w: Math.max.apply(null, lay.nodes.map((n) => n.x + n.w)) + 40 - x0, h: Math.max.apply(null, lay.nodes.map((n) => n.y + n.h)) + 40 - y0 }, w, h);
			return;
		}
		g.save();
		g.setTransform(dpr * c.s, 0, 0, dpr * c.s, dpr * c.tx, dpr * c.ty);
		const px = 1 / c.s;
		const lit = view.net;
		const text = cssVar("--text") || "#eee";
		const muted = cssVar("--muted") || "#888";
		g.font = "10px monospace";
		lay.edges.forEach((e) => {
			const on = lit && e.net === lit;
			g.strokeStyle = on ? LIT : e.power ? muted : (cssVar("--accent-2") || "#8be9fd");
			g.globalAlpha = lit && !on ? 0.25 : 0.85;
			g.lineWidth = (on ? 2.5 : 1) * px;
			if (e.power) {
				// power / ground nets as named stubs, like schematic power symbols
				g.fillStyle = on ? LIT : muted;
				e.pins.forEach((pin) => {
					const dir = pin.left ? -1 : 1;
					g.beginPath();
					g.moveTo(pin.x, pin.y);
					g.lineTo(pin.x + dir * 10, pin.y);
					g.stroke();
					g.textAlign = pin.left ? "right" : "left";
					g.fillText(e.net, pin.x + dir * 12, pin.y + 3);
				});
				g.textAlign = "left";
			} else if (e.pins.length === 2) {
				g.beginPath();
				g.moveTo(e.pins[0].x, e.pins[0].y);
				g.lineTo(e.pins[1].x, e.pins[1].y);
				g.stroke();
			} else if (e.pins.length > 2) {
				e.pins.forEach((pin) => {
					g.beginPath();
					g.moveTo(pin.x, pin.y);
					g.lineTo(e.hub[0], e.hub[1]);
					g.stroke();
				});
				g.fillStyle = g.strokeStyle;
				g.beginPath();
				g.arc(e.hub[0], e.hub[1], 2.5, 0, Math.PI * 2);
				g.fill();
			}
			if (on && !e.power) {
				g.fillStyle = LIT;
				g.fillText(e.net, e.hub[0] + 4, e.hub[1] - 4);
			}
		});
		g.globalAlpha = 1;
		const hitRefs = new Set((view.hits && view.hits.components) || []);
		lay.nodes.forEach((n) => {
			const selected = view.sel && view.sel.ref === n.ref;
			g.fillStyle = cssVar("--panel-2") || "#333";
			g.fillRect(n.x, n.y, n.w, n.h);
			g.strokeStyle = selected ? LIT : hitRefs.has(n.ref) ? HIT_COLOR : "#ffb86c";
			g.lineWidth = (selected ? 2.5 : 1.2) * px;
			g.strokeRect(n.x, n.y, n.w, n.h);
			g.fillStyle = text;
			g.fillText(n.ref, n.x + 4, n.y + 11);
			g.fillStyle = muted;
			g.fillText(n.value.slice(0, 11), n.x + 4, n.y + 23);
			n.pins.forEach((pin) => {
				const net = idx.netOfPin[pin.key];
				const on = lit && net === lit;
				g.strokeStyle = on ? LIT : net ? text : "#ff5555";
				g.lineWidth = (on ? 2 : 1) * px;
				g.beginPath();
				g.moveTo(pin.ax, pin.y);
				g.lineTo(pin.x, pin.y);
				g.stroke();
				g.fillStyle = muted;
				g.textAlign = pin.left ? "left" : "right";
				g.fillText(pin.name, pin.left ? pin.ax + 3 : pin.ax - 3, pin.y + 3);
				g.textAlign = "left";
			});
		});
		g.restore();
	};

	const schHit = (pt) => {
		const lay = graph();
		if (!lay) {
			return null;
		}
		const r = HIT_PX / sch.cam.cam.s;
		let pin = null;
		lay.nodes.forEach((n) => n.pins.forEach((pp) => {
			if (Math.abs(pt[1] - pp.y) <= Math.max(r, 4) && pt[0] >= Math.min(pp.x, pp.ax) - r && pt[0] <= Math.max(pp.x, pp.ax) + r) {
				pin = { kind: "pin", id: pp.key, ref: n.ref, net: idx.netOfPin[pp.key] };
			}
		}));
		if (pin) {
			return pin;
		}
		const node = lay.nodes.find((n) => pt[0] >= n.x && pt[0] <= n.x + n.w && pt[1] >= n.y && pt[1] <= n.y + n.h);
		return node ? { kind: "component", id: node.ref, ref: node.ref } : null;
	};

	const schHandlers = {
		draw: drawSch,
		panButton: (e) => !schHit(sch.cam.toBoard(e.offsetX, e.offsetY)),
		down: () => null,
		move: (pt, _e, dragging) => {
			if (!dragging) {
				const h = schHit(pt);
				view.status = h ? h.kind + " " + h.id + (h.net ? " · net " + h.net : "") : view.status;
			}
			return false;
		},
		up: (pt, _e, moved) => {
			if (!moved) {
				select(schHit(pt));
			}
		},
		dbl: (pt) => {
			// double-click a part in the graph: show it on the board
			const h = schHit(pt);
			const comp = h && board.components.find((cmp) => cmp.id === h.ref);
			if (comp && comp.box) {
				centerOn({ x: comp.box[0], y: comp.box[1], w: comp.box[2], h: comp.box[3] });
			}
		},
		key: (e) => {
			if (e.key === "Escape") {
				select(null);
			}
		}
	};

	// ---- side panel ---------------------------------------------------------------------

	const focusComponent = (comp) => {
		select({ kind: "component", id: comp.id, ref: comp.id });
		if (comp.box) {
			centerOn({ x: comp.box[0], y: comp.box[1], w: comp.box[2], h: comp.box[3] });
		} else if (comp.pins.length) {
			centerOn({ x: comp.pins[0].x, y: comp.pins[0].y, w: 1, h: 1 });
		}
	};

	const focusNet = (net) => {
		view.sel = null;
		view.net = net.name;
		const pts = [];
		board.components.forEach((c) => c.pins.forEach((pin) => {
			if (idx.netOfPin[c.id + "." + pin.name] === net.name) {
				pts.push([pin.x, pin.y]);
			}
		}));
		board.wires.forEach((w) => idx.netOfWire[w.id] === net.name && w.points.forEach((q) => pts.push(q)));
		if (pts.length) {
			const xs = pts.map((q) => q[0]);
			const ys = pts.map((q) => q[1]);
			const x0 = Math.min.apply(null, xs);
			const y0 = Math.min.apply(null, ys);
			centerOn({ x: x0, y: y0, w: Math.max.apply(null, xs) - x0, h: Math.max.apply(null, ys) - y0 });
		}
		redrawAll();
	};

	const filtered = (items, text) => {
		const f = view.filter.toLowerCase();
		return f ? items.filter((it) => text(it).toLowerCase().indexOf(f) !== -1) : items;
	};

	const partsRows = () => {
		const comps = filtered(view.board ? view.board.components.slice() : [], (c) => c.id + " " + (c.value || "") + " " + (c.footprint || ""));
		if (view.sort === "pins") {
			return comps.sort((a, b) => b.pins.length - a.pins.length || byNatural(a.id, b.id));
		}
		if (view.sort === "value") {
			return comps.sort((a, b) => byNatural(a.value || "", b.value || "") || byNatural(a.id, b.id));
		}
		return comps.sort((a, b) => byNatural(a.id, b.id));
	};

	const netRows = () => {
		const nets = filtered(view.board ? view.board.nets.slice() : [], (n) => n.name + " " + n.aliases.join(" "));
		if (view.sort === "pins") {
			return nets.sort((a, b) => b.pins.length - a.pins.length || byNatural(a.name, b.name));
		}
		return nets.sort((a, b) => byNatural(a.name, b.name));
	};

	const tabButton = (id, label) => el("button", { class: () => (view.tab === id ? "primary" : ""), onclick: () => {
		view.tab = id;
	} }, label);

	const layerRow = (l) => el("div", { class: "bv-layer" },
		el("label", { class: "bv-layer-name", title: () => l.id + " · " + l.kind + " " + l.width + "×" + l.height + (l.words ? " · " + l.words + " words" : "") },
			el("input", { type: "checkbox", checked: l.visible, onchange: (e) => api("PATCH", "/layers/" + enc(l.id), { visible: e.target.checked }) }),
			" " + l.name),
		el("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(l.opacity), title: "opacity",
			onchange: (e) => api("PATCH", "/layers/" + enc(l.id), { opacity: Number(e.target.value) }) }),
		el("select", { title: "copper side shown", onchange: (e) => api("PATCH", "/layers/" + enc(l.id), { side: e.target.value }) },
			...["any", "top", "bottom"].map((s) => el("option", { value: s, selected: (l.side || "any") === s }, s))),
		el("button", { class: "icon", title: "align to the board (2-3 point pairs)", onclick: () => startAlign(l) }, "⌖"),
		el("button", { class: "icon", title: "mirror (bottom-side photo)", onclick: () => transformLayer(l, [-1, 0, 0, 1, 0, 0]) }, "⇋"),
		el("button", { class: "icon", title: "rotate 90°", onclick: () => transformLayer(l, [0, 1, -1, 0, 0, 0]) }, "⟳"),
		el("button", { class: "icon", title: "move up", onclick: () => api("PATCH", "/layers/" + enc(l.id), { order: view.board.layers.indexOf(l) + 1 }) }, "▲"),
		el("button", { class: "icon", title: "remove layer", onclick: () => {
			if (confirm("Remove layer " + l.name + "?")) {
				api("DELETE", "/layers/" + enc(l.id)).catch((err) => {
					view.error = err.message;
				});
			}
		} }, "✕"));

	const importFile = (file) => {
		const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
		const fields = [{ name: "side", type: "select", options: ["any", "top", "bottom"], label: "side" }];
		const ask2 = isPdf ? ctx.dialog("Import " + file.name, [{ name: "pages", label: "pages (blank = all, max 30), e.g. 1-3,7" }, { name: "dpi", value: "150" }].concat(fields))
			: ctx.dialog("Import " + file.name, fields);
		ask2.then((v) => {
			if (!v) {
				return null;
			}
			const q = "?label=" + enc(file.name.replace(/\.[^.]+$/, "")) + "&side=" + enc(v.side) + (v.pages ? "&pages=" + enc(v.pages) : "") + (v.dpi ? "&dpi=" + enc(v.dpi) : "");
			view.status = "importing " + file.name + "…";
			return fetch("/api/boards/" + enc(name()) + "/upload" + q, { method: "PUT", body: file }).then((res) => res.json().then((body) => {
				if (!res.ok) {
					throw new Error(body.error || res.statusText);
				}
				fitted = false;
				view.status = "imported " + body.layers.length + " layer(s)";
			}));
		}).catch((err) => {
			view.error = err.message;
		});
	};

	const setBoard = (boardName) => ctx.api("PATCH", "/panes/" + p.pane.id, { config: { board: boardName } }).then(() => {
		fitted = false;
		board = null;
	});

	const chooser = () => el("div", { class: "pad bv-choose" },
		el("div", {}, "Open a board or start one, then import a PDF page or a photo as the background and trace over it."),
		el("div", { class: "bv-row" },
			el("input", { placeholder: "new board name", id: "bv-new-" + p.pane.id }),
			el("button", { class: "primary", onclick: (e) => {
				const input = e.target.parentNode.querySelector("input");
				ctx.api("POST", "/boards", { name: input.value.trim() }).then(() => setBoard(input.value.trim()), (err) => {
					view.error = err.message;
				});
			} }, "create")),
		list(() => view.boards, (b) => b.name, (b) => el("div", { class: "bv-row" },
			el("button", { onclick: () => setBoard(b.name) }, "open"), " ", el("b", {}, b.name),
			el("span", { class: "muted" }, " " + b.layers + " layers · " + b.components + " parts · " + b.wires + " wires"))),
		el("div", { class: "err" }, () => view.error));

	const toolbarEl = () => el("div", { class: "toolbar pad bv-toolbar" },
		el("b", {}, () => (view.board ? view.board.name : "")),
		...TOOLS.map((t) => el("button", { class: () => "icon bv-tool" + (view.tool === t[0] ? " on" : ""), title: t[2], onclick: () => {
			draft = null;
			if (align) {
				cancelAlign();
			}
			view.tool = t[0];
			redrawAll();
		} }, t[1])),
		el("select", { title: "side being traced: wires / parts go on this side; snapping only to the same side", onchange: (e) => {
			view.side = e.target.value === "any" ? "" : e.target.value;
		} }, el("option", { value: "any" }, "any side"), el("option", { value: "top" }, "top"), el("option", { value: "bottom" }, "bottom")),
		el("input", { class: "bv-search", placeholder: "search refdes / net / text", value: () => view.query, onchange: (e) => runSearch(e.target.value.trim()) }),
		el("select", { title: "views", onchange: (e) => {
			view.mode = e.target.value;
			graphFitted = false;
		} }, ...["split", "board", "graph"].map((m) => el("option", { value: m, selected: view.mode === m }, m))),
		el("label", { class: "icon bv-upload", title: "import PDF / image as a layer" }, "⤒",
			el("input", { type: "file", accept: ".pdf,image/*", style: "display:none", onchange: (e) => {
				if (e.target.files[0]) {
					importFile(e.target.files[0]);
				}
				e.target.value = "";
			} })),
		el("button", { class: "icon", title: "fit (f)", onclick: () => fitBoard() }, "⤢"),
		el("a", { class: "icon", title: "netlist CSV", href: () => "/api/boards/" + enc(name() || "") + "/netlist?format=csv" }, "csv"),
		el("a", { class: "icon", title: "KiCad netlist", href: () => "/api/boards/" + enc(name() || "") + "/netlist?format=kicad" }, ".net"));

	const sidebar = () => el("div", { class: "bv-side" },
		el("div", { class: "bv-tabs" }, tabButton("parts", "parts"), tabButton("nets", "nets"), tabButton("layers", "layers"), tabButton("hits", "hits")),
		when(() => view.tab === "parts" || view.tab === "nets", () => el("div", { class: "bv-row" },
			el("input", { placeholder: "filter", value: () => view.filter, oninput: (e) => {
				view.filter = e.target.value;
			} }),
			el("select", { onchange: (e) => {
				view.sort = e.target.value;
			} }, el("option", { value: "name" }, "name"), el("option", { value: "pins" }, "pins"), el("option", { value: "value" }, "value")))),
		el("div", { class: "bv-list" },
			when(() => view.tab, (tab) => {
				if (tab === "parts") {
					return list(partsRows, (c) => c.id + "|" + (c.value || "") + "|" + c.pins.length, (c) => el("div", { class: () => "bv-item" + (view.sel && view.sel.ref === c.id ? " on" : ""), onclick: () => focusComponent(c) },
						el("b", {}, c.id), " ", el("span", { class: "muted" }, (c.value || "") + " · " + c.pins.length + " pins")));
				}
				if (tab === "nets") {
					return list(netRows, (n) => n.name + "|" + n.pins.length + "|" + n.aliases.join(","), (n) => el("div", { class: () => "bv-item" + (view.net === n.name ? " on" : ""), onclick: () => focusNet(n) },
						el("b", {}, n.name), " ", el("span", { class: "muted" }, n.pins.length + " pins" + (n.aliases.length ? " · also " + n.aliases.join(", ") : ""))));
				}
				if (tab === "layers") {
					return el("div", {},
						list(() => (view.board ? view.board.layers.slice().reverse() : []), (l) => l.id + ":" + l.visible + ":" + l.opacity + ":" + l.side + ":" + l.matrix.join(","), layerRow),
						when(() => view.alignLayer, () => el("div", { class: "pad bv-align" },
							el("div", {}, () => view.status),
							el("button", { disabled: () => view.alignPairs < 2, onclick: () => applyAlign(false) }, "apply"),
							el("button", { disabled: () => view.alignPairs < 2, onclick: () => applyAlign(true) }, "apply mirrored"),
							el("button", { onclick: cancelAlign }, "cancel"))));
				}
				return when(() => view.hits, () => el("div", {},
					el("div", { class: "muted pad" }, () => view.hits.text.length + " text hits" + (view.hits.truncated ? "+" : "")),
					list(() => view.hits.components, (r) => "c" + r, (r) => el("div", { class: "bv-item", onclick: () => {
						const comp = board.components.find((c) => c.id === r);
						if (comp) {
							focusComponent(comp);
						}
					} }, "part ", el("b", {}, r))),
					list(() => view.hits.nets, (n) => "n" + n, (n) => el("div", { class: "bv-item", onclick: () => {
						const net = idx.nets.find((x) => x.name === n);
						if (net) {
							focusNet(net);
						}
					} }, "net ", el("b", {}, n))),
					list(() => view.hits.text, (t) => t.layer + t.x + "," + t.y, (t) => el("div", { class: "bv-item", onclick: () => centerOn(t) },
						el("span", { class: "mono" }, t.text), el("span", { class: "muted" }, " " + t.layer + " @ " + Math.round(t.x) + "," + Math.round(t.y))))
				), () => el("div", { class: "muted pad" }, "search refdes, net names or any text on the layers"));
			})),
		el("div", { class: "bv-sel pad" }, () => {
			const s = view.sel;
			if (!s && !view.net) {
				return el("span", { class: "muted" }, () => (view.board ? view.board.components.length + " parts · " + view.board.nets.length + " nets · " + view.board.unconnected.length + " open pins" : ""));
			}
			return el("div", {},
				s ? el("div", {}, s.kind + " ", el("b", {}, s.id || s.text || "")) : null,
				view.net ? el("div", {}, "net ", el("b", { style: "color:" + LIT }, view.net)) : null,
				s && s.kind !== "word" ? el("button", { onclick: removeSelected }, "delete") : null);
		}));

	return when(() => name(), () => el("div", { class: "bv", tabindex: "-1" },
		toolbarEl(),
		el("div", { class: "bv-status pad muted" }, () => (view.error ? el("span", { class: "err" }, view.error) : view.status || " ")),
		el("div", { class: () => "bv-main bv-" + view.mode },
			el("div", { class: "bv-pcb" }, widget((host) => {
				pcb = viewport(host, pcbHandlers);
				loadWords();
				ensureFit();
				pcb.redraw();
				return {
					resize: () => {
						if (!pcb.cam.cam.touched) {
							fitted = false;
						}
						ensureFit();
						pcb.redraw();
					},
					destroy: () => {
						pcb = null;
					}
				};
			})),
			el("div", { class: "bv-sch" }, widget((host) => {
				sch = viewport(host, schHandlers);
				sch.redraw();
				return {
					resize: () => {
						if (!sch.cam.cam.touched) {
							graphFitted = false;
						}
						sch.redraw();
					},
					destroy: () => {
						sch = null;
					}
				};
			})),
			sidebar()),
		el("span", { style: "display:none" }, () => {
			// re-read words and redraw after every board reload
			if (view.board) {
				loadWords();
				redrawAll();
			}
			return "";
		})
	), () => chooser());
});
