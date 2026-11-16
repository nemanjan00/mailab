const fs = require("fs");
const os = require("os");
const path = require("path");
const execFileSync = require("child_process").execFileSync;
const pdf = require("..");
const fixtures = require("../../../board/__fixtures__");

const has = (cmd) => {
	try {
		execFileSync(cmd, ["-v"], { stdio: "ignore" });
		return true;
	} catch (err) {
		return err.code !== "ENOENT";
	}
};
const POPPLER = has("pdftotext") && has("pdftoppm") && has("pdfinfo");
const withPoppler = POPPLER ? test : test.skip;

// what `pdftotext -bbox` prints (hand-written sample)
const BBOX = [
	"<!DOCTYPE html><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title></title></head><body><doc>",
	"  <page width=\"200.000000\" height=\"100.000000\">",
	"    <word xMin=\"10.000000\" yMin=\"20.000000\" xMax=\"34.000000\" yMax=\"32.000000\">R101</word>",
	"    <word xMin=\"50.5\" yMin=\"60\" xMax=\"90.5\" yMax=\"70\">VCC&amp;5V</word>",
	"    <word xMin=\"1\" yMin=\"1\" xMax=\"2\" yMax=\"2\"> </word>",
	"  </page>",
	"</doc></body></html>"
].join("\n");

describe("pdf service", () => {
	test("parses word boxes and scales points to pixels", () => {
		const words = pdf.parseBbox(BBOX, 2);
		expect(words).toEqual([
			{ text: "R101", x: 20, y: 40, w: 48, h: 24 },
			{ text: "VCC&5V", x: 101, y: 120, w: 80, h: 20 }
		]);
	});

	test("recognizes PDF data", () => {
		expect(pdf.isPdf(fixtures.makePdf({ width: 100, height: 100, words: [] }))).toBe(true);
		expect(pdf.isPdf(Buffer.from("hello"))).toBe(false);
	});

	withPoppler("renders and extracts words from a generated PDF", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-pdf-"));
		const file = path.join(dir, "t.pdf");
		fs.writeFileSync(file, fixtures.makePdf({ width: 288, height: 144, words: [{ text: "U7", x: 72, y: 72, size: 12 }], lines: [[0, 0, 288, 144]] }));
		return pdf.info(file)
			.then((info) => {
				expect(info.pages).toBe(1);
				return pdf.words(file, 1, 144);
			})
			.then((words) => {
				expect(words.map((w) => w.text)).toEqual(["U7"]);
				// baseline at 72pt → the box ends near 144px at 144 dpi
				expect(words[0].x).toBeCloseTo(144, 0);
				expect(words[0].y + words[0].h).toBeGreaterThan(130);
				expect(words[0].y + words[0].h).toBeLessThan(160);
				return pdf.render(file, 1, 36, path.join(dir, "out"));
			})
			.then((png) => {
				const buf = fs.readFileSync(png);
				expect(buf.readUInt32BE(16)).toBe(144);
				expect(buf.readUInt32BE(20)).toBe(72);
			});
	});
});
