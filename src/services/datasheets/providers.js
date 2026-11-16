// Online datasheet providers: part number → candidate datasheet PDFs.
//
// Keyless:
//  - manufacturer: probes a few manufacturers' stable datasheet URL patterns
//    (TI, onsemi, Diodes, Espressif, Raspberry Pi) and keeps the ones that
//    really are PDFs. Sites that refuse non-browser clients (ST, ADI,
//    Microchip, alldatasheet, LCSC) are not probed.
// Optional, enabled by env (disabled while unset):
//  - mouser (MOUSER_API_KEY), nexar/Octopart (NEXAR_CLIENT_ID/SECRET),
//    digikey (DIGIKEY_CLIENT_ID/SECRET), searxng (SEARXNG_URL, a SearXNG
//    instance with the JSON format enabled).
// The keyed providers follow the vendors' documented APIs but were not run
// against the live services (no keys here): treat their mapping as untested.

const config = require("../../config");

const PROBE_BYTES = 1024;
const SEARCH_TTL_MS = 7 * 24 * 3600 * 1000;
const NEGATIVE_TTL_MS = 24 * 3600 * 1000;
const MAX_RESULTS = 10;

// manufacturer URL patterns; when(pn) limits a pattern to plausible parts
const PATTERNS = [
	{ manufacturer: "Texas Instruments", url: (pn) => "https://www.ti.com/lit/ds/symlink/" + pn.toLowerCase() + ".pdf" },
	{ manufacturer: "onsemi", url: (pn) => "https://www.onsemi.com/download/data-sheet/pdf/" + pn.toLowerCase() + "-d.pdf" },
	{ manufacturer: "Diodes Inc.", url: (pn) => "https://www.diodes.com/assets/Datasheets/" + pn.toUpperCase() + ".pdf" },
	{ manufacturer: "Espressif", when: (pn) => /^esp/i.test(pn), url: (pn) => "https://documentation.espressif.com/" + pn.toLowerCase() + "_datasheet_en.pdf" },
	{ manufacturer: "Raspberry Pi", when: (pn) => /^rp\d/i.test(pn), url: (pn) => "https://datasheets.raspberrypi.com/" + pn.toLowerCase() + "/" + pn.toLowerCase() + "-datasheet.pdf" }
];

/**
 * Spellings to try: as given, and the base part without package / temperature /
 * reel suffixes (NE555P → NE555, LM358DR → LM358, TPS62130RGTR → TPS62130).
 */
const variants = (part) => {
	const pn = String(part || "").trim().replace(/\s+/g, "");
	const base = /^([A-Za-z]+[-_]?\d+[A-Za-z]?\d*)/.exec(pn);
	// letters + first digit group: a trailing package letter goes too (LM358N → LM358)
	const digits = /^([A-Za-z]+[-_]?\d+)/.exec(pn);
	const out = [pn, base && base[1], digits && digits[1]].filter((v) => v && v.length >= 3);
	return out.filter((v, i) => out.indexOf(v) === i);
};

// url -> time of a negative probe (not cached on disk by the http client)
const misses = {};

const providers = {
	_http: null,

	/**
	 * @param {Object} client src/services/http client
	 */
	use: (client) => {
		providers._http = client;
	},

	list: () => {
		return [
			{ name: "manufacturer", enabled: true, keyless: true, note: "TI, onsemi, Diodes, Espressif, Raspberry Pi URL patterns (verified as PDF)" },
			{ name: "mouser", enabled: Boolean(config.get("MOUSER_API_KEY")), env: "MOUSER_API_KEY" },
			{ name: "nexar", enabled: Boolean(config.get("NEXAR_CLIENT_ID") && config.get("NEXAR_CLIENT_SECRET")), env: "NEXAR_CLIENT_ID, NEXAR_CLIENT_SECRET" },
			{ name: "digikey", enabled: Boolean(config.get("DIGIKEY_CLIENT_ID") && config.get("DIGIKEY_CLIENT_SECRET")), env: "DIGIKEY_CLIENT_ID, DIGIKEY_CLIENT_SECRET" },
			{ name: "searxng", enabled: Boolean(config.get("SEARXNG_URL")), env: "SEARXNG_URL" }
		];
	},

	/**
	 * Is url a PDF? Reads only the first KB (Range request).
	 */
	probe: (url) => {
		if (misses[url] && Date.now() - misses[url] < NEGATIVE_TTL_MS) {
			return Promise.resolve(false);
		}
		return providers._http.get(url, { range: "bytes=0-" + (PROBE_BYTES - 1), peek: PROBE_BYTES, maxBytes: PROBE_BYTES * 64, cache: SEARCH_TTL_MS })
			.then((r) => {
				const ok = /pdf/i.test(r.contentType) || r.body.slice(0, PROBE_BYTES).indexOf("%PDF-") !== -1;
				if (!ok) {
					misses[url] = Date.now();
				}
				return ok;
			}, () => {
				misses[url] = Date.now();
				return false;
			});
	},

	manufacturer: (part) => {
		const candidates = variants(part).reduce((acc, pn) => {
			PATTERNS.filter((p) => !p.when || p.when(pn)).forEach((p) => {
				const url = p.url(pn);
				if (!acc.some((c) => c.url === url)) {
					acc.push({ manufacturer: p.manufacturer, part: pn, url: url });
				}
			});
			return acc;
		}, []);
		return Promise.all(candidates.map((c) => providers.probe(c.url).then((ok) => (ok ? c : null))))
			.then((found) => found.filter(Boolean).map((c) => ({
				provider: "manufacturer",
				part: c.part.toUpperCase(),
				manufacturer: c.manufacturer,
				description: null,
				url: c.url,
				verified: true
			})));
	},

	// Mouser Search API v1 (part number search)
	mouser: (part) => {
		const key = config.get("MOUSER_API_KEY");
		const body = JSON.stringify({ SearchByPartRequest: { mouserPartNumber: part, partSearchOptions: "None" } });
		return providers._http.request("https://api.mouser.com/api/v1/search/partnumber?apiKey=" + encodeURIComponent(key), {
			method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: body, cache: SEARCH_TTL_MS
		}).then((r) => {
			const data = JSON.parse(r.body.toString("utf8"));
			if (data.Errors && data.Errors.length) {
				throw new Error("mouser: " + data.Errors.map((e) => e.Message || e.Code).join("; "));
			}
			return ((data.SearchResults && data.SearchResults.Parts) || []).filter((p) => p.DataSheetUrl).map((p) => ({
				provider: "mouser",
				part: p.ManufacturerPartNumber,
				manufacturer: p.Manufacturer,
				description: p.Description || null,
				url: p.DataSheetUrl,
				pageUrl: p.ProductDetailUrl || null,
				verified: false
			}));
		});
	},

	_tokens: {},

	// OAuth2 client credentials; tokens kept in memory until shortly before expiry
	_token: (name, url, form) => {
		const cached = providers._tokens[name];
		if (cached && cached.expires > Date.now()) {
			return Promise.resolve(cached.token);
		}
		return providers._http.request(url, {
			method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), cache: false
		}).then((r) => {
			const data = JSON.parse(r.body.toString("utf8"));
			if (!data.access_token) {
				throw new Error(name + ": no access token (" + (data.error || "check the client id/secret") + ")");
			}
			providers._tokens[name] = { token: data.access_token, expires: Date.now() + Math.max(60, (data.expires_in || 600) - 60) * 1000 };
			return data.access_token;
		});
	},

	// Nexar (Octopart) GraphQL supply API
	nexar: (part) => {
		const query = "query($q: String!, $limit: Int) { supSearchMpn(q: $q, limit: $limit) { results { part { mpn shortDescription manufacturer { name } bestDatasheet { url } } } } }";
		return providers._token("nexar", "https://identity.nexar.com/connect/token", {
			grant_type: "client_credentials", client_id: config.get("NEXAR_CLIENT_ID"), client_secret: config.get("NEXAR_CLIENT_SECRET"), scope: "supply.domain"
		}).then((token) => providers._http.request("https://api.nexar.com/graphql", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer " + token },
			body: JSON.stringify({ query: query, variables: { q: part, limit: MAX_RESULTS } }),
			cache: SEARCH_TTL_MS
		})).then((r) => {
			const data = JSON.parse(r.body.toString("utf8"));
			if (data.errors && data.errors.length) {
				throw new Error("nexar: " + data.errors.map((e) => e.message).join("; "));
			}
			const results = (data.data && data.data.supSearchMpn && data.data.supSearchMpn.results) || [];
			return results.map((res) => res.part).filter((p) => p && p.bestDatasheet && p.bestDatasheet.url).map((p) => ({
				provider: "nexar",
				part: p.mpn,
				manufacturer: p.manufacturer ? p.manufacturer.name : null,
				description: p.shortDescription || null,
				url: p.bestDatasheet.url,
				verified: false
			}));
		});
	},

	// DigiKey Product Information API v4 (keyword search)
	digikey: (part) => {
		const clientId = config.get("DIGIKEY_CLIENT_ID");
		return providers._token("digikey", "https://api.digikey.com/v1/oauth2/token", {
			grant_type: "client_credentials", client_id: clientId, client_secret: config.get("DIGIKEY_CLIENT_SECRET")
		}).then((token) => providers._http.request("https://api.digikey.com/products/v4/search/keyword", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer " + token, "x-digikey-client-id": clientId },
			body: JSON.stringify({ Keywords: part, Limit: MAX_RESULTS }),
			cache: SEARCH_TTL_MS
		})).then((r) => {
			const data = JSON.parse(r.body.toString("utf8"));
			return (data.ExactMatches || []).concat(data.Products || []).filter((p) => p.DatasheetUrl).map((p) => ({
				provider: "digikey",
				part: p.ManufacturerProductNumber,
				manufacturer: p.Manufacturer ? p.Manufacturer.Name : null,
				description: p.Description ? p.Description.ProductDescription : null,
				url: p.DatasheetUrl.indexOf("//") === 0 ? "https:" + p.DatasheetUrl : p.DatasheetUrl,
				pageUrl: p.ProductUrl || null,
				verified: false
			}));
		});
	},

	// SearXNG metasearch (self-hosted or a public instance that allows JSON)
	searxng: (part) => {
		const base = config.get("SEARXNG_URL").replace(/\/+$/, "");
		const q = part + " datasheet filetype:pdf";
		return providers._http.get(base + "/search?format=json&q=" + encodeURIComponent(q), { cache: SEARCH_TTL_MS }).then((r) => {
			const data = JSON.parse(r.body.toString("utf8"));
			return (data.results || []).filter((res) => /\.pdf(\?|$)/i.test(res.url || "")).slice(0, MAX_RESULTS).map((res) => ({
				provider: "searxng",
				part: part,
				manufacturer: null,
				description: res.title || null,
				url: res.url,
				verified: false
			}));
		});
	},

	/**
	 * Query every enabled provider (or the named ones); one failing provider
	 * reports its error instead of failing the search.
	 * @param {string} part
	 * @param {string[]} [only] provider names
	 * @returns {Promise<{results: Object[], providers: Object[]}>}
	 */
	search: (part, only) => {
		const enabled = providers.list().filter((p) => p.enabled && (!only || !only.length || only.indexOf(p.name) !== -1));
		return Promise.all(enabled.map((p) => {
			return providers[p.name](part).then((results) => ({ name: p.name, results: results }), (err) => ({ name: p.name, results: [], error: err.message }));
		})).then((answers) => {
			const seen = {};
			const results = answers.reduce((acc, a) => acc.concat(a.results), []).filter((r) => {
				if (seen[r.url]) {
					return false;
				}
				seen[r.url] = true;
				return true;
			});
			return {
				results: results,
				providers: answers.map((a) => ({ name: a.name, count: a.results.length, error: a.error }))
			};
		});
	}
};

module.exports = Object.assign(providers, { variants: variants, PATTERNS: PATTERNS });
