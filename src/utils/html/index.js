// Tiny regex HTML helpers for scraping simple, table-shaped public pages
// (no DOM dependency). Good enough for server-rendered tables; not a parser.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", middot: "·", hellip: "…", copy: "©", reg: "®", deg: "°", micro: "µ", plusmn: "±", times: "×" };

const decode = (str) => {
	return String(str || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
		}
		const named = ENTITIES[code.toLowerCase()];
		return named === undefined ? whole : named;
	});
};

/**
 * Visible text of an HTML fragment, whitespace collapsed.
 */
const text = (html) => {
	return decode(String(html || "")
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
};

/**
 * First href in a fragment (decoded), or null.
 */
const href = (html) => {
	const m = /<a\b[^>]*\bhref="([^"]*)"/i.exec(html || "");
	return m ? decode(m[1]) : null;
};

/**
 * Table rows as arrays of cells {html, text, href, label}; header cells too
 * (th cells have header: true). label is the cell's data-label attribute.
 */
const rows = (html) => {
	const out = [];
	const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
	let m;
	while ((m = rowRe.exec(html || "")) !== null) {
		const cells = [];
		const cellRe = /<(t[dh])\b([^>]*)>([\s\S]*?)(?=<\/t[dh]>|<t[dh]\b|$)/gi;
		let c;
		while ((c = cellRe.exec(m[1])) !== null) {
			const label = /data-label="([^"]*)"/i.exec(c[2]);
			cells.push({ header: c[1].toLowerCase() === "th", html: c[3], text: text(c[3]), href: href(c[3]), label: label ? decode(label[1]) : null });
		}
		out.push(cells);
	}
	return out;
};

/**
 * Key/value table (<tr><th>key</th><td>value</td></tr>) as an object of texts.
 */
const metaTable = (html) => {
	return rows(html).reduce((acc, cells) => {
		if (cells.length >= 2 && cells[0].header && !cells[1].header) {
			acc[cells[0].text] = cells[1].text;
		}
		return acc;
	}, {});
};

/**
 * HTML of the panel whose title is `title` (up to the next panel title).
 */
const section = (html, title) => {
	const src = html || "";
	const re = new RegExp("<h[1-6][^>]*class=\"panel-title\"[^>]*>\\s*" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*</h[1-6]>", "i");
	const m = re.exec(src);
	if (!m) {
		return "";
	}
	const rest = src.slice(m.index + m[0].length);
	const next = rest.search(/<h[1-6][^>]*class="panel-title"/i);
	return next === -1 ? rest : rest.slice(0, next);
};

module.exports = {
	decode: decode,
	text: text,
	href: href,
	rows: rows,
	metaTable: metaTable,
	section: section
};
