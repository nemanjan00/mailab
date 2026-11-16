// Local datasheet DB: DATA_DIR/datasheets/<id>/{datasheet.pdf, meta.json,
// pages.json}. Text comes from pdftotext (per page); full-text search uses an
// in-memory inverted index (token → document → pages), built on first use.

const fs = require("fs");
const path = require("path");
const createHash = require("crypto").createHash;
const pdf = require("../../utils/pdf");

const MIN_TOKEN = 2;
const SNIPPET_CHARS = 160;
const SNIPPETS_PER_PAGE = 2;
const DEFAULT_LIMIT = 20;
const RENDER_CACHE_DPIS = [72, 110, 150, 200, 300];

// what to look for when asked for a kind of section
const KINDS = {
	pinout: ["pin configuration", "pin description", "pin descriptions", "pin definitions", "pin functions", "pin assignment", "pinout", "pin out", "terminal functions", "pin name"],
	registers: ["register map", "register description", "register descriptions", "register summary", "memory map", "register address", "reset value", "bit field"],
	ratings: ["absolute maximum ratings", "recommended operating conditions", "electrical characteristics", "esd ratings", "thermal information"],
	package: ["package information", "mechanical data", "package outline", "land pattern", "footprint", "package dimensions"],
	timing: ["timing characteristics", "timing requirements", "switching characteristics", "timing diagram"]
};

const tokenize = (str) => (String(str || "").toLowerCase().match(/[a-z0-9_]+/g) || []).filter((t) => t.length >= MIN_TOKEN);

const slug = (str) => String(str || "datasheet").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "datasheet";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Snippets of `text` around matches of `re` (whitespace collapsed).
 */
const snippets = (text, re, max) => {
	const out = [];
	const global = new RegExp(re.source, "gi");
	let m;
	while ((m = global.exec(text)) !== null && out.length < max) {
		const start = Math.max(0, m.index - SNIPPET_CHARS / 2);
		const end = Math.min(text.length, m.index + m[0].length + SNIPPET_CHARS / 2);
		out.push((start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : ""));
		global.lastIndex = m.index + m[0].length + SNIPPET_CHARS / 2;
	}
	return out;
};

/**
 * @param {string} dir library root (DATA_DIR/datasheets)
 */
const create = (dir) => {
	// id -> {meta, pages: string[]} (pages loaded lazily)
	const docs = {};
	// token -> {id: Set(page numbers)}
	let index = null;

	const docDir = (id) => {
		if (!/^[a-z0-9-]+$/.test(id || "")) {
			throw Object.assign(new Error("bad datasheet id: " + id), { status: 400 });
		}
		return path.join(dir, id);
	};

	const load = () => {
		if (!fs.existsSync(dir)) {
			return;
		}
		fs.readdirSync(dir).forEach((id) => {
			const metaFile = path.join(dir, id, "meta.json");
			if (!docs[id] && fs.existsSync(metaFile)) {
				try {
					docs[id] = { meta: JSON.parse(fs.readFileSync(metaFile, "utf8")), pages: null };
				} catch (err) {
					console.error("datasheets: skipping " + id + ": " + err.message);
				}
			}
		});
	};

	const pagesOf = (id) => {
		const doc = docs[id];
		if (!doc.pages) {
			try {
				doc.pages = JSON.parse(fs.readFileSync(path.join(docDir(id), "pages.json"), "utf8"));
			} catch (_err) {
				doc.pages = [];
			}
		}
		return doc.pages;
	};

	const indexDoc = (id) => {
		pagesOf(id).forEach((text, i) => {
			tokenize(text).forEach((token) => {
				const postings = index[token] || (index[token] = {});
				(postings[id] || (postings[id] = new Set())).add(i + 1);
			});
		});
		// part number, title and manufacturer find the document on its first page
		tokenize([docs[id].meta.part, docs[id].meta.title, docs[id].meta.manufacturer].join(" ")).forEach((token) => {
			const postings = index[token] || (index[token] = {});
			(postings[id] || (postings[id] = new Set())).add(1);
		});
	};

	const ensureIndex = () => {
		load();
		if (!index) {
			index = {};
			Object.keys(docs).forEach(indexDoc);
		}
		return index;
	};

	const unindexDoc = (id) => {
		if (!index) {
			return;
		}
		Object.keys(index).forEach((token) => {
			delete index[token][id];
			if (!Object.keys(index[token]).length) {
				delete index[token];
			}
		});
	};

	const get = (id) => {
		load();
		if (!docs[id]) {
			throw Object.assign(new Error("unknown datasheet: " + id), { status: 404 });
		}
		return docs[id].meta;
	};

	const library = {
		dir: dir,
		KINDS: KINDS,

		list: () => {
			load();
			return Object.keys(docs).map((id) => docs[id].meta).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
		},

		get: get,

		file: (id) => {
			get(id);
			return path.join(docDir(id), "datasheet.pdf");
		},

		pageText: (id, page) => {
			get(id);
			const pages = pagesOf(id);
			const n = Number(page);
			if (!(n >= 1 && n <= pages.length)) {
				throw Object.assign(new Error(id + " has pages 1-" + pages.length), { status: 400 });
			}
			return pages[n - 1];
		},

		/**
		 * Store a PDF with its text. Same bytes twice → the existing entry.
		 * @param {Buffer} data
		 * @param {{part: string, manufacturer: string, title: string, url: string, source: string}} info
		 */
		add: (data, info) => {
			if (!pdf.isPdf(data)) {
				return Promise.reject(Object.assign(new Error("not a PDF (" + data.length + " bytes" + (/^\s*<(!doctype|html|\?xml)/i.test(data.subarray(0, 64).toString("latin1")) ? ", looks like HTML" : "") + "): the link may lead to an HTML page, a login or a captcha; download it in a browser and import the file"), { status: 415 }));
			}
			load();
			const sha256 = createHash("sha256").update(data).digest("hex");
			const existing = Object.keys(docs).find((id) => docs[id].meta.sha256 === sha256);
			if (existing) {
				return Promise.resolve(Object.assign({ existing: true }, docs[existing].meta));
			}
			const id = slug(info.part || info.title) + "-" + sha256.slice(0, 8);
			const target = docDir(id);
			fs.mkdirSync(target, { recursive: true });
			const file = path.join(target, "datasheet.pdf");
			fs.writeFileSync(file, data);
			return Promise.all([pdf.info(file).catch(() => ({ Pages: 0 })), pdf.pages(file)]).then((results) => {
				const pages = results[1];
				const meta = {
					id: id,
					part: info.part || null,
					manufacturer: info.manufacturer || null,
					title: info.title || results[0].Title || null,
					url: info.url || null,
					source: info.source || null,
					sha256: sha256,
					bytes: data.length,
					pages: results[0].Pages || pages.length,
					textChars: pages.reduce((n, p) => n + p.length, 0),
					addedAt: Date.now()
				};
				if (!meta.textChars) {
					meta.note = "no text layer (a scan?): full-text search finds nothing; read pages with datasheet_page";
				}
				fs.writeFileSync(path.join(target, "pages.json"), JSON.stringify(pages));
				fs.writeFileSync(path.join(target, "meta.json"), JSON.stringify(meta, null, 1));
				docs[id] = { meta: meta, pages: pages };
				if (index) {
					indexDoc(id);
				}
				return meta;
			}).catch((err) => {
				fs.rmSync(target, { recursive: true, force: true });
				throw err;
			});
		},

		remove: (id) => {
			get(id);
			unindexDoc(id);
			delete docs[id];
			fs.rmSync(docDir(id), { recursive: true, force: true });
			return { removed: id };
		},

		/**
		 * Full-text search with page refs.
		 * @param {Object} q
		 * @param {string} [q.query] words (all must be on the page) or a "quoted phrase"
		 * @param {string} [q.kind] pinout | registers | ratings | package | timing
		 * @param {string} [q.id] only this datasheet
		 * @param {number} [q.limit]
		 * @returns {Object[]} [{id, part, page, score, snippets}]
		 */
		find: (q) => {
			const idx = ensureIndex();
			const limit = q.limit || DEFAULT_LIMIT;
			const only = q.id ? [q.id] : null;
			if (q.id) {
				get(q.id);
			}
			const phrases = [];
			const query = String(q.query || "");
			// "quoted phrases" must appear verbatim
			const words = query.replace(/"([^"]+)"/g, (_m, phrase) => {
				phrases.push(phrase);
				return " ";
			});
			const tokens = tokenize(words);
			const kindPhrases = q.kind ? KINDS[q.kind] : null;
			if (q.kind && !kindPhrases) {
				throw Object.assign(new Error("unknown kind " + q.kind + " (" + Object.keys(KINDS).join(", ") + ")"), { status: 400 });
			}
			if (!tokens.length && !phrases.length && !kindPhrases) {
				throw Object.assign(new Error("give a query or a kind"), { status: 400 });
			}
			// candidate pages: AND over query tokens / phrase tokens; kinds are an OR
			const required = tokens.concat(tokenize(phrases.join(" ")));
			const pagesFor = (token) => idx[token] || {};
			let candidates = null;
			required.forEach((token) => {
				const postings = pagesFor(token);
				const next = {};
				Object.keys(postings).filter((id) => !only || only.indexOf(id) !== -1).forEach((id) => {
					postings[id].forEach((page) => {
						const key = id + "#" + page;
						if (!candidates || candidates[key]) {
							next[key] = true;
						}
					});
				});
				candidates = next;
			});
			if (!candidates) {
				// kind only: pages with any word of any kind phrase's first token
				candidates = {};
				kindPhrases.forEach((phrase) => {
					const postings = pagesFor(tokenize(phrase)[0]);
					Object.keys(postings).filter((id) => !only || only.indexOf(id) !== -1).forEach((id) => {
						postings[id].forEach((page) => {
							candidates[id + "#" + page] = true;
						});
					});
				});
			}
			const tokenRe = required.length ? new RegExp(required.map(escapeRe).join("|"), "i") : null;
			const phraseRes = phrases.map((p) => new RegExp(escapeRe(p).replace(/\s+/g, "\\s+"), "i"));
			const kindRes = (kindPhrases || []).map((p) => new RegExp("\\b" + escapeRe(p).replace(/\s+/g, "\\s+") + "\\b", "i"));
			const hits = Object.keys(candidates).map((key) => {
				const id = key.slice(0, key.lastIndexOf("#"));
				const page = Number(key.slice(key.lastIndexOf("#") + 1));
				const text = pagesOf(id)[page - 1] || "";
				if (phraseRes.some((re) => !re.test(text))) {
					return null;
				}
				const kindHits = kindRes.filter((re) => re.test(text));
				if (kindRes.length && !kindHits.length) {
					return null;
				}
				const lower = text.toLowerCase();
				const count = required.reduce((n, token) => n + (lower.split(token).length - 1), 0);
				// a kind phrase as a heading (short line of its own) marks the section itself
				const lines = text.split("\n");
				const headings = kindHits.filter((re) => lines.some((line) => line.trim().length < 70 && re.test(line) && /^\s*(\d+(\.\d+)*\.?\s+)?[A-Z]/.test(line))).length;
				// tables of contents / revision histories mention every section: demote them
				const leaders = lines.filter((line) => /\.{4,}\s*\d{1,3}\b/.test(line)).length;
				const toc = leaders >= 3 || /^\s*(table of )?contents\s*$/im.test(text) || /revision history/i.test(text) ? 0.4 : 1;
				const score = (kindHits.length * 10 + headings * 8 + phraseRes.length * 5 + Math.min(count, 50)) * toc;
				let re = tokenRe;
				if (kindHits.length) {
					re = kindHits[0];
				} else if (phraseRes.length) {
					re = phraseRes[0];
				}
				return {
					id: id,
					part: docs[id].meta.part,
					page: page,
					score: Math.round(score * 10) / 10,
					snippets: re ? snippets(text, re, SNIPPETS_PER_PAGE) : []
				};
			}).filter(Boolean);
			hits.sort((a, b) => b.score - a.score || a.page - b.page);
			return hits.slice(0, limit);
		},

		/**
		 * Render a page to PNG (cached next to the PDF).
		 * @returns {Promise<Buffer>}
		 */
		render: (id, page, dpi) => {
			const meta = get(id);
			const n = Math.floor(Number(page) || 1);
			if (meta.pages && (n < 1 || n > meta.pages)) {
				return Promise.reject(Object.assign(new Error(id + " has pages 1-" + meta.pages), { status: 400 }));
			}
			const res = Math.floor(Number(dpi) || pdf.DEFAULT_DPI);
			const cacheable = RENDER_CACHE_DPIS.indexOf(res) !== -1;
			const cached = path.join(docDir(id), "page-" + n + "-" + res + ".png");
			if (cacheable && fs.existsSync(cached)) {
				return Promise.resolve(fs.readFileSync(cached));
			}
			return pdf.render(path.join(docDir(id), "datasheet.pdf"), n, res).then((png) => {
				if (cacheable) {
					fs.writeFileSync(cached, png);
				}
				return png;
			});
		}
	};

	return library;
};

module.exports = {
	create: create,
	tokenize: tokenize,
	KINDS: KINDS
};
