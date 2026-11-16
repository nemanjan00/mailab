// Research pane: datasheet search (local DB + online providers), the local
// datasheet DB with a rendered page viewer and full-text find, and FCC ID
// lookups with the exhibit list (preview thumbnails, download into the lab).

import { el, list, state, when } from "@nemanjan00/qrp";
import { empty, pane } from "../sdk/index.js";

const KINDS = ["", "pinout", "registers", "ratings", "package", "timing"];
const VIEW_DPI = 110;

const enc = encodeURIComponent;

const link = (url, label) => el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, label || url);

export default pane((ctx, p) => {
	const config = p.pane.config || {};
	const view = state({
		tab: config.fccId && !config.query ? "fcc" : "ds",
		error: "",
		busy: "",
		// datasheets
		query: config.query || "",
		online: true,
		library: [],
		providers: [],
		results: null,
		findQuery: "",
		findKind: "",
		hits: null,
		open: null,
		page: 1,
		// fcc
		fccQuery: config.fccId || "",
		fcc: null,
		previews: {},
		fetched: {}
	});

	const fail = (err) => {
		view.error = err.message;
		view.busy = "";
	};
	const busy = (label, promise) => {
		view.error = "";
		view.busy = label;
		return promise.then((r) => {
			view.busy = "";
			return r;
		}, fail);
	};

	// ---- datasheets -------------------------------------------------------

	const loadLibrary = () => ctx.api("GET", "/datasheets").then((r) => {
		view.library = r.items;
		view.providers = r.providers;
	}, fail);

	const search = () => {
		if (!view.query.trim()) {
			return;
		}
		busy("searching " + view.query + "…", ctx.api("GET", "/datasheets/search?q=" + enc(view.query) + (view.online ? "" : "&online=0"))).then((r) => {
			if (r) {
				view.results = Object.freeze(r);
			}
		});
	};

	const openDoc = (id, page) => {
		const meta = view.library.find((m) => m.id === id);
		view.open = meta ? Object.freeze(Object.assign({}, meta)) : Object.freeze({ id: id, pages: 0 });
		view.page = page || 1;
	};

	const addDoc = (r) => {
		busy("downloading " + (r.part || r.url) + "…", ctx.api("POST", "/datasheets/fetch", { url: r.url, part: r.part, manufacturer: r.manufacturer, title: r.description }))
			.then((meta) => {
				if (meta) {
					return loadLibrary().then(() => openDoc(meta.id, 1));
				}
				return null;
			});
	};

	const find = () => {
		if (!view.findQuery.trim() && !view.findKind) {
			return;
		}
		const id = view.open ? "&id=" + enc(view.open.id) : "";
		busy("finding…", ctx.api("GET", "/datasheets/find?q=" + enc(view.findQuery) + "&kind=" + enc(view.findKind) + id)).then((hits) => {
			if (hits) {
				view.hits = Object.freeze(hits);
			}
		});
	};

	const remove = (meta) => {
		if (!confirm("Remove " + (meta.part || meta.id) + " from the datasheet DB?")) {
			return;
		}
		ctx.api("DELETE", "/datasheets/" + enc(meta.id)).then(() => {
			if (view.open && view.open.id === meta.id) {
				view.open = null;
			}
			return loadLibrary();
		}, fail);
	};

	const docRow = (m) => el("tr", {},
		el("td", { class: "mono" }, el("a", { href: "#", onclick: (e) => {
			e.preventDefault();
			openDoc(m.id, m.page || 1);
		} }, m.part || m.id)),
		el("td", {}, m.manufacturer || ""),
		el("td", { class: "muted" }, m.title || ""),
		el("td", { class: "num" }, m.page ? "p." + m.page : String(m.pages || "")),
		el("td", { class: "muted ds-snip" }, (m.snippets || []).join(" … ")),
		el("td", {}, el("button", { class: "icon", title: "remove", onclick: () => remove(m) }, "✕")));

	const docTable = (rows) => el("table", { class: "ds-table" },
		el("thead", {}, el("tr", {}, ...["part", "manufacturer", "title", "pages", "", ""].map((h) => el("th", {}, h)))),
		el("tbody", {}, list(rows, (m) => m.id + ":" + (m.page || ""), docRow)));

	const onlineTable = () => el("table", { class: "ds-table" },
		el("thead", {}, el("tr", {}, ...["provider", "part", "manufacturer", "description", "pdf", ""].map((h) => el("th", {}, h)))),
		el("tbody", {}, list(() => view.results.online, (r) => r.url, (r) => el("tr", {},
			el("td", { class: "muted" }, r.provider + (r.verified ? " ✓" : "")),
			el("td", { class: "mono" }, r.part || ""),
			el("td", {}, r.manufacturer || ""),
			el("td", { class: "muted" }, r.description || ""),
			el("td", { class: "ds-url" }, link(r.url, r.url.replace(/^https?:\/\//, ""))),
			el("td", {}, r.inLibrary
				? el("button", { onclick: () => openDoc(r.inLibrary, 1) }, "open")
				: el("button", { class: "primary", onclick: () => addDoc(r) }, "add to DB"))))));

	const viewer = () => {
		const doc = view.open;
		const total = doc.pages || 0;
		const go = (n) => {
			view.page = Math.max(1, total ? Math.min(total, n) : n);
		};
		return el("div", { class: "ds-viewer" },
			el("div", { class: "toolbar pad" },
				el("b", {}, doc.part || doc.id), el("span", { class: "muted" }, doc.manufacturer || ""),
				el("button", { onclick: () => go(view.page - 1) }, "‹"),
				el("input", { class: "ds-pageno", value: () => String(view.page), onchange: (e) => go(Number(e.target.value) || 1) }),
				el("span", { class: "muted" }, "/ " + (total || "?")),
				el("button", { onclick: () => go(view.page + 1) }, "›"),
				link("/api/datasheets/" + enc(doc.id) + "/pdf", "PDF"),
				doc.url ? link(doc.url, "source") : "",
				el("button", { class: "icon", title: "close", onclick: () => {
					view.open = null;
				} }, "✕")),
			el("div", { class: "ds-page" }, () => el("img", {
				src: "/api/datasheets/" + enc(doc.id) + "/page/" + view.page + "?dpi=" + VIEW_DPI,
				alt: "page " + view.page
			})));
	};

	const datasheetsTab = () => el("div", { class: "ds-tab" },
		el("div", { class: "toolbar pad" },
			el("input", { placeholder: "part number (NE555, STM32F103C8, ESP32-WROOM-32)", value: () => view.query, oninput: (e) => {
				view.query = e.target.value;
			}, onkeydown: (e) => {
				if (e.key === "Enter") {
					search();
				}
			} }),
			el("label", { class: "muted" }, el("input", { type: "checkbox", checked: () => view.online, onchange: (e) => {
				view.online = e.target.checked;
			} }), " online"),
			el("button", { class: "primary", onclick: search }, "search")),
		el("div", { class: "toolbar pad" },
			el("input", { placeholder: () => (view.open ? "find in " + (view.open.part || view.open.id) : "find in the local DB"), value: () => view.findQuery, oninput: (e) => {
				view.findQuery = e.target.value;
			}, onkeydown: (e) => {
				if (e.key === "Enter") {
					find();
				}
			} }),
			el("select", { onchange: (e) => {
				view.findKind = e.target.value;
			} }, ...KINDS.map((k) => el("option", { value: k }, k || "any section"))),
			el("button", { onclick: find }, "find")),
		when(() => view.hits, () => el("div", { class: "ds-hits pad" },
			el("div", { class: "muted" }, () => view.hits.length + " page hits ", el("a", { href: "#", onclick: (e) => {
				e.preventDefault();
				view.hits = null;
			} }, "clear")),
			list(() => view.hits, (h) => h.id + "#" + h.page, (h) => el("div", { class: "ds-hit", onclick: () => openDoc(h.id, h.page) },
				el("span", { class: "mono" }, (h.part || h.id) + " p." + h.page), " ",
				el("span", { class: "muted" }, h.snippets.join(" … ")))))),
		when(() => view.open && view.open.id, () => viewer()),
		when(() => view.results, () => el("div", { class: "pad" },
			el("h4", {}, () => "local DB: " + view.results.local.length),
			when(() => view.results.local.length, () => docTable(() => view.results.local), () => el("div", { class: "muted" }, "nothing local for " + view.results.query)),
			el("h4", {}, () => "online: " + view.results.online.length),
			el("div", { class: "muted" }, () => view.results.providers.map((pr) => pr.name + " " + (pr.error ? "✗ " + pr.error : pr.count)).join(" · ")),
			when(() => view.results.online.length, onlineTable))),
		el("div", { class: "pad" },
			el("h4", {}, () => "datasheet DB (" + view.library.length + ")"),
			when(() => view.library.length, () => docTable(() => view.library), () => empty("empty: search a part and add a datasheet")),
			el("div", { class: "muted" }, () => "providers: " + view.providers.map((pr) => pr.name + (pr.enabled ? "" : " (off: " + pr.env + ")")).join(", "))));

	// ---- FCC ID -------------------------------------------------------------

	const lookup = (q) => {
		const query = (q || view.fccQuery).trim();
		if (!query) {
			return;
		}
		view.fccQuery = query;
		view.previews = {};
		busy("looking up " + query + "…", ctx.api("GET", "/fccid/search?q=" + enc(query))).then((r) => {
			if (r) {
				view.fcc = Object.freeze(r);
			}
		});
	};

	const preview = (ex) => {
		const next = Object.assign({}, view.previews);
		next[ex.url] = !next[ex.url];
		view.previews = next;
	};

	const toLab = (ex) => {
		busy("downloading " + ex.title + "…", ctx.api("POST", "/fccid/fetch", { url: ex.url })).then((r) => {
			if (r) {
				view.fetched = Object.assign({}, view.fetched, { [ex.url]: r.name + " (" + Math.round(r.bytes / 1024) + " KB)" });
			}
		});
	};

	const pick = (fccId) => el("a", { href: "#", class: "mono", onclick: (e) => {
		e.preventDefault();
		lookup(fccId);
	} }, fccId);

	const device = (d) => el("div", { class: "pad" },
		el("h3", {}, d.fccId + " ", el("span", { class: "muted" }, d.description || "")),
		el("div", {}, "grantee ", pick(d.grantee.code || ""), " ", d.grantee.name || "", " · latest ", d.latestApplication || "?", " · ", link(d.url, "fccid.io")),
		el("div", { class: "muted" }, [d.equipmentClass, d.modular, d.confidentiality.longTerm ? "long-term confidential" : "", d.confidentiality.shortTerm ? "short-term confidential" : ""].filter(Boolean).join(" · ")),
		el("table", { class: "ds-table" },
			el("thead", {}, el("tr", {}, el("th", {}, "frequency"), el("th", {}, "output W"), el("th", {}, "rules"))),
			el("tbody", {}, ...(d.authorizations.length ? d.authorizations : d.frequencies.map((f) => ({ frequency: f.range })))
				.map((a) => el("tr", {}, el("td", {}, a.frequency), el("td", { class: "num" }, a.outputWatts === undefined || a.outputWatts === null ? "" : String(a.outputWatts)), el("td", {}, a.rules || ""))))),
		el("h4", {}, "exhibits (" + d.exhibits.length + ")"),
		el("div", { class: "fcc-exhibits" }, ...d.exhibits.map((ex) => el("div", { class: "fcc-ex" + (ex.available ? "" : " muted") },
			el("div", { class: "fcc-ex-row" },
				el("span", { class: "fcc-type" }, ex.type),
				ex.url ? link(ex.url, ex.title) : el("span", {}, ex.title),
				el("span", { class: "muted" }, [ex.format, ex.size, ex.date].filter(Boolean).join(" ")),
				ex.available ? "" : el("span", { class: "state error" }, ex.status),
				el("span", { class: "usb-ctl" },
					ex.available ? el("button", { onclick: () => preview(ex) }, () => (view.previews[ex.url] ? "hide" : "preview")) : "",
					ex.available ? el("button", { onclick: () => toLab(ex) }, "to lab") : "",
					el("span", { class: "mono muted" }, () => view.fetched[ex.url] || ""))),
			when(() => view.previews[ex.url], () => el("img", { class: "fcc-thumb", loading: "lazy", src: "/api/fccid/preview?url=" + enc(ex.url), alt: ex.title }))))));

	const grantee = (g) => el("div", { class: "pad" },
		el("h3", {}, g.code + " ", el("span", { class: "muted" }, g.name || "")),
		el("div", { class: "muted" }, [g.address, g.registered && "registered " + g.registered, g.fccIdCount && g.fccIdCount + " FCC IDs"].filter(Boolean).join(" · ")),
		el("table", { class: "ds-table" }, el("tbody", {}, ...g.filings.map((f) => el("tr", {},
			el("td", {}, pick(f.fccId)), el("td", { class: "muted" }, f.date || ""), el("td", {}, f.description || ""), el("td", { class: "muted" }, f.purpose || ""))))));

	const searchResults = (s) => el("div", { class: "pad" },
		s.similar && s.similar.length ? el("div", {}, "no exact match; similar: ", ...s.similar.map((m) => el("span", {}, pick(m.fccId), " "))) : "",
		s.companies.length ? el("div", {}, "companies: ", ...s.companies.map((c) => el("span", {}, pick(c.code), " " + c.name + " · "))) : "",
		el("div", { class: "muted" }, s.total + " FCC IDs"),
		el("table", { class: "ds-table" }, el("tbody", {}, ...s.results.map((r) => el("tr", {},
			el("td", {}, pick(r.fccId)), el("td", {}, r.description || ""), el("td", { class: "muted" }, r.company || ""), el("td", { class: "muted" }, r.frequencies || ""), el("td", { class: "muted" }, r.latestFiling || ""))))));

	const fccTab = () => el("div", { class: "ds-tab" },
		el("div", { class: "toolbar pad" },
			el("input", { placeholder: "FCC ID (2AC7Z-ESP32WROOM32E), grantee code or company", value: () => view.fccQuery, oninput: (e) => {
				view.fccQuery = e.target.value;
			}, onkeydown: (e) => {
				if (e.key === "Enter") {
					lookup();
				}
			} }),
			el("button", { class: "primary", onclick: () => lookup() }, "look up")),
		() => {
			const r = view.fcc;
			if (!r) {
				return empty("FCC filings via fccid.io: description, frequencies, power, internal photos, block diagrams…");
			}
			if (r.kind === "device") {
				return device(r);
			}
			if (r.kind === "grantee") {
				return grantee(r);
			}
			return searchResults(r);
		});

	loadLibrary().then(() => {
		if (config.datasheet) {
			openDoc(config.datasheet, Number(config.page) || 1);
		}
	});
	if (config.query) {
		search();
	}
	if (config.fccId) {
		lookup(config.fccId);
	}

	const tab = (id, label) => el("button", { class: () => (view.tab === id ? "primary" : ""), onclick: () => {
		view.tab = id;
	} }, label);

	return el("div", { class: "datasheets" },
		el("div", { class: "toolbar pad" }, tab("ds", "datasheets"), tab("fcc", "FCC ID"),
			el("span", { class: "muted" }, () => view.busy)),
		when(() => view.error, () => el("div", { class: "error pad" }, () => view.error)),
		when(() => view.tab, (t) => (t === "fcc" ? fccTab() : datasheetsTab())));
});
