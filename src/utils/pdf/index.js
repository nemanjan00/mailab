// poppler-utils wrappers: page count, per-page text, page → PNG.
// Needs pdfinfo / pdftotext / pdftoppm on PATH (Arch: poppler, Debian: poppler-utils).

const fs = require("fs");
const os = require("os");
const path = require("path");
const execFile = require("child_process").execFile;

const TIMEOUT_MS = 60000;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const DEFAULT_DPI = 110;
const MAX_DPI = 300;

const run = (cmd, args, encoding) => {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: MAX_TEXT_BYTES, encoding: encoding || "utf8" }, (err, stdout, stderr) => {
			if (err) {
				if (err.code === "ENOENT") {
					reject(new Error(cmd + " not found: install poppler (poppler-utils)"));
					return;
				}
				reject(new Error(cmd + ": " + (String(stderr || "").trim() || err.message)));
				return;
			}
			resolve(stdout);
		});
	});
};

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 1024).indexOf("%PDF-") !== -1;

/**
 * Run fn(file) with buf written to a temp file, then remove it.
 */
const withTempFile = (buf, fn) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-pdf-"));
	const file = path.join(dir, "doc.pdf");
	fs.writeFileSync(file, buf);
	const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
	return Promise.resolve().then(() => fn(file)).then((out) => {
		cleanup();
		return out;
	}, (err) => {
		cleanup();
		throw err;
	});
};

/**
 * pdfinfo fields ({Pages, Title, Producer, ...}); Pages as a number.
 */
const info = (file) => {
	return run("pdfinfo", [file]).then((out) => {
		const fields = out.split("\n").reduce((acc, line) => {
			const m = /^([^:]+):\s*(.*)$/.exec(line);
			if (m) {
				acc[m[1].trim()] = m[2].trim();
			}
			return acc;
		}, {});
		fields.Pages = Number(fields.Pages) || 0;
		return fields;
	});
};

/**
 * Text of every page (layout preserved, so tables keep their columns).
 * @returns {Promise<string[]>} index 0 = page 1
 */
const pages = (file) => {
	return run("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"]).then((out) => {
		const list = out.split("\f");
		// pdftotext ends the last page with \f too
		if (list.length > 1 && list[list.length - 1].trim() === "") {
			list.pop();
		}
		return list;
	});
};

/**
 * Render one page to PNG.
 * @param {string} file
 * @param {number} page 1-based
 * @param {number} [dpi]
 * @returns {Promise<Buffer>}
 */
const render = (file, page, dpi) => {
	const n = Math.max(1, Math.floor(Number(page) || 1));
	const resolution = Math.min(MAX_DPI, Math.max(30, Math.floor(Number(dpi) || DEFAULT_DPI)));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-ppm-"));
	const prefix = path.join(dir, "page");
	return run("pdftoppm", ["-f", String(n), "-l", String(n), "-r", String(resolution), "-png", "-singlefile", file, prefix]).then(() => {
		const out = prefix + ".png";
		if (!fs.existsSync(out)) {
			throw new Error("page " + n + " not rendered (past the last page?)");
		}
		return fs.readFileSync(out);
	}).then((png) => {
		fs.rmSync(dir, { recursive: true, force: true });
		return png;
	}, (err) => {
		fs.rmSync(dir, { recursive: true, force: true });
		throw err;
	});
};

module.exports = {
	DEFAULT_DPI: DEFAULT_DPI,
	isPdf: isPdf,
	withTempFile: withTempFile,
	info: info,
	pages: pages,
	render: render
};
