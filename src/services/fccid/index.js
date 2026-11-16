// FCC ID lookups: filings, frequencies/power and exhibits (photos, block
// diagrams, schematics, test reports, manuals) from fccid.io, which mirrors
// the FCC's public equipment authorization records. The FCC's own EAS pages
// (apps.fcc.gov) answer scripts with 403 (Akamai), so they are only linked.
//
// Polite: identifies as mailab, 1.5 s between requests, pages cached in
// DATA_DIR/cache/fccid (1 day; documents 7 days).

const path = require("path");
const config = require("../../config");
const http = require("../http");
const parse = require("./parse");

const MIN_INTERVAL_MS = 1500;
const PAGE_TTL_MS = 24 * 3600 * 1000;
const DOCUMENT_TTL_MS = 7 * 24 * 3600 * 1000;
const PAGE_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_DOCUMENT_MAX_BYTES = 30 * 1024 * 1024;
// 3-character (pre-2013) or 5-character (2xxxx) grantee codes
const GRANTEE_RE = /^([A-Z0-9]{3}|2[A-Z0-9]{4})$/;
const FCC_ID_RE = /^[A-Z0-9][A-Z0-9-]{3,}$/;

const fccid = {
	_client: null,
	_clientDir: null,

	// rebuilt when DATA_DIR changes (tests point it at temp dirs)
	_http: () => {
		const dir = path.join(config.get("DATA_DIR"), "cache", "fccid");
		if (!fccid._client || fccid._clientDir !== dir) {
			fccid._client = http.create({ name: "fccid.io", cacheDir: dir, ttlMs: PAGE_TTL_MS, minIntervalMs: fccid._minIntervalMs, transport: fccid._transport });
			fccid._clientDir = dir;
		}
		return fccid._client;
	},

	// injectable for tests
	_transport: undefined,
	_minIntervalMs: MIN_INTERVAL_MS,

	_page: (pathOrUrl, accept) => {
		return Promise.resolve()
			.then(() => fccid._http().text(fccid._url(pathOrUrl), { maxBytes: PAGE_MAX_BYTES, accept: accept }))
			.then((r) => r.text);
	},

	// only fccid.io URLs (or paths on it) are fetched
	_url: (pathOrUrl) => {
		const value = String(pathOrUrl || "").trim();
		let u;
		try {
			u = new URL(value, parse.BASE + "/");
		} catch (_err) {
			throw Object.assign(new Error("bad URL: " + value), { status: 400 });
		}
		if (!/^https?:$/.test(u.protocol) || !/(^|\.)fccid\.io$/i.test(u.hostname)) {
			throw Object.assign(new Error("only fccid.io URLs are fetched: " + value), { status: 400 });
		}
		return "https://" + u.hostname + u.pathname + u.search;
	},

	/**
	 * Normalize an FCC ID: upper case, no spaces; fccid.io accepts it with or
	 * without the dash between grantee and product code.
	 */
	normalize: (id) => String(id || "").toUpperCase().replace(/\s+/g, "").replace(/^FCC\s*ID[:\s]*/i, ""),

	/**
	 * One FCC ID: description, grantee, frequencies, output power, exhibits.
	 * An unknown ID answers {notFound: true, matches: [...similar IDs]}.
	 */
	lookup: (id) => {
		const norm = fccid.normalize(id);
		if (!FCC_ID_RE.test(norm)) {
			return Promise.reject(Object.assign(new Error("not an FCC ID: " + id), { status: 400 }));
		}
		// fccid.io answers 300 Multiple Choices for "possible matches"
		return fccid._page("/" + norm, [200, 300]).then((page) => {
			if (parse.isMatchesPage(page)) {
				return { fccId: norm, notFound: true, matches: parse.parseMatches(page) };
			}
			return parse.parseDevice(page);
		});
	},

	/**
	 * Grantee (company) by its code: name, address, its FCC IDs.
	 */
	grantee: (code) => fccid._page("/" + fccid.normalize(code)).then(parse.parseGrantee),

	/**
	 * Free-text search (company, model, product code, document text).
	 */
	search: (query) => {
		const q = String(query || "").trim();
		if (!q) {
			return Promise.reject(Object.assign(new Error("empty query"), { status: 400 }));
		}
		return fccid._page("/search?q=" + encodeURIComponent(q)).then(parse.parseSearch);
	},

	/**
	 * Pick the right lookup for a query: FCC ID → filing, grantee code →
	 * company, anything else → search. Unknown IDs fall back to search.
	 * @returns {Promise<{kind: string}>} kind: device | grantee | search
	 */
	find: (query) => {
		const norm = fccid.normalize(query);
		if (GRANTEE_RE.test(norm)) {
			return fccid.grantee(norm).then((g) => Object.assign({ kind: "grantee" }, g));
		}
		if (FCC_ID_RE.test(norm) && /\d/.test(norm) && !/\s/.test(String(query).trim())) {
			return fccid.lookup(norm).then((device) => {
				if (!device.notFound) {
					return Object.assign({ kind: "device" }, device);
				}
				return fccid.search(query).then((s) => Object.assign({ kind: "search", similar: device.matches }, s));
			});
		}
		return fccid.search(query).then((s) => Object.assign({ kind: "search" }, s));
	},

	/**
	 * Exhibits of an FCC ID with confidentiality flags.
	 */
	exhibits: (id) => {
		return fccid.lookup(id).then((device) => {
			if (device.notFound) {
				throw Object.assign(new Error("FCC ID " + device.fccId + " not found; similar: " + device.matches.map((m) => m.fccId).join(", ")), { status: 404 });
			}
			return {
				fccId: device.fccId,
				description: device.description,
				grantee: device.grantee,
				confidentiality: device.confidentiality,
				exhibits: device.exhibits
			};
		});
	},

	/**
	 * Exhibit (document) details: file URL, preview PNG, size, pages.
	 * @param {string} url exhibit page URL or path from `exhibits`
	 */
	exhibit: (url) => fccid._page(url).then(parse.parseExhibit),

	/**
	 * Resolve {url} or {fccId, type, index} to an exhibit page URL.
	 * type matches the exhibit type or title, case-insensitive substring
	 * (e.g. "internal photo", "schematic", "block diagram").
	 */
	resolve: (ref) => {
		if (ref.url) {
			return Promise.resolve(ref.url);
		}
		if (!ref.fccId) {
			return Promise.reject(Object.assign(new Error("give url, or fccId (+ type / index)"), { status: 400 }));
		}
		return fccid.exhibits(ref.fccId).then((list) => {
			const wanted = String(ref.type || "").toLowerCase();
			const matching = list.exhibits.filter((e) => !wanted || (e.type + " " + e.title).toLowerCase().indexOf(wanted) !== -1);
			const pick = matching[ref.index || 0];
			if (!pick) {
				throw Object.assign(new Error("no exhibit" + (wanted ? " matching \"" + ref.type + "\"" : "") + " for " + list.fccId), { status: 404 });
			}
			if (!pick.available) {
				throw Object.assign(new Error("\"" + pick.title + "\" (" + pick.type + ") is not public: " + pick.status + " (held confidential by the FCC)"), { status: 404 });
			}
			return pick.url;
		});
	},

	/**
	 * Download an exhibit's file.
	 * @param {{url: string, fccId: string, type: string, index: number, maxBytes: number}} ref
	 * @returns {Promise<{exhibit: Object, data: Buffer, mime: string}>}
	 */
	download: (ref) => {
		const maxBytes = ref.maxBytes || config.getNumber("FCCID_MAX_BYTES") || DEFAULT_DOCUMENT_MAX_BYTES;
		return fccid.resolve(ref)
			.then((url) => fccid.exhibit(url))
			.then((exhibit) => {
				if (!exhibit.fileUrl) {
					throw Object.assign(new Error("no downloadable file on the exhibit page (" + (exhibit.title || "unknown") + ")"), { status: 404 });
				}
				if (exhibit.bytes && exhibit.bytes > maxBytes) {
					throw Object.assign(new Error(exhibit.title + " is " + exhibit.bytes + " bytes, over the " + maxBytes + " byte cap"), { status: 413 });
				}
				return fccid._http().get(fccid._url(exhibit.fileUrl), { maxBytes: maxBytes, cache: DOCUMENT_TTL_MS }).then((r) => {
					return { exhibit: exhibit, data: r.body, mime: (r.contentType || "application/octet-stream").split(";")[0] };
				});
			});
	},

	/**
	 * First-page PNG preview fccid.io renders for PDF exhibits (thumbnails).
	 */
	preview: (url) => {
		return fccid.exhibit(url).then((exhibit) => {
			if (!exhibit.previewUrl) {
				throw Object.assign(new Error("no preview for this exhibit"), { status: 404 });
			}
			return fccid._http().get(fccid._url(exhibit.previewUrl), { maxBytes: PAGE_MAX_BYTES, cache: DOCUMENT_TTL_MS });
		}).then((r) => ({ data: r.body, mime: (r.contentType || "image/png").split(";")[0] }));
	}
};

module.exports = fccid;
