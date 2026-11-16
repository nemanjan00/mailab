// Datasheets: find candidate PDFs online (providers.js), keep chosen ones
// in a local DB with their text (library.js), search it with page refs and
// render pages for the AI to read pinout diagrams and register tables.

const path = require("path");
const config = require("../../config");
const http = require("../http");
const providers = require("./providers");
const libraryModule = require("./library");

const MIN_INTERVAL_MS = 1000;
const PAGE_TTL_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const LOCAL_LIMIT = 10;

const datasheets = {
	_state: null,

	// injectable for tests
	_transport: undefined,
	_minIntervalMs: MIN_INTERVAL_MS,

	// http client + library for the current DATA_DIR (tests switch it)
	_get: () => {
		const dataDir = config.get("DATA_DIR");
		if (!datasheets._state || datasheets._state.dataDir !== dataDir) {
			const client = http.create({ name: "datasheets", cacheDir: path.join(dataDir, "cache", "datasheets"), ttlMs: PAGE_TTL_MS, minIntervalMs: datasheets._minIntervalMs, transport: datasheets._transport });
			datasheets._state = { dataDir: dataDir, client: client, library: libraryModule.create(path.join(dataDir, "datasheets")) };
		}
		providers.use(datasheets._state.client);
		return datasheets._state;
	},

	library: () => datasheets._get().library,

	providers: () => providers.list(),

	/**
	 * Local DB entries matching a part / text, plus online candidates.
	 * @param {string} query part number (or words for the local DB)
	 * @param {{online: boolean, providers: string[]}} [options]
	 */
	search: (query, options) => {
		const opts = options || {};
		const q = String(query || "").trim();
		if (!q) {
			return Promise.reject(Object.assign(new Error("empty query"), { status: 400 }));
		}
		const library = datasheets.library();
		const needle = q.toLowerCase().replace(/[^a-z0-9]/g, "");
		// documents whose part/title contain the query, then full-text hits
		const byName = library.list().filter((m) => [m.part, m.title, m.manufacturer].join(" ").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/ /g, "").indexOf(needle) !== -1);
		let text;
		try {
			text = library.find({ query: q, limit: LOCAL_LIMIT });
		} catch (_err) {
			// a query of only punctuation / 1-letter words has no tokens
			text = [];
		}
		const local = byName.map((m) => Object.assign({ match: "name" }, m)).concat(text.filter((h) => !byName.some((m) => m.id === h.id)).map((h) => Object.assign({ match: "text", page: h.page, snippets: h.snippets }, library.get(h.id))));
		if (opts.online === false) {
			return Promise.resolve({ query: q, local: local, online: [], providers: [] });
		}
		return providers.search(q, opts.providers).then((online) => {
			// mark candidates already in the DB
			const known = library.list();
			const results = online.results.map((r) => {
				const have = known.find((m) => m.url === r.url);
				return have ? Object.assign({ inLibrary: have.id }, r) : r;
			});
			return { query: q, local: local.slice(0, LOCAL_LIMIT * 2), online: results, providers: online.providers };
		});
	},

	/**
	 * Download a datasheet PDF into the local DB.
	 * @param {{url: string, part: string, manufacturer: string, title: string, source: string}} info
	 */
	fetch: (info) => {
		const url = String(info.url || "");
		if (!/^https?:\/\//i.test(url)) {
			return Promise.reject(Object.assign(new Error("give an http(s) URL of the PDF"), { status: 400 }));
		}
		const state = datasheets._get();
		const known = state.library.list().find((m) => m.url === url);
		if (known) {
			return Promise.resolve(Object.assign({ existing: true }, known));
		}
		const maxBytes = config.getNumber("DATASHEET_MAX_BYTES") || DEFAULT_MAX_BYTES;
		// the PDF lives in the library: no second copy in the http cache
		return state.client.get(url, { maxBytes: maxBytes, cache: false }).then((r) => {
			return state.library.add(r.body, {
				part: info.part, manufacturer: info.manufacturer, title: info.title, url: url, source: info.source || new URL(url).hostname
			});
		});
	},

	/**
	 * Import PDF bytes (a lab blob, an upload) into the local DB.
	 */
	importPdf: (data, info) => datasheets.library().add(data, Object.assign({ source: "import" }, info || {})),

	find: (q) => datasheets.library().find(q || {}),

	render: (id, page, dpi) => datasheets.library().render(id, page, dpi)
};

module.exports = datasheets;
