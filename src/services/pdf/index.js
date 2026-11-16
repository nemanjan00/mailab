// PDF pages → PNG and positioned words, through poppler-utils (pdfinfo,
// pdftoppm, pdftotext -bbox). Always execFile with argument arrays.

const execFile = require("child_process").execFile;
const fs = require("fs");

const MAX_BUFFER = 64 * 1024 * 1024;
const PT_PER_INCH = 72;
const TIMEOUT_MS = 120000;

const run = (cmd, args, options) => new Promise((resolve, reject) => {
	execFile(cmd, args, Object.assign({ maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS }, options || {}), (err, stdout, stderr) => {
		if (err) {
			const reason = err.code === "ENOENT" ? cmd + " not found (install poppler-utils)" : cmd + ": " + (String(stderr || "").trim() || err.message);
			reject(new Error(reason));
			return;
		}
		resolve(stdout);
	});
});

const unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");

const WORD_RE = /<word xMin="([\d.eE+-]+)" yMin="([\d.eE+-]+)" xMax="([\d.eE+-]+)" yMax="([\d.eE+-]+)">([^<]*)<\/word>/g;

/**
 * Words from `pdftotext -bbox` XHTML, scaled from points to pixels.
 * Coordinates follow the rendered (rotation-applied) page, like pdftoppm.
 * @param {string} xhtml
 * @param {number} scale pixels per point (dpi / 72)
 * @returns {Array<{text: string, x: number, y: number, w: number, h: number}>}
 */
const parseBbox = (xhtml, scale) => {
	const k = scale || 1;
	const round = (v) => Math.round(v * 100) / 100;
	return Array.from(String(xhtml).matchAll(WORD_RE)).map((m) => {
		const x0 = Number(m[1]) * k;
		const y0 = Number(m[2]) * k;
		return { text: unescapeXml(m[5]), x: round(x0), y: round(y0), w: round(Number(m[3]) * k - x0), h: round(Number(m[4]) * k - y0) };
	}).filter((w) => w.text.trim().length > 0);
};

const pdf = {
	isPdf: (buffer) => buffer.length > 4 && buffer.slice(0, 5).toString("latin1") === "%PDF-",

	/**
	 * @returns {Promise<{pages: number, title: string}>}
	 */
	info: (file) => run("pdfinfo", [file]).then((out) => {
		const field = (name) => {
			const m = new RegExp("^" + name + ":\\s*(.*)$", "m").exec(out);
			return m ? m[1].trim() : "";
		};
		return { pages: Number(field("Pages")) || 0, title: field("Title") };
	}),

	/**
	 * Render one page (1-based) to a PNG file. With `crop` ({x, y, w, h} in
	 * pixels at this dpi) only that region is rendered.
	 * @returns {Promise<string>} the PNG path
	 */
	render: (file, page, dpi, outPrefix, crop) => {
		const args = ["-f", String(page), "-l", String(page), "-r", String(dpi), "-png", "-singlefile"];
		if (crop) {
			args.push("-x", String(Math.round(crop.x)), "-y", String(Math.round(crop.y)), "-W", String(Math.round(crop.w)), "-H", String(Math.round(crop.h)));
		}
		return run("pdftoppm", args.concat([file, outPrefix])).then(() => outPrefix + ".png");
	},

	/**
	 * Same as render, but returns the PNG bytes and removes the file.
	 */
	renderBuffer: (file, page, dpi, outPrefix, crop) => pdf.render(file, page, dpi, outPrefix, crop).then((png) => {
		const data = fs.readFileSync(png);
		fs.rmSync(png, { force: true });
		return data;
	}),

	/**
	 * Words with their boxes in pixels at `dpi`.
	 */
	words: (file, page, dpi) => run("pdftotext", ["-bbox", "-f", String(page), "-l", String(page), file, "-"])
		.then((out) => parseBbox(out, dpi / PT_PER_INCH)),

	parseBbox: parseBbox
};

module.exports = pdf;
