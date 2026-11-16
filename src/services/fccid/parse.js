// Parsers for fccid.io pages (FCC equipment authorization records):
// device (FCC ID), exhibit (one document), grantee, search, "possible matches".

const html = require("../../utils/html");

const BASE = "https://fccid.io";
// the FCC's own exhibit download (Akamai-protected: works in a browser, often not from scripts)
const FCC_ATTACHMENT = "https://apps.fcc.gov/eas/GetApplicationAttachment.html?id=";

const absolute = (url) => {
	if (!url) {
		return null;
	}
	if (/^https?:\/\//i.test(url)) {
		return url;
	}
	if (url.indexOf("//") === 0) {
		return "https:" + url;
	}
	return BASE + (url[0] === "/" ? "" : "/") + url;
};

const yesNo = (value) => {
	if (value === "Yes") {
		return true;
	}
	if (value === "No") {
		return false;
	}
	return null;
};

// page body from <main>, without decorative flag emoji spans
const main = (page) => {
	const start = page.indexOf("<main");
	const body = start === -1 ? page : page.slice(start);
	return body.replace(/<span role="img"[^>]*>[\s\S]*?<\/span>/gi, "");
};

const firstMatch = (re, src) => {
	const m = re.exec(src);
	return m ? html.text(m[1]) : null;
};

// "PDF 1.2 MB" -> {format: "PDF", size: "1.2 MB"}
const fileInfo = (value) => {
	const m = /^(\S+)\s+(.+)$/.exec(value || "");
	return m ? { format: m[1], size: m[2] } : { format: value || null, size: null };
};

const documentId = (url) => {
	const m = /-(\d+)\/?$/.exec(url || "");
	return m ? m[1] : null;
};

/**
 * Exhibit table rows (device page "Exhibits" panel, exhibit page "Related").
 */
const parseExhibitRows = (sectionHtml) => {
	return html.rows(sectionHtml).filter((cells) => cells.length >= 4 && !cells[0].header).map((cells) => {
		const status = firstMatch(/<span class="doc-status">([\s\S]*?)<\/span>/i, cells[0].html);
		let title = cells[0].text;
		if (status) {
			title = title.replace(status, "").trim();
		}
		const url = absolute(cells[0].href);
		const id = documentId(url);
		const file = fileInfo(cells[3].text);
		let available = Boolean(url);
		// FCC confidentiality: schematics/block diagrams/operational descriptions are
		// often held confidential; fccid.io lists them as metadata only
		if (status && /metadata only|confidential/i.test(status)) {
			available = false;
		}
		return {
			title: title,
			type: cells[1].text,
			date: cells[2].text || null,
			format: file.format,
			size: file.size,
			url: url,
			documentId: id,
			fccUrl: id ? FCC_ATTACHMENT + id : null,
			available: available,
			status: status || (available ? "public" : "unavailable")
		};
	});
};

/**
 * Device page: https://fccid.io/<FCC ID>
 */
const parseDevice = (page) => {
	const src = main(page);
	const details = html.metaTable(html.section(src, "FCC ID Device Details"));
	const application = html.metaTable(html.section(src, "Application Information"));
	const headline = firstMatch(/<h1>([\s\S]*?)<\/h1>/i, src) || "";
	const frequencies = html.rows(html.section(src, "Operating Frequencies"))
		.filter((cells) => cells.length >= 2 && !cells[0].header)
		.map((cells) => ({ range: cells[0].text, purpose: cells[1].text, date: cells[2] ? cells[2].text : null }));
	// columns vary (Frequency, Output[, Tolerance, Emission], Rules): go by header
	const authRows = html.rows(html.section(src, "Equipment Authorization"));
	const authHeader = (authRows.find((cells) => cells.length && cells[0].header) || []).map((c) => c.text.toLowerCase());
	const column = (cells, name, fallback) => {
		const i = authHeader.indexOf(name);
		const cell = cells[i === -1 ? fallback : i];
		return cell && cell.text !== "" ? cell.text : null;
	};
	const authorizations = authRows
		.filter((cells) => cells.length >= 2 && !cells[0].header)
		.map((cells) => {
			const output = column(cells, "output", 1);
			const watts = Number(output);
			return {
				frequency: column(cells, "frequency", 0),
				outputWatts: output !== null && Number.isFinite(watts) ? watts : null,
				tolerance: column(cells, "tolerance", -1),
				emission: column(cells, "emission", -1),
				rules: column(cells, "rules", cells.length - 1)
			};
		});
	const applications = html.rows(html.section(src, "Applications"))
		.filter((cells) => cells.length >= 2 && !cells[0].header)
		.map((cells) => ({ id: cells[0].text, date: cells[1].text, purpose: cells[2] ? cells[2].text : null }));
	const fccId = details["FCC ID"] || headline.replace(/^FCC ID\s+/i, "");
	return {
		fccId: fccId,
		url: absolute("/" + fccId),
		description: firstMatch(/<div class="jumbotron">[\s\S]*?<h3>([\s\S]*?)<\/h3>/i, src),
		grantee: { code: details["Grantee Code"] || null, name: (details["Applicant Business"] || "").trim() || null },
		productCode: details["Product Code"] || null,
		latestApplication: (firstMatch(/Latest application date:\s*([^<]*)</i, src) || "").trim() || null,
		equipmentClass: application["Equipment Class"] || details["Equipment Class"] || null,
		testFirm: details["Test Firm"] || null,
		frequencies: frequencies,
		authorizations: authorizations,
		confidentiality: {
			shortTerm: yesNo(application["Short-Term Confidentiality"]),
			longTerm: yesNo(application["Long-Term Confidentiality"]),
			grantDeferral: yesNo(application["Grant Deferral"])
		},
		modular: application["Modular Equipment"] || null,
		grantComments: application["Grant Comments"] || null,
		applications: applications,
		exhibits: parseExhibitRows(html.section(src, "Exhibits"))
	};
};

/**
 * "No exact FCC ID was found" page: similar IDs.
 */
const parseMatches = (page) => {
	const src = main(page);
	return html.rows(src).filter((cells) => cells.length >= 3 && !cells[0].header && cells[0].href).map((cells) => ({
		fccId: cells[0].text,
		url: absolute(cells[0].href),
		applicant: cells[2] ? cells[2].text : null,
		description: cells[3] ? cells[3].text : null,
		date: cells[4] ? cells[4].text : null
	}));
};

const isMatchesPage = (page) => /No exact FCC ID was found/i.test(page);

/**
 * Exhibit page: https://fccid.io/<FCC ID>/<Type>/<Title>-<document id>
 */
const parseExhibit = (page) => {
	const src = main(page);
	const meta = html.metaTable(html.section(src, "Document Details"));
	const pdf = /data-pdf-url="([^"]+)"/i.exec(src);
	const pdfUrl = pdf ? absolute(html.decode(pdf[1])) : null;
	// fccid.io renders a first-page PNG next to the PDF (same hash)
	const previewUrl = pdfUrl && /\/m\/[0-9a-f]+\.pdf$/i.test(pdfUrl) ? pdfUrl.replace(/\.pdf$/i, ".png") : null;
	// non-PDF exhibits (images) are linked directly
	let fileUrl = pdfUrl;
	if (!fileUrl) {
		const img = /<a[^>]+href="(\/m\/[0-9a-f]+\.(?:jpe?g|png|gif|tiff?))"/i.exec(src) || /<img[^>]+src="(\/m\/[0-9a-f]+\.(?:jpe?g|png|gif))"/i.exec(src);
		fileUrl = img ? absolute(html.decode(img[1])) : null;
	}
	const id = meta["Document ID"] || null;
	return {
		fccId: meta["FCC ID"] || null,
		documentId: id,
		type: meta["Document Type"] || null,
		title: meta["Description"] || null,
		documentTitle: meta["Document Title"] || null,
		applicant: meta["Applicant"] || null,
		pages: meta["Pages"] ? Number(meta["Pages"]) : null,
		bytes: meta["File Size"] ? Number(meta["File Size"]) : null,
		sha256: meta["File SHA-256"] || null,
		fileType: meta["File Type"] || null,
		available: meta["Available"] || null,
		confidentiality: { shortTerm: yesNo(meta["Short-Term Confidentiality"]), longTerm: yesNo(meta["Long-Term Confidentiality"]) },
		fileUrl: fileUrl,
		previewUrl: previewUrl,
		fccUrl: id ? FCC_ATTACHMENT + id : null,
		related: parseExhibitRows(html.section(src, "Related FCC Exhibits"))
	};
};

/**
 * Grantee page: https://fccid.io/<grantee code>
 */
const parseGrantee = (page) => {
	const src = main(page);
	const registration = html.metaTable(html.section(src, "FCC EAS Grantee Registration"));
	const count = /(\d+)\s+FCC IDs/i.exec(src);
	const filings = html.rows(src).filter((cells) => cells.length >= 2 && cells[0].label === "FCC ID / Date").map((cells) => {
		const parts = cells[1].html.split(/<br\s*\/?>/i).map(html.text);
		return {
			fccId: html.text(cells[0].html.split(/<br\s*\/?>/i)[0]),
			url: absolute(cells[0].href),
			date: html.text(cells[0].html.split(/<br\s*\/?>/i)[1] || "") || null,
			description: parts[0] || null,
			purpose: parts[1] || null
		};
	});
	return {
		code: registration["Grantee Code"] || firstMatch(/FCC Grantee Code\s*([^<]+)</i, src),
		name: registration["Company"] || firstMatch(/<span class="org">([\s\S]*?)<\/span>/i, src),
		address: [registration["Mailing Address"], registration["City"], registration["ZIP"], registration["Country"]].filter(Boolean).join(", ") || null,
		registered: registration["Date Received"] || null,
		fccIdCount: count ? Number(count[1]) : null,
		filings: filings
	};
};

/**
 * Search page: https://fccid.io/search?q=...
 */
const parseSearch = (page) => {
	const src = main(page);
	const companies = html.rows(src).filter((cells) => cells.length >= 2 && cells[0].label === "Company").map((cells) => ({
		name: cells[0].text,
		code: cells[1].text,
		location: cells[2] ? cells[2].text : null,
		registered: cells[3] ? cells[3].text : null
	}));
	const total = /Found\s+([\d,]+)\s+matching FCC IDs/i.exec(src);
	const blocks = src.split(/<div class="panel panel-default">\s*<div class="panel-body">\s*(?=<h3 style)/i).slice(1);
	const results = blocks.map((block) => {
		const meta = html.metaTable(block);
		const heading = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
		const documents = html.rows(block).filter((cells) => cells.length >= 3 && !cells[0].header && cells[0].href && !/<th/i.test(cells[0].html)).map((cells) => ({
			title: cells[0].text,
			type: cells[1].text,
			date: cells[2].text,
			url: absolute(cells[0].href)
		}));
		return {
			fccId: heading ? html.text(heading[1]) : null,
			url: heading ? absolute(html.href(heading[1])) : null,
			description: firstMatch(/<\/h3>\s*<p>([\s\S]*?)<\/p>/i, block),
			company: meta["Company"] || null,
			productCode: meta["Product Code"] || null,
			latestFiling: meta["Latest Filing"] || null,
			frequencies: meta["Frequencies"] || null,
			documents: documents
		};
	}).filter((r) => r.fccId);
	return { total: total ? Number(total[1].replace(/,/g, "")) : results.length, companies: companies, results: results };
};

module.exports = {
	BASE: BASE,
	absolute: absolute,
	parseDevice: parseDevice,
	parseMatches: parseMatches,
	isMatchesPage: isMatchesPage,
	parseExhibit: parseExhibit,
	parseGrantee: parseGrantee,
	parseSearch: parseSearch
};
