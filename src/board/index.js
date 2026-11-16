// Boards: a tracing workspace for reverse engineering PCBs and schematics.
// Background layers (PDF pages rendered to PNG, photos of top/bottom, SVG)
// sit on a shared board coordinate system through per-layer affine
// transforms; on top, traced geometry (components with pins, wires, vias, net
// labels, test points, notes). Connectivity comes from the geometry (see
// src/netgraph), so tracing copper is enough to get nets.
//
// Stored per board: DATA_DIR/boards/<name>.json (document) and
// DATA_DIR/boards/<name>/ (layer images, source PDFs, extracted words).

const fs = require("fs");
const path = require("path");
const affine = require("../utils/affine");
const netgraph = require("../netgraph");
const pdf = require("../services/pdf");
const raster = require("../services/raster");

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const REF_RE = /^[A-Za-z0-9_+\-/#$]{1,32}$/;
const PIN_RE = /^[A-Za-z0-9_+\-/#$~]{1,16}$/;
const DEFAULT_DPI = 150;
const MAX_DPI = 600;
const MAX_PAGES_PER_IMPORT = 30;
const MAX_VIEW_PX = 1600;
const MAX_VIEW_DPI = 600;
const KINDS = ["component", "pin", "wire", "via", "label", "testpoint", "note", "net"];
const COLLECTIONS = { component: "components", wire: "wires", via: "vias", label: "labels", testpoint: "testpoints", note: "notes" };
const ID_PREFIX = { wire: "w", via: "v", label: "lb", testpoint: "TP", note: "n" };
const HIGHLIGHT = "#ff3df0";

const emptyBoard = (name, title) => ({
	name: name,
	title: title || name,
	created: Date.now(),
	updated: Date.now(),
	snap: netgraph.DEFAULT_TOLERANCE,
	seq: 0,
	layers: [],
	components: [],
	wires: [],
	vias: [],
	labels: [],
	testpoints: [],
	notes: [],
	nets: {}
});

const num = (v, what) => {
	const n = Number(v);
	if (v === undefined || v === null || v === "" || !Number.isFinite(n)) {
		throw new Error(what + " must be a number");
	}
	return n;
};

// board coordinates keep 1/100 of a unit (UI clicks produce long fractions)
const coord = (v, what) => Math.round(num(v, what) * 100) / 100;

const point = (p, what) => {
	if (!Array.isArray(p) || p.length !== 2) {
		throw new Error(what + " must be [x, y]");
	}
	return [coord(p[0], what + "[0]"), coord(p[1], what + "[1]")];
};

const side = (v) => {
	if (v === undefined || v === null || v === "" || v === "any") {
		return null;
	}
	if (!/^[A-Za-z0-9_-]{1,16}$/.test(String(v))) {
		throw new Error("side: short word like top, bottom, inner1 or any");
	}
	return String(v);
};

/**
 * "1-3,5" → [1, 2, 3, 5] (1-based, within 1..max)
 */
const parsePages = (spec, max) => {
	if (spec === undefined || spec === null || spec === "") {
		return Array.from({ length: max }, (_, i) => i + 1);
	}
	const pages = String(spec).split(",").map((part) => part.trim()).filter(Boolean).reduce((acc, part) => {
		const m = /^(\d+)(?:-(\d+))?$/.exec(part);
		if (!m) {
			throw new Error("pages: like 1-3,5");
		}
		const a = Number(m[1]);
		const b = m[2] ? Number(m[2]) : a;
		if (a < 1 || b > max || a > b) {
			throw new Error("pages out of range 1-" + max + ": " + part);
		}
		return acc.concat(Array.from({ length: b - a + 1 }, (_, i) => a + i));
	}, []);
	return Array.from(new Set(pages));
};

/**
 * @param {string} dir DATA_DIR/boards
 * @param {{onChange: function(string)}} [hooks] called with the board name after every change
 */
const create = (dir, hooks) => {
	const onChange = (hooks && hooks.onChange) || (() => null);
	const cache = {};
	const wordCache = {};
	const connCache = {};

	const validName = (name) => {
		if (typeof name !== "string" || !NAME_RE.test(name) || name.startsWith(".")) {
			throw new Error("board names: letters, digits, _ . - (max 64)");
		}
		return name;
	};
	const docFile = (name) => path.join(dir, validName(name) + ".json");
	const assetDir = (name) => path.join(dir, validName(name));

	const save = (board) => {
		const next = board;
		next.updated = Date.now();
		fs.mkdirSync(dir, { recursive: true });
		const file = docFile(board.name);
		fs.writeFileSync(file + ".tmp", JSON.stringify(board));
		fs.renameSync(file + ".tmp", file);
		delete connCache[board.name];
		onChange(board.name);
		return board;
	};

	const nextId = (board, prefix) => {
		const b = board;
		b.seq = (b.seq || 0) + 1;
		return prefix + b.seq;
	};

	const findLayer = (board, id) => {
		const layer = board.layers.find((l) => l.id === id);
		if (!layer) {
			throw new Error("unknown layer " + id + " on board " + board.name + " (layers: " + board.layers.map((l) => l.id).join(", ") + ")");
		}
		return layer;
	};

	const words = (board, layer) => {
		const key = board.name + "/" + layer.id;
		if (!wordCache[key]) {
			const file = path.join(assetDir(board.name), layer.id + ".words.json");
			wordCache[key] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
		}
		return wordCache[key];
	};

	// board-coordinate box of a word on a layer
	const wordBox = (layer, w) => {
		const b = affine.boundsOf(layer.matrix, { x: w.x, y: w.y, w: w.w, h: w.h });
		const r = (v) => Math.round(v * 100) / 100;
		return { x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) };
	};

	const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

	const conn = (board) => {
		if (!connCache[board.name]) {
			connCache[board.name] = netgraph.connectivity(board);
		}
		return connCache[board.name];
	};

	const addLayer = (board, spec) => {
		const layer = Object.assign({
			id: nextId(board, "L"),
			visible: true,
			opacity: 1,
			side: null
		}, spec);
		if (!layer.matrix) {
			// first layer defines board units; later ones start on top of it at the same size
			const first = board.layers[0];
			if (first && first.dpi && layer.dpi) {
				const k = first.dpi / layer.dpi;
				layer.matrix = affine.multiply(first.matrix, [k, 0, 0, k, 0, 0]);
			} else {
				layer.matrix = first ? first.matrix.slice() : affine.IDENTITY.slice();
			}
		}
		board.layers.push(layer);
		return layer;
	};

	const writeWords = (board, layerId, list) => {
		fs.writeFileSync(path.join(assetDir(board.name), layerId + ".words.json"), JSON.stringify(list));
		wordCache[board.name + "/" + layerId] = list;
	};

	const boards = {
		NAME_RE: NAME_RE,

		list: () => {
			if (!fs.existsSync(dir)) {
				return [];
			}
			return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
				const b = boards.get(f.slice(0, -5));
				return {
					name: b.name, title: b.title, updated: b.updated, layers: b.layers.length,
					components: b.components.length, wires: b.wires.length
				};
			}).sort((a, b) => b.updated - a.updated);
		},

		exists: (name) => Boolean(cache[name]) || fs.existsSync(docFile(name)),

		get: (name) => {
			const file = docFile(name);
			if (!cache[name]) {
				if (!fs.existsSync(file)) {
					throw new Error("unknown board: " + name);
				}
				cache[name] = Object.assign(emptyBoard(name), JSON.parse(fs.readFileSync(file, "utf8")), { name: name });
			}
			return cache[name];
		},

		create: (name, title) => {
			validName(name);
			if (boards.exists(name)) {
				throw new Error("board exists: " + name);
			}
			cache[name] = emptyBoard(name, title);
			return save(cache[name]);
		},

		/** Board, created when missing. */
		ensure: (name, title) => (boards.exists(name) ? boards.get(name) : boards.create(name, title)),

		remove: (name) => {
			const file = docFile(name);
			if (!fs.existsSync(file)) {
				throw new Error("unknown board: " + name);
			}
			fs.rmSync(file, { force: true });
			fs.rmSync(assetDir(name), { recursive: true, force: true });
			delete cache[name];
			delete connCache[name];
			Object.keys(wordCache).filter((k) => k.startsWith(name + "/")).forEach((k) => {
				delete wordCache[k];
			});
			onChange(name);
			return { removed: name };
		},

		/**
		 * The board document plus computed nets.
		 */
		snapshot: (name) => {
			const board = boards.get(name);
			const c = conn(board);
			return Object.assign({}, board, { netlist: { nets: c.nets, unconnected: c.unconnected } });
		},

		// ---- layers -----------------------------------------------------------

		/**
		 * Import a PDF (pages as layers) or an image (one layer).
		 * @param {string} name board (created when missing)
		 * @param {Buffer} data file contents
		 * @param {{label: string, pages: string, dpi: number, side: string}} [options]
		 * @returns {Promise<Array<Object>>} the new layers
		 */
		importData: (name, data, options) => {
			const opts = options || {};
			const board = boards.ensure(name);
			fs.mkdirSync(assetDir(name), { recursive: true });
			if (pdf.isPdf(data)) {
				const srcId = nextId(board, "src");
				const srcFile = srcId + ".pdf";
				fs.writeFileSync(path.join(assetDir(name), srcFile), data);
				return boards.importPdf(board, srcFile, opts);
			}
			const kind = raster.sniff(data);
			if (!kind) {
				throw new Error("not a PDF, PNG, JPEG, GIF, WebP or SVG");
			}
			const id = nextId(board, "L");
			const file = id + "." + kind.ext;
			fs.writeFileSync(path.join(assetDir(name), file), data);
			const layer = addLayer(board, {
				id: id, name: opts.label || kind.ext + " " + id, kind: kind.ext === "svg" ? "svg" : "image",
				file: file, mime: kind.mime, width: kind.width, height: kind.height, side: side(opts.side)
			});
			writeWords(board, id, []);
			save(board);
			return Promise.resolve([layer]);
		},

		importPdf: (board, srcFile, opts) => {
			const dpi = Math.min(MAX_DPI, Math.max(18, Number(opts.dpi) || DEFAULT_DPI));
			const srcPath = path.join(assetDir(board.name), srcFile);
			return pdf.info(srcPath).then((info) => {
				const pages = parsePages(opts.pages, info.pages);
				if (pages.length > MAX_PAGES_PER_IMPORT) {
					throw new Error(info.pages + " pages: import at most " + MAX_PAGES_PER_IMPORT + " at a time (pages: \"1-5,9\")");
				}
				const base = opts.label || info.title || "pdf";
				// one page at a time: pdftoppm is heavy
				return pages.reduce((chain, page) => chain.then((done) => {
					const id = nextId(board, "L");
					const prefix = path.join(assetDir(board.name), id);
					return pdf.render(srcPath, page, dpi, prefix)
						.then((png) => {
							const size = raster.sniff(fs.readFileSync(png));
							return pdf.words(srcPath, page, dpi).then((list) => {
								writeWords(board, id, list);
								return addLayer(board, {
									id: id, name: base + " p" + page, kind: "pdf", file: id + ".png", mime: "image/png",
									width: size.width, height: size.height, dpi: dpi, source: { pdf: srcFile, page: page }, words: list.length,
									side: side(opts.side)
								});
							});
						})
						.then((layer) => done.concat([layer]));
				}), Promise.resolve([])).then((layers) => {
					save(board);
					return layers;
				});
			});
		},

		layerFile: (name, id) => {
			const board = boards.get(name);
			const layer = findLayer(board, id);
			return { path: path.join(assetDir(name), layer.file), mime: layer.mime };
		},

		/**
		 * @param {{name: string, visible: boolean, opacity: number, side: string, matrix: number[],
		 *   params: {x: number, y: number, scale: number, rotate: number, flip: boolean}}} changes
		 */
		updateLayer: (name, id, changes) => {
			const board = boards.get(name);
			const layer = findLayer(board, id);
			if (changes.name !== undefined) {
				layer.name = String(changes.name).slice(0, 80);
			}
			if (changes.visible !== undefined) {
				layer.visible = Boolean(changes.visible);
			}
			if (changes.opacity !== undefined) {
				layer.opacity = Math.max(0, Math.min(1, num(changes.opacity, "opacity")));
			}
			if (changes.side !== undefined) {
				layer.side = side(changes.side);
			}
			if (changes.matrix !== undefined) {
				if (!Array.isArray(changes.matrix) || changes.matrix.length !== 6) {
					throw new Error("matrix: [a, b, c, d, e, f]");
				}
				layer.matrix = changes.matrix.map((v, i) => num(v, "matrix[" + i + "]"));
				affine.invert(layer.matrix);
			}
			if (changes.params !== undefined) {
				const now = affine.toParams(layer.matrix);
				layer.matrix = affine.fromParams(Object.assign(now, changes.params));
			}
			if (changes.order !== undefined) {
				const to = Math.max(0, Math.min(board.layers.length - 1, num(changes.order, "order")));
				board.layers = board.layers.filter((l) => l !== layer);
				board.layers.splice(to, 0, layer);
			}
			save(board);
			return layer;
		},

		/**
		 * Align a layer from point pairs: `from` in the layer's own pixels,
		 * `to` in board coordinates. 2 pairs = similarity (optionally mirrored),
		 * 3 pairs = full affine.
		 */
		alignLayer: (name, id, pairs, flip) => {
			if (!Array.isArray(pairs) || (pairs.length !== 2 && pairs.length !== 3)) {
				throw new Error("align with 2 or 3 point pairs [{from: [x, y], to: [x, y]}]");
			}
			const src = pairs.map((p, i) => point(p.from, "pairs[" + i + "].from"));
			const dst = pairs.map((p, i) => point(p.to, "pairs[" + i + "].to"));
			const matrix = pairs.length === 2 ? affine.fromTwoPoints(src, dst, flip) : affine.fromThreePoints(src, dst);
			return boards.updateLayer(name, id, { matrix: matrix });
		},

		removeLayer: (name, id) => {
			const board = boards.get(name);
			const layer = findLayer(board, id);
			board.layers = board.layers.filter((l) => l !== layer);
			fs.rmSync(path.join(assetDir(name), layer.file), { force: true });
			fs.rmSync(path.join(assetDir(name), layer.id + ".words.json"), { force: true });
			delete wordCache[name + "/" + id];
			const stillUsed = layer.source && board.layers.some((l) => l.source && l.source.pdf === layer.source.pdf);
			if (layer.source && !stillUsed) {
				fs.rmSync(path.join(assetDir(name), layer.source.pdf), { force: true });
			}
			save(board);
			return { removed: id };
		},

		// ---- text on layers ----------------------------------------------------

		/**
		 * Words on layers in board coordinates, optionally only inside a region.
		 * @param {{layer: string, region: {x: number, y: number, w: number, h: number}, limit: number}} [options]
		 */
		text: (name, options) => {
			const opts = options || {};
			const board = boards.get(name);
			const limit = opts.limit || 2000;
			const layers = opts.layer ? [findLayer(board, opts.layer)] : board.layers;
			const out = [];
			layers.forEach((layer) => {
				words(board, layer).forEach((w) => {
					if (out.length >= limit) {
						return;
					}
					const box = wordBox(layer, w);
					if (!opts.region || intersects(box, opts.region)) {
						out.push({ layer: layer.id, text: w.text, x: box.x, y: box.y, w: box.w, h: box.h });
					}
				});
			});
			return out;
		},

		/**
		 * Search layer text and the traced graph (components, nets, pins).
		 * `regex` treats the query as a regular expression (case-insensitive);
		 * `exact` matches whole words only.
		 */
		search: (name, query, options) => {
			const opts = options || {};
			const board = boards.get(name);
			const q = String(query || "").trim();
			if (!q) {
				throw new Error("empty search");
			}
			let test;
			if (opts.regex) {
				const re = new RegExp(q, "i");
				test = (s) => re.test(s);
			} else if (opts.exact) {
				test = (s) => s.toLowerCase() === q.toLowerCase();
			} else {
				test = (s) => s.toLowerCase().indexOf(q.toLowerCase()) !== -1;
			}
			const limit = opts.limit || 200;
			const text = [];
			board.layers.forEach((layer) => {
				words(board, layer).forEach((w) => {
					if (text.length < limit && test(w.text)) {
						const box = wordBox(layer, w);
						text.push({ layer: layer.id, text: w.text, x: box.x, y: box.y, w: box.w, h: box.h });
					}
				});
			});
			const c = conn(board);
			const g = netgraph.graph(board, c);
			const traced = opts.regex || opts.exact ? {
				components: board.components.filter((comp) => test(comp.id) || (comp.value && test(comp.value))).map((comp) => comp.id),
				nets: c.nets.filter((n) => test(n.name)).map((n) => n.name),
				pins: Object.keys(c.pinNet).filter(test)
			} : g.search(q);
			return Object.assign({ query: q, text: text, truncated: text.length >= limit }, traced);
		},

		// ---- traced geometry ----------------------------------------------------

		/**
		 * Apply drawing operations atomically (all or nothing).
		 * @param {Array<{op: string, kind: string, id: string}>} ops
		 *   op: add | update | remove; kind: component | pin | wire | via | label | testpoint | note | net
		 * @returns {Array<{op: string, kind: string, id: string}>}
		 */
		draw: (name, ops) => {
			if (!Array.isArray(ops) || !ops.length) {
				throw new Error("ops: [{op: add|update|remove, kind, ...}]");
			}
			const original = boards.get(name);
			// work on a copy so a failing op leaves the board untouched
			const board = JSON.parse(JSON.stringify(original));
			const results = ops.map((o, i) => {
				try {
					return applyOp(board, o);
				} catch (err) {
					throw new Error("op " + i + " (" + o.op + " " + o.kind + "): " + err.message, { cause: err });
				}
			});
			cache[name] = board;
			save(board);
			return results;
		},

		// ---- connectivity ------------------------------------------------------

		connectivity: (name) => conn(boards.get(name)),

		/**
		 * @param {{what: string, net: string, pin: string, ref: string, from: string, to: string, text: string, avoid: string[]}} query
		 *   what: nets | net | pin | neighbors | path | search
		 */
		query: (name, query) => {
			const board = boards.get(name);
			const c = conn(board);
			const g = netgraph.graph(board, c);
			const q = query || {};
			if (q.what === "net") {
				return g.net(q.net);
			}
			if (q.what === "pin") {
				return g.pin(q.pin);
			}
			if (q.what === "neighbors") {
				return g.neighbors(q.ref, q.avoid);
			}
			if (q.what === "path") {
				return g.path(q.from, q.to, q.avoid);
			}
			if (q.what === "search") {
				return g.search(q.text || "");
			}
			if (q.what === "nets" || !q.what) {
				return {
					nets: c.nets.map((n) => ({ name: n.name, aliases: n.aliases, pins: n.pins.length, testpoints: n.testpoints.length, auto: n.auto })),
					unconnected: c.unconnected
				};
			}
			throw new Error("what: nets | net | pin | neighbors | path | search");
		},

		netlist: (name, format) => {
			if (format && ["json", "csv", "kicad"].indexOf(format) === -1) {
				throw new Error("format: json | csv | kicad");
			}
			const board = boards.get(name);
			return netgraph.netlist(board, conn(board), format);
		},

		// ---- rendered view for the AI ------------------------------------------

		/**
		 * Render a board region from one layer as PNG, with the traced geometry
		 * drawn on top. For PDF layers the region is re-rendered from the PDF at
		 * the needed resolution, so zoomed crops stay sharp.
		 * @param {{x: number, y: number, w: number, h: number, layer: string, maxPx: number, overlay: boolean, net: string}} region
		 * @returns {Promise<{png: Buffer, width: number, height: number, layer: string, toBoard: number[]}>}
		 *   toBoard maps output pixels to board coordinates
		 */
		view: (name, region) => {
			const board = boards.get(name);
			const visible = board.layers.filter((l) => l.visible);
			const layer = region.layer ? findLayer(board, region.layer) : visible[visible.length - 1] || board.layers[board.layers.length - 1];
			if (!layer) {
				return Promise.reject(new Error("board " + name + " has no layers"));
			}
			const inv = affine.invert(layer.matrix);
			const rect = region.w && region.h ? { x: num(region.x, "x"), y: num(region.y, "y"), w: num(region.w, "w"), h: num(region.h, "h") }
				: affine.boundsOf(layer.matrix, { x: 0, y: 0, w: layer.width, h: layer.height });
			const box = affine.boundsOf(inv, rect);
			const x0 = Math.max(0, Math.floor(box.x));
			const y0 = Math.max(0, Math.floor(box.y));
			const x1 = Math.min(layer.width, Math.ceil(box.x + box.w));
			const y1 = Math.min(layer.height, Math.ceil(box.y + box.h));
			if (x1 <= x0 || y1 <= y0) {
				return Promise.reject(new Error("region is outside layer " + layer.id));
			}
			const maxPx = Math.min(4096, region.maxPx || MAX_VIEW_PX);
			let zoom = maxPx / Math.max(x1 - x0, y1 - y0);
			const file = path.join(assetDir(name), layer.file);
			let render;
			if (layer.kind === "pdf" && layer.source) {
				zoom = Math.min(zoom, MAX_VIEW_DPI / layer.dpi);
				const dpi = layer.dpi * zoom;
				const prefix = path.join(assetDir(name), ".view-" + process.pid + "-" + Date.now());
				render = pdf.renderBuffer(path.join(assetDir(name), layer.source.pdf), layer.source.page, dpi, prefix,
					{ x: x0 * zoom, y: y0 * zoom, w: (x1 - x0) * zoom, h: (y1 - y0) * zoom });
			} else {
				zoom = Math.min(zoom, 8);
				render = raster.crop(file, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, zoom);
			}
			// output px → layer px → board
			const outToLayer = [1 / zoom, 0, 0, 1 / zoom, x0, y0];
			const toBoard = affine.multiply(layer.matrix, outToLayer);
			const toOut = affine.invert(toBoard);
			return render.then((png) => {
				const size = raster.sniff(png);
				const items = region.overlay === false ? [] : overlayItems(board, conn(board), toOut, region.net);
				return raster.overlay(png, items).then((out) => ({
					png: out, width: size.width, height: size.height, layer: layer.id, toBoard: toBoard.map((v) => Math.round(v * 1e6) / 1e6)
				}));
			});
		}
	};

	// ---- ops -------------------------------------------------------------------

	const findIn = (board, kind, id) => {
		const item = board[COLLECTIONS[kind]].find((x) => x.id === id);
		if (!item) {
			throw new Error("unknown " + kind + ": " + id);
		}
		return item;
	};

	const fields = {
		component: (o, into) => {
			const c = into;
			["value", "footprint", "notes"].forEach((k) => {
				if (o[k] !== undefined) {
					c[k] = String(o[k]).slice(0, 200);
				}
			});
			if (o.side !== undefined) {
				c.side = side(o.side);
			}
			if (o.box !== undefined) {
				if (!Array.isArray(o.box) || o.box.length !== 4) {
					throw new Error("box: [x, y, w, h]");
				}
				c.box = o.box.map((v, i) => coord(v, "box[" + i + "]"));
			}
			if (o.outline !== undefined) {
				c.outline = (o.outline || []).map((p, i) => point(p, "outline[" + i + "]"));
			}
			if (o.pins !== undefined) {
				c.pins = (o.pins || []).map((p) => pinOf(p));
			}
		},
		wire: (o, into) => {
			const w = into;
			if (o.points !== undefined) {
				if (!Array.isArray(o.points) || o.points.length < 2) {
					throw new Error("points: at least 2 [x, y]");
				}
				w.points = o.points.map((p, i) => point(p, "points[" + i + "]"));
			}
			if (o.side !== undefined) {
				w.side = side(o.side);
			}
			if (o.width !== undefined) {
				w.width = num(o.width, "width");
			}
			if (o.net !== undefined) {
				w.net = o.net ? String(o.net).slice(0, 64) : undefined;
			}
		},
		at: (o, into) => {
			const item = into;
			if (o.x !== undefined) {
				item.x = coord(o.x, "x");
			}
			if (o.y !== undefined) {
				item.y = coord(o.y, "y");
			}
			if (o.side !== undefined) {
				item.side = side(o.side);
			}
		}
	};
	fields.via = fields.at;
	fields.label = (o, into) => {
		fields.at(o, into);
		if (o.name !== undefined) {
			if (!String(o.name).trim()) {
				throw new Error("label needs a name");
			}
			into.name = String(o.name).trim().slice(0, 64);
		}
	};
	fields.testpoint = (o, into) => {
		fields.at(o, into);
		["channel", "unit", "notes"].forEach((k) => {
			if (o[k] !== undefined) {
				into[k] = String(o[k]).slice(0, 200);
			}
		});
		if (o.reading !== undefined) {
			into.reading = o.reading === null ? undefined : num(o.reading, "reading");
		}
	};
	fields.note = (o, into) => {
		fields.at(o, into);
		if (o.text !== undefined) {
			into.text = String(o.text).slice(0, 2000);
		}
	};

	const pinOf = (p) => {
		const pinName = String(p.name === undefined ? p.pin : p.name);
		if (!PIN_RE.test(pinName)) {
			throw new Error("pin names: letters, digits, _ + - / # $ ~ (max 16): " + pinName);
		}
		return { name: pinName, x: coord(p.x, "pin x"), y: coord(p.y, "pin y") };
	};

	const requireXY = (o, kind) => {
		if (o.x === undefined || o.y === undefined) {
			throw new Error(kind + " needs x and y");
		}
	};

	const applyOp = (board, o) => {
		const b = board;
		if (KINDS.indexOf(o.kind) === -1) {
			throw new Error("kind: " + KINDS.join(" | "));
		}
		if (["add", "update", "remove"].indexOf(o.op) === -1) {
			throw new Error("op: add | update | remove");
		}
		if (o.kind === "net") {
			const netName = String(o.name || o.id || "");
			if (!netName) {
				throw new Error("net needs a name");
			}
			if (o.op === "remove") {
				delete b.nets[netName];
			} else {
				b.nets[netName] = Object.assign({}, b.nets[netName], o.color !== undefined ? { color: String(o.color) } : {}, o.notes !== undefined ? { notes: String(o.notes) } : {});
			}
			return { op: o.op, kind: "net", id: netName };
		}
		if (o.kind === "pin") {
			const ref = String(o.component || o.ref || "");
			const comp = findIn(b, "component", ref);
			comp.pins = comp.pins || [];
			const pinName = String(o.name === undefined ? o.pin : o.name);
			const existing = comp.pins.find((p) => p.name === pinName);
			if (o.op === "remove") {
				if (!existing) {
					throw new Error("unknown pin " + ref + "." + pinName);
				}
				comp.pins = comp.pins.filter((p) => p !== existing);
			} else if (o.op === "add") {
				if (existing) {
					throw new Error("pin exists: " + ref + "." + pinName);
				}
				comp.pins.push(pinOf({ name: pinName, x: o.x, y: o.y }));
			} else {
				if (!existing) {
					throw new Error("unknown pin " + ref + "." + pinName);
				}
				Object.assign(existing, pinOf({ name: o.rename || pinName, x: o.x === undefined ? existing.x : o.x, y: o.y === undefined ? existing.y : o.y }));
			}
			return { op: o.op, kind: "pin", id: ref + "." + pinName };
		}
		const coll = COLLECTIONS[o.kind];
		if (o.op === "remove") {
			const item = findIn(b, o.kind, String(o.id));
			b[coll] = b[coll].filter((x) => x !== item);
			return { op: "remove", kind: o.kind, id: item.id };
		}
		if (o.op === "update") {
			const item = findIn(b, o.kind, String(o.id));
			fields[o.kind](o, item);
			if (o.kind === "component" && o.rename !== undefined && o.rename !== item.id) {
				if (!REF_RE.test(String(o.rename)) || b.components.some((c) => c.id === o.rename)) {
					throw new Error("bad or taken refdes: " + o.rename);
				}
				item.id = String(o.rename);
			}
			return { op: "update", kind: o.kind, id: item.id };
		}
		// add
		let id;
		if (o.kind === "component") {
			id = String(o.id || o.ref || "");
			if (!REF_RE.test(id)) {
				throw new Error("refdes: letters, digits, _ + - / # $ (max 32)");
			}
		} else {
			id = o.id === undefined ? nextId(b, ID_PREFIX[o.kind]) : String(o.id);
			if (!REF_RE.test(id)) {
				throw new Error("ids: letters, digits, _ + - / # $ (max 32)");
			}
		}
		if (b[coll].some((x) => x.id === id)) {
			throw new Error(o.kind + " exists: " + id);
		}
		if (o.kind === "wire" && o.points === undefined) {
			throw new Error("wire needs points");
		}
		if (["via", "label", "testpoint", "note"].indexOf(o.kind) !== -1) {
			requireXY(o, o.kind);
		}
		if (o.kind === "label" && !o.name) {
			throw new Error("label needs a name");
		}
		const item = { id: id };
		if (o.kind === "component") {
			item.pins = [];
		}
		fields[o.kind](o, item);
		b[coll].push(item);
		return { op: "add", kind: o.kind, id: id };
	};

	// ImageMagick draw primitives for the traced geometry, in output pixels
	const overlayItems = (board, c, toOut, highlightNet) => {
		const pt = (p) => {
			const q = affine.apply(toOut, p);
			return q[0].toFixed(1) + "," + q[1].toFixed(1);
		};
		const lit = new Set();
		if (highlightNet) {
			const net = c.nets.find((n) => n.name === highlightNet || n.aliases.indexOf(highlightNet) !== -1);
			if (net) {
				net.wires.forEach((w) => lit.add("w:" + w));
				net.pins.forEach((p) => lit.add("p:" + p));
			}
		}
		const quote = (s) => "'" + String(s).replace(/[\\']/g, "") + "'";
		const items = [];
		board.wires.forEach((w) => {
			items.push({ stroke: lit.has("w:" + w.id) ? HIGHLIGHT : "#00c8ff", width: 2, draw: "polyline " + w.points.map(pt).join(" ") });
		});
		board.components.forEach((comp) => {
			if (comp.box) {
				const b = comp.box;
				items.push({ stroke: "#ffb000", width: 1.5, draw: "polygon " + [[b[0], b[1]], [b[0] + b[2], b[1]], [b[0] + b[2], b[1] + b[3]], [b[0], b[1] + b[3]]].map(pt).join(" ") });
				items.push({ fill: "#ffb000", draw: "text " + pt([b[0], b[1]]) + " " + quote(comp.id) });
			}
			(comp.pins || []).forEach((p) => {
				const q = affine.apply(toOut, [p.x, p.y]);
				const on = lit.has("p:" + comp.id + "." + p.name);
				items.push({ stroke: on ? HIGHLIGHT : "#ff5050", fill: on ? HIGHLIGHT : "none", width: 1.5,
					draw: "circle " + q[0].toFixed(1) + "," + q[1].toFixed(1) + " " + (q[0] + 4).toFixed(1) + "," + q[1].toFixed(1) });
			});
		});
		board.vias.forEach((v) => {
			const q = affine.apply(toOut, [v.x, v.y]);
			items.push({ stroke: "#50fa7b", width: 1.5, draw: "circle " + q[0].toFixed(1) + "," + q[1].toFixed(1) + " " + (q[0] + 3).toFixed(1) + "," + q[1].toFixed(1) });
		});
		board.labels.concat(board.testpoints).forEach((l) => {
			items.push({ fill: "#50fa7b", draw: "text " + pt([l.x, l.y]) + " " + quote(l.name || l.id) });
		});
		return items;
	};

	return boards;
};

module.exports = {
	create: create,
	parsePages: parsePages
};
