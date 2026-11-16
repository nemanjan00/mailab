// Datasheet providers (fake transport, no network) and the local DB (needs
// poppler's pdftotext / pdftoppm; skipped without them).

const fs = require("fs");
const os = require("os");
const path = require("path");
const execFileSync = require("child_process").execFileSync;
const datasheets = require("..");
const providers = require("../providers");
const fakeTransport = require("../../http/testing").fakeTransport;

const hasPoppler = (() => {
	try {
		execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
		execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
		return true;
	} catch (_err) {
		return false;
	}
})();
const withPoppler = hasPoppler ? test : test.skip;

/**
 * Minimal PDF with one page per entry of `pages` (each an array of text lines).
 */
const makePdf = (pages) => {
	const objects = [];
	const add = (body) => {
		objects.push(body);
		return objects.length;
	};
	const catalog = add(null);
	const tree = add(null);
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids = pages.map((lines) => {
		const ops = lines.map((line, i) => "BT /F1 12 Tf 50 " + (780 - i * 16) + " Td (" + line.replace(/([()\\])/g, "\\$1") + ") Tj ET").join("\n");
		const content = add("<< /Length " + Buffer.byteLength(ops) + " >>\nstream\n" + ops + "\nendstream");
		return add("<< /Type /Page /Parent " + tree + " 0 R /MediaBox [0 0 612 792] /Contents " + content + " 0 R /Resources << /Font << /F1 " + font + " 0 R >> >> >>");
	});
	objects[catalog - 1] = "<< /Type /Catalog /Pages " + tree + " 0 R >>";
	objects[tree - 1] = "<< /Type /Pages /Kids [" + kids.map((k) => k + " 0 R").join(" ") + "] /Count " + kids.length + " >>";
	let out = "%PDF-1.4\n";
	const offsets = objects.map((body, i) => {
		const offset = Buffer.byteLength(out);
		out += (i + 1) + " 0 obj\n" + body + "\nendobj\n";
		return offset;
	});
	const xref = Buffer.byteLength(out);
	out += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n" + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
	out += "trailer\n<< /Size " + (objects.length + 1) + " /Root " + catalog + " 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
	return Buffer.from(out, "latin1");
};

const TIMER_PDF = makePdf([
	["XY555 Precision Timer", "1 Features", "Timing from microseconds to hours"],
	["Table of Contents", "1 Features ........ 1", "4 Pin Configuration and Functions ........ 2", "6 Absolute Maximum Ratings ........ 3"],
	["4 Pin Configuration and Functions", "PIN 1 GND Ground reference voltage", "PIN 2 TRIG Start of timing input", "PIN 6 THRES End of timing input, threshold voltage"],
	["6 Absolute Maximum Ratings", "Supply voltage VCC 18 V", "Output current 225 mA"]
]);
const MCU_PDF = makePdf([
	["ZZ32 Microcontroller"],
	["8 Register Map", "GPIOA_MODER offset 0x00 reset value 0xA8000000", "GPIOA_ODR offset 0x14"]
]);

describe("datasheet providers", () => {
	let dir;
	const oldDataDir = process.env.DATA_DIR;
	const oldMouser = process.env.MOUSER_API_KEY;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-ds-"));
		process.env.DATA_DIR = dir;
		delete process.env.MOUSER_API_KEY;
		datasheets._minIntervalMs = 0;
		datasheets._state = null;
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		process.env.DATA_DIR = oldDataDir;
		if (oldDataDir === undefined) {
			delete process.env.DATA_DIR;
		}
		if (oldMouser === undefined) {
			delete process.env.MOUSER_API_KEY;
		} else {
			process.env.MOUSER_API_KEY = oldMouser;
		}
	});

	test("part number variants drop package / reel suffixes", () => {
		expect(providers.variants("NE555P")).toEqual(["NE555P", "NE555"]);
		expect(providers.variants("LM358DR")).toEqual(["LM358DR", "LM358D", "LM358"]);
		expect(providers.variants("ESP32-WROOM-32")).toEqual(["ESP32-WROOM-32", "ESP32"]);
		expect(providers.variants("ne555")).toEqual(["ne555"]);
	});

	test("keyed providers are off until their env is set", () => {
		const list = providers.list();
		expect(list.find((p) => p.name === "manufacturer").enabled).toBe(true);
		expect(list.find((p) => p.name === "mouser").enabled).toBe(false);
		process.env.MOUSER_API_KEY = "k";
		expect(providers.list().find((p) => p.name === "mouser").enabled).toBe(true);
	});

	test("manufacturer URLs count only when they really are PDFs", () => {
		datasheets._transport = fakeTransport((url) => {
			if (url === "https://www.ti.com/lit/ds/symlink/ne555.pdf") {
				return { status: 206, body: "%PDF-1.7 ...", headers: { "content-type": "application/pdf" } };
			}
			if (url.indexOf("onsemi") !== -1) {
				// a soft 404: HTML with status 200
				return { status: 200, body: "<html>not found</html>" };
			}
			return { status: 404, body: "no" };
		});
		return datasheets.search("NE555P").then((r) => {
			expect(r.online).toEqual([{ provider: "manufacturer", part: "NE555", manufacturer: "Texas Instruments", description: null, url: "https://www.ti.com/lit/ds/symlink/ne555.pdf", verified: true }]);
			expect(r.providers).toEqual([{ name: "manufacturer", count: 1, error: undefined }]);
			// probes ask for the first KB only
			const probe = datasheets._transport.calls.find((c) => c.url.indexOf("ti.com") !== -1);
			expect(probe.init.headers.range).toBe("bytes=0-1023");
		});
	});

	test("mouser results map to candidates; provider errors don't fail the search", () => {
		process.env.MOUSER_API_KEY = "SECRET";
		// response shape from Mouser's Search API v1 docs (not a live capture)
		const mouser = { Errors: [], SearchResults: { NumberOfResult: 1, Parts: [{ ManufacturerPartNumber: "NE555DR", Manufacturer: "Texas Instruments", Description: "Timer", DataSheetUrl: "https://www.mouser.com/datasheet/2/405/ne555-1.pdf", ProductDetailUrl: "https://www.mouser.com/p" }] } };
		datasheets._transport = fakeTransport((url, init) => {
			if (url.indexOf("api.mouser.com") !== -1) {
				expect(JSON.parse(init.body).SearchByPartRequest.mouserPartNumber).toBe("NE555");
				return { body: JSON.stringify(mouser), headers: { "content-type": "application/json" } };
			}
			return null;
		});
		return datasheets.search("NE555").then((r) => {
			expect(r.online).toEqual([{ provider: "mouser", part: "NE555DR", manufacturer: "Texas Instruments", description: "Timer", url: "https://www.mouser.com/datasheet/2/405/ne555-1.pdf", pageUrl: "https://www.mouser.com/p", verified: false }]);
			expect(r.providers.find((p) => p.name === "manufacturer").count).toBe(0);
			// the key stays out of the cache metadata
			const metas = fs.readdirSync(path.join(dir, "cache", "datasheets")).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(dir, "cache", "datasheets", f), "utf8")).join("");
			expect(metas).not.toMatch(/SECRET/);
		});
	});

	test("a provider error is reported per provider", () => {
		process.env.MOUSER_API_KEY = "k";
		datasheets._transport = fakeTransport((url) => (url.indexOf("mouser") !== -1 ? { status: 500, body: "oops" } : { status: 404 }));
		return datasheets.search("NE555", { providers: ["mouser"] }).then((r) => {
			expect(r.online).toEqual([]);
			expect(r.providers[0].name).toBe("mouser");
			expect(r.providers[0].error).toMatch(/HTTP 500/);
		});
	});

	test("fetching an HTML page instead of a PDF is refused clearly", () => {
		datasheets._transport = fakeTransport({ "https://example.org/ds.pdf": { body: "<html>login</html>" } });
		return expect(datasheets.fetch({ url: "https://example.org/ds.pdf", part: "X" })).rejects.toThrow(/not a PDF/);
	});
});

describe("datasheet DB", () => {
	let dir;
	const oldDataDir = process.env.DATA_DIR;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-dsdb-"));
		process.env.DATA_DIR = dir;
		datasheets._minIntervalMs = 0;
		datasheets._state = null;
		datasheets._transport = fakeTransport({
			"https://example.org/xy555.pdf": { body: TIMER_PDF, headers: { "content-type": "application/pdf" } }
		});
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		process.env.DATA_DIR = oldDataDir;
		if (oldDataDir === undefined) {
			delete process.env.DATA_DIR;
		}
	});

	withPoppler("fetch stores pdf + text + metadata; same file twice is one entry", () => {
		return datasheets.fetch({ url: "https://example.org/xy555.pdf", part: "XY555", manufacturer: "Acme" }).then((meta) => {
			expect(meta).toMatchObject({ part: "XY555", manufacturer: "Acme", pages: 4, source: "example.org", url: "https://example.org/xy555.pdf" });
			expect(meta.id).toMatch(/^xy555-[0-9a-f]{8}$/);
			const stored = path.join(dir, "datasheets", meta.id);
			expect(fs.readFileSync(path.join(stored, "datasheet.pdf")).equals(TIMER_PDF)).toBe(true);
			expect(JSON.parse(fs.readFileSync(path.join(stored, "pages.json"), "utf8"))[2]).toMatch(/PIN 2 TRIG/);
			return datasheets.importPdf(TIMER_PDF, { part: "dup" });
		}).then((again) => {
			expect(again.existing).toBe(true);
			expect(datasheets.library().list().length).toBe(1);
		});
	});

	withPoppler("full-text find with page refs, phrases and section kinds", () => {
		return datasheets.importPdf(TIMER_PDF, { part: "XY555" })
			.then(() => datasheets.importPdf(MCU_PDF, { part: "ZZ32" }))
			.then(() => {
				const trig = datasheets.find({ query: "trig timing" });
				expect(trig[0]).toMatchObject({ part: "XY555", page: 3 });
				expect(trig[0].snippets[0]).toMatch(/TRIG/);
				// pinout: the section page beats the table of contents
				const pinout = datasheets.find({ kind: "pinout" });
				expect(pinout[0]).toMatchObject({ part: "XY555", page: 3 });
				expect(pinout.find((h) => h.page === 2).score).toBeLessThan(pinout[0].score);
				expect(datasheets.find({ kind: "registers" })[0]).toMatchObject({ part: "ZZ32", page: 2 });
				expect(datasheets.find({ kind: "ratings" })[0]).toMatchObject({ part: "XY555", page: 4 });
				expect(datasheets.find({ query: "\"threshold voltage\"" }).map((h) => h.page)).toEqual([3]);
				expect(datasheets.find({ query: "\"voltage threshold\"" })).toEqual([]);
				const id = datasheets.library().list().find((m) => m.part === "ZZ32").id;
				expect(datasheets.find({ query: "reset value", id: id })[0].page).toBe(2);
				expect(() => datasheets.find({ kind: "nope" })).toThrow(/unknown kind/);
				expect(() => datasheets.find({})).toThrow(/give a query or a kind/);
			});
	});

	withPoppler("local search by part name and text; offline", () => {
		return datasheets.importPdf(TIMER_PDF, { part: "XY555", manufacturer: "Acme" }).then(() => datasheets.search("xy-555", { online: false })).then((r) => {
			expect(r.local.map((m) => m.part)).toEqual(["XY555"]);
			expect(r.local[0].match).toBe("name");
			return datasheets.search("supply voltage", { online: false });
		}).then((r) => {
			expect(r.local[0]).toMatchObject({ part: "XY555", match: "text", page: 4 });
		});
	});

	withPoppler("render a page to PNG (cached), page text, remove", () => {
		return datasheets.importPdf(TIMER_PDF, { part: "XY555" }).then((meta) => {
			return datasheets.render(meta.id, 3, 72).then((png) => {
				expect(png.slice(1, 4).toString()).toBe("PNG");
				expect(fs.existsSync(path.join(dir, "datasheets", meta.id, "page-3-72.png"))).toBe(true);
				expect(datasheets.library().pageText(meta.id, 3)).toMatch(/THRES/);
				return expect(datasheets.render(meta.id, 9)).rejects.toThrow(/has pages 1-4/);
			}).then(() => {
				datasheets.library().remove(meta.id);
				expect(datasheets.library().list()).toEqual([]);
				expect(datasheets.find({ query: "trig" })).toEqual([]);
				expect(() => datasheets.library().get("../etc")).toThrow(/unknown datasheet|bad datasheet id/);
			});
		});
	});
});
