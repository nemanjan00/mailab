// Fixtures are trimmed captures of public fccid.io pages (FCC records),
// taken 2026-11-16; personal contact rows removed. No network here.

const fs = require("fs");
const os = require("os");
const path = require("path");
const parse = require("../parse");
const fccid = require("..");
const fakeTransport = require("../../http/testing").fakeTransport;

const FIXTURES = path.join(__dirname, "fixtures");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

describe("fccid.io parsers", () => {
	test("device page: filing, frequencies, power, confidentiality, exhibits", () => {
		const d = parse.parseDevice(fixture("device.html"));
		expect(d.fccId).toBe("2AC7Z-ESP32WROOM32E");
		expect(d.description).toBe("Wi-Fi & Bluetooth Internet of Things Module");
		expect(d.grantee).toEqual({ code: "2AC7Z", name: "ESPRESSIF SYSTEMS (SHANGHAI) CO., LTD" });
		expect(d.productCode).toBe("ESP32WROOM32E");
		expect(d.latestApplication).toBe("2020-04-10");
		expect(d.equipmentClass).toBe("DSS - Part 15 Spread Spectrum Transmitter");
		expect(d.frequencies[0]).toEqual({ range: "2402-2480 MHz", purpose: "Original Equipment", date: "2020-04-10" });
		expect(d.authorizations).toEqual([
			{ frequency: "2402-2480 MHz", outputWatts: 0.006, tolerance: null, emission: null, rules: "15C" },
			{ frequency: "2402-2480 MHz", outputWatts: 0.01, tolerance: null, emission: null, rules: "15C" },
			{ frequency: "2412-2462 MHz", outputWatts: 0.398, tolerance: null, emission: null, rules: "15C" }
		]);
		expect(d.confidentiality).toEqual({ shortTerm: false, longTerm: true, grantDeferral: false });
		expect(d.modular).toBe("Single Modular Approval");
		expect(d.applications.length).toBe(2);
		expect(d.exhibits.length).toBe(16);
		expect(d.exhibits[2]).toEqual({
			title: "Internal Photo",
			type: "Internal Photos",
			date: "2020-04-10",
			format: "PDF",
			size: "1.1 MB",
			url: "https://fccid.io/2AC7Z-ESP32WROOM32E/Internal-Photos/Internal-Photo-4684802",
			documentId: "4684802",
			fccUrl: "https://apps.fcc.gov/eas/GetApplicationAttachment.html?id=4684802",
			available: true,
			status: "public"
		});
		// schematics / block diagram held confidential: listed without a link
		const schematics = d.exhibits.filter((e) => e.type === "Schematics");
		expect(schematics.length).toBe(2);
		schematics.forEach((e) => {
			expect(e.available).toBe(false);
			expect(e.url).toBe(null);
			expect(e.status).toBe("Metadata only");
		});
		expect(d.exhibits.find((e) => e.type === "Block Diagram").available).toBe(false);
	});

	test("device page with tolerance / emission columns (cellular)", () => {
		const d = parse.parseDevice(fixture("device-bcg.html"));
		expect(d.fccId).toBe("BCG-E2430A");
		expect(d.description).toBe("iPhone");
		expect(d.grantee).toEqual({ code: "BCG", name: "Apple Inc." });
		expect(d.authorizations[0]).toEqual({ frequency: "824.2-848.8 MHz", outputWatts: 1.574, tolerance: "2.5ppm", emission: "242KGXW", rules: "22H" });
		expect(d.confidentiality.shortTerm).toBe(true);
		expect(d.exhibits.length).toBe(42);
		expect(d.exhibits.every((e) => e.available)).toBe(true);
	});

	test("possible matches page", () => {
		const page = fixture("nomatch.html");
		expect(parse.isMatchesPage(page)).toBe(true);
		expect(parse.isMatchesPage(fixture("device.html"))).toBe(false);
		expect(parse.parseMatches(page).map((m) => m.fccId)).toEqual(["2AC7Z-ESP32WROOM32E", "2AC7Z-ESP32WROOM32U"]);
	});

	test("exhibit page: file, preview, size, confidentiality", () => {
		const e = parse.parseExhibit(fixture("exhibit.html"));
		expect(e).toMatchObject({
			fccId: "2AC7Z-ESP32WROOM32E",
			documentId: "4684802",
			type: "Internal Photos",
			title: "Internal Photo",
			documentTitle: "EXHIBIT B_EUT INTERNAL PHOTOGRAPHS",
			pages: 2,
			bytes: 1182681,
			fileUrl: "https://fccid.io/m/86118a0b35d392938063720c3cee76b5f27dafdda0a716c672f8fe82184b9f29.pdf",
			previewUrl: "https://fccid.io/m/86118a0b35d392938063720c3cee76b5f27dafdda0a716c672f8fe82184b9f29.png",
			confidentiality: { shortTerm: false, longTerm: false }
		});
		expect(e.related.length).toBe(16);
	});

	test("grantee page", () => {
		const g = parse.parseGrantee(fixture("grantee.html"));
		expect(g.code).toBe("2AC7Z");
		expect(g.name).toBe("ESPRESSIF SYSTEMS (SHANGHAI) CO., LTD");
		expect(g.fccIdCount).toBe(80);
		expect(g.registered).toBe("2014-09-15");
		expect(g.filings.length).toBe(6);
		expect(g.filings[0]).toEqual({ fccId: "2AC7Z-ESPC3MINII", url: "https://fccid.io/2AC7Z-ESPC3MINII", date: "2026-06-11", description: "Wi-Fi &BluetoothInternet; ofThings Module", purpose: "Original Equipment" });
	});

	test("search page", () => {
		const s = parse.parseSearch(fixture("search.html"));
		expect(s.total).toBe(91);
		expect(s.companies).toEqual([{ name: "ESPRESSIF SYSTEMS (SHANGHAI) CO., LTD", code: "2AC7Z", location: "Shanghai, N/A, China", registered: "2014-09-15" }]);
		expect(s.results.length).toBe(3);
		expect(s.results[1]).toMatchObject({ fccId: "2AC7ZESP8684M1", productCode: "ESP8684M1", latestFiling: "2022-09-13", frequencies: "2412-2462 MHz, 2402-2480 MHz" });
		expect(s.results[1].documents.length).toBe(3);
	});
});

describe("fccid service", () => {
	let dir;
	const oldDataDir = process.env.DATA_DIR;
	const pdf = Buffer.from("%PDF-1.4\n% fake exhibit\n");
	const routes = {
		"https://fccid.io/2AC7Z-ESP32WROOM32E": { body: fixture("device.html") },
		"https://fccid.io/2AC7Z-ESP32WROOM32": { status: 300, body: fixture("nomatch.html") },
		"https://fccid.io/2AC7Z": { body: fixture("grantee.html") },
		"https://fccid.io/search?q=espressif": { body: fixture("search.html") },
		"https://fccid.io/search?q=2AC7Z-ESP32WROOM32": { body: fixture("search.html") },
		"https://fccid.io/2AC7Z-ESP32WROOM32E/Internal-Photos/Internal-Photo-4684802": { body: fixture("exhibit.html") },
		"https://fccid.io/m/86118a0b35d392938063720c3cee76b5f27dafdda0a716c672f8fe82184b9f29.pdf": { body: pdf, headers: { "content-type": "application/pdf" } },
		"https://fccid.io/m/86118a0b35d392938063720c3cee76b5f27dafdda0a716c672f8fe82184b9f29.png": { body: "PNG", headers: { "content-type": "image/png" } }
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-fccid-"));
		process.env.DATA_DIR = dir;
		fccid._transport = fakeTransport(routes);
		fccid._minIntervalMs = 0;
		fccid._client = null;
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		if (oldDataDir === undefined) {
			delete process.env.DATA_DIR;
		} else {
			process.env.DATA_DIR = oldDataDir;
		}
	});

	test("find routes FCC IDs, grantee codes and free text", () => {
		return fccid.find("2ac7z-esp32wroom32e").then((r) => {
			expect(r.kind).toBe("device");
			expect(r.exhibits.length).toBe(16);
			return fccid.find("2AC7Z");
		}).then((r) => {
			expect(r.kind).toBe("grantee");
			expect(r.filings.length).toBe(6);
			return fccid.find("espressif");
		}).then((r) => {
			expect(r.kind).toBe("search");
			expect(r.total).toBe(91);
		});
	}, 20000);

	test("an unknown FCC ID falls back to search with similar IDs", () => {
		return fccid.find("2AC7Z-ESP32WROOM32").then((r) => {
			expect(r.kind).toBe("search");
			expect(r.similar.map((m) => m.fccId)).toEqual(["2AC7Z-ESP32WROOM32E", "2AC7Z-ESP32WROOM32U"]);
		});
	}, 20000);

	test("pages are cached in DATA_DIR/cache/fccid", () => {
		return fccid.lookup("2AC7Z-ESP32WROOM32E").then(() => {
			fccid._client = null;
			return fccid.lookup("2AC7Z-ESP32WROOM32E");
		}).then((d) => {
			expect(d.fccId).toBe("2AC7Z-ESP32WROOM32E");
			expect(fccid._transport.calls.length).toBe(1);
			expect(fs.readdirSync(path.join(dir, "cache", "fccid")).length).toBe(2);
		});
	});

	test("download by fccId + type, refusing confidential exhibits", () => {
		return fccid.download({ fccId: "2AC7Z-ESP32WROOM32E", type: "internal photo" }).then((r) => {
			expect(r.mime).toBe("application/pdf");
			expect(r.data.equals(pdf)).toBe(true);
			expect(r.exhibit.documentId).toBe("4684802");
			return fccid.download({ fccId: "2AC7Z-ESP32WROOM32E", type: "schematic" }).then(() => {
				throw new Error("should fail");
			}, (err) => {
				expect(err.message).toMatch(/not public: Metadata only/);
				expect(err.status).toBe(404);
			});
		});
	}, 20000);

	test("download respects the size cap from the exhibit page", () => {
		return expect(fccid.download({ url: "/2AC7Z-ESP32WROOM32E/Internal-Photos/Internal-Photo-4684802", maxBytes: 1000 })).rejects.toThrow(/over the 1000 byte cap/);
	});

	test("preview fetches the first-page PNG", () => {
		return fccid.preview("https://fccid.io/2AC7Z-ESP32WROOM32E/Internal-Photos/Internal-Photo-4684802").then((r) => {
			expect(r.mime).toBe("image/png");
			expect(r.data.toString()).toBe("PNG");
		});
	}, 20000);

	test("only fccid.io is fetched; bad input is a 400", () => {
		expect(() => fccid._url("https://evil.example.org/x")).toThrow(/only fccid.io/);
		expect(() => fccid._url("file:///etc/passwd")).toThrow(/only fccid.io/);
		expect(fccid._url("/a b")).toBe("https://fccid.io/a%20b");
		return expect(fccid.lookup("??")).rejects.toThrow(/not an FCC ID/);
	});

	test("network failures surface as clear errors", () => {
		fccid._transport = fakeTransport({});
		fccid._client = null;
		return expect(fccid.lookup("BCG-E2430A")).rejects.toThrow("fccid.io: cannot reach fccid.io (ENOTFOUND)");
	});
});
