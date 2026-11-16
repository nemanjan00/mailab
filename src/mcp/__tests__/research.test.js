// fccid_* / datasheet_* MCP tools and their REST routes, against recorded
// fccid.io fixtures and a generated PDF (fake transport, no network).

const fs = require("fs");
const os = require("os");
const path = require("path");
const execFileSync = require("child_process").execFileSync;
const request = require("supertest");
const labModule = require("../../lab");
const mcp = require("..");
const web = require("../../web");
const fccid = require("../../services/fccid");
const datasheets = require("../../services/datasheets");
const fakeTransport = require("../../services/http/testing").fakeTransport;

const FIXTURES = path.join(__dirname, "..", "..", "services", "fccid", "__tests__", "fixtures");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

const hasPoppler = (() => {
	try {
		execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
		return true;
	} catch (_err) {
		return false;
	}
})();
const withPoppler = hasPoppler ? test : test.skip;

// one-page PDF with a line of text
const onePagePdf = (line) => {
	const ops = "BT /F1 12 Tf 20 150 Td (" + line + ") Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
		"<< /Length " + ops.length + " >>\nstream\n" + ops + "\nendstream"
	];
	let out = "%PDF-1.4\n";
	const offsets = objects.map((body, i) => {
		const offset = out.length;
		out += (i + 1) + " 0 obj\n" + body + "\nendobj\n";
		return offset;
	});
	const xref = out.length;
	out += "xref\n0 6\n0000000000 65535 f \n" + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
	out += "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
	return Buffer.from(out, "latin1");
};

const EXHIBIT_PDF = onePagePdf("internal photo");
const PDF_URL = "https://fccid.io/m/86118a0b35d392938063720c3cee76b5f27dafdda0a716c672f8fe82184b9f29.pdf";

const call = (server, name, args) => {
	return server._registeredTools[name].handler(args || {});
};

const payload = (result) => {
	const textPart = result.content.find((c) => c.type === "text");
	return JSON.parse(textPart.text);
};

describe("research tools", () => {
	let dir;
	let lab;
	const oldDataDir = process.env.DATA_DIR;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-research-"));
		process.env.DATA_DIR = dir;
		lab = labModule.create({ dataDir: dir });
		fccid._minIntervalMs = 0;
		fccid._client = null;
		fccid._transport = fakeTransport({
			"https://fccid.io/2AC7Z-ESP32WROOM32E": { body: fixture("device.html") },
			"https://fccid.io/2AC7Z-ESP32WROOM32E/Internal-Photos/Internal-Photo-4684802": { body: fixture("exhibit.html") },
			[PDF_URL]: { body: EXHIBIT_PDF, headers: { "content-type": "application/pdf" } }
		});
		datasheets._minIntervalMs = 0;
		datasheets._state = null;
		datasheets._transport = fakeTransport({ "https://example.org/ds.pdf": { body: onePagePdf("Pin Configuration and Functions"), headers: { "content-type": "application/pdf" } } });
	});

	afterEach(() => {
		return lab.shutdown().then(() => {
			fs.rmSync(dir, { recursive: true, force: true });
			if (oldDataDir === undefined) {
				delete process.env.DATA_DIR;
			} else {
				process.env.DATA_DIR = oldDataDir;
			}
		});
	});

	test("lookups are allowed read-only; fetching is not", () => {
		const ro = mcp.create(lab, { who: { name: "viewer", role: "ro" } });
		return call(ro, "fccid_exhibits", { fccId: "2AC7Z-ESP32WROOM32E" }).then((result) => {
			const out = payload(result);
			expect(out.exhibits.length).toBe(16);
			expect(out.confidentiality.longTerm).toBe(true);
			return call(ro, "fccid_fetch", { fccId: "2AC7Z-ESP32WROOM32E", type: "internal" });
		}).then((result) => {
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/read-only/);
			return call(ro, "datasheet_find", { kind: "pinout" });
		}).then((result) => {
			expect(payload(result)).toEqual([]);
		});
	});

	withPoppler("fccid_fetch stores the exhibit as a blob and its pages as images", () => {
		const rw = mcp.create(lab, { who: { name: "ai", role: "rw" } });
		return call(rw, "fccid_fetch", { fccId: "2AC7Z-ESP32WROOM32E", type: "internal photo", dpi: 40 }).then((result) => {
			expect(result.isError).toBeUndefined();
			expect(result.content[0].type).toBe("image");
			const out = payload(result);
			expect(out).toMatchObject({ name: "fcc_4684802", mime: "application/pdf", type: "Internal Photos", pages: 1, images: ["fcc_4684802_p1"] });
			expect(lab.getBlob("fcc_4684802").data.equals(EXHIBIT_PDF)).toBe(true);
			expect(lab.getImage("fcc_4684802_p1").mime).toBe("image/png");
			// confidential exhibits give a clear error, not a crash
			return call(rw, "fccid_fetch", { fccId: "2AC7Z-ESP32WROOM32E", type: "block diagram" });
		}).then((result) => {
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/not public/);
		});
	});

	withPoppler("datasheet_fetch → datasheet_find → datasheet_page", () => {
		const rw = mcp.create(lab, { who: { name: "ai", role: "rw" } });
		return call(rw, "datasheet_fetch", { url: "https://example.org/ds.pdf", part: "XY1" }).then((result) => {
			const meta = payload(result);
			expect(meta.pages).toBe(1);
			return call(rw, "datasheet_find", { kind: "pinout" }).then((found) => {
				expect(payload(found)[0]).toMatchObject({ id: meta.id, page: 1 });
				return call(rw, "datasheet_page", { id: meta.id, page: 1, dpi: 72, text: true });
			}).then((page) => {
				expect(page.content[0].type).toBe("image");
				const out = payload(page);
				expect(out.name).toBe("ds_" + meta.id.replace(/-/g, "_") + "_p1");
				expect(out.text).toMatch(/Pin Configuration/);
				expect(lab.getImage(out.name).mime).toBe("image/png");
			});
		});
	});

	test("REST: lookup, library list, errors as JSON", () => {
		const app = web.create(lab, { pushIntervalMs: 1000 }).app;
		return request(app).get("/api/fccid/2AC7Z-ESP32WROOM32E").expect(200).then((res) => {
			expect(res.body.fccId).toBe("2AC7Z-ESP32WROOM32E");
			return request(app).get("/api/datasheets").expect(200);
		}).then((res) => {
			expect(res.body.items).toEqual([]);
			expect(res.body.providers[0].name).toBe("manufacturer");
			return request(app).get("/api/fccid/exhibit?url=" + encodeURIComponent("https://evil.example.org/")).expect(400);
		}).then((res) => {
			expect(res.body.error).toMatch(/only fccid.io/);
			return request(app).get("/api/datasheets/nope-1/page/1").expect(404);
		}).then((res) => {
			expect(res.body.error).toMatch(/unknown datasheet/);
		});
	});
});
