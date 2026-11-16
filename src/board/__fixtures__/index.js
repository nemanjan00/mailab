// Synthetic test fixtures: a tiny one-page PDF with text and lines, and a
// solid-colour PNG. Generated here so no real documents end up in the repo.

const zlib = require("zlib");

/**
 * One-page PDF (Helvetica text + stroked lines). Coordinates in points from
 * the top-left, like the rendered page.
 * @param {{width: number, height: number, words: Array<{text: string, x: number, y: number, size: number}>, lines: Array<number[]>}} spec
 */
const makePdf = (spec) => {
	const h = spec.height;
	const text = (spec.words || []).map((w) => "BT /F1 " + (w.size || 12) + " Tf " + w.x + " " + (h - w.y) + " Td (" + w.text + ") Tj ET").join("\n");
	const lines = (spec.lines || []).map((l) => "1 w " + l[0] + " " + (h - l[1]) + " m " + l[2] + " " + (h - l[3]) + " l S").join("\n");
	const content = text + "\n" + lines + "\n";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + spec.width + " " + h + "] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		"<< /Length " + Buffer.byteLength(content) + " >>\nstream\n" + content + "endstream",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
	];
	let out = "%PDF-1.4\n";
	const offsets = objects.map((body, i) => {
		const at = Buffer.byteLength(out);
		out += (i + 1) + " 0 obj\n" + body + "\nendobj\n";
		return at;
	});
	const xref = Buffer.byteLength(out);
	out += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n" + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
	out += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
	return Buffer.from(out, "latin1");
};

const chunk = (type, data) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(zlib.crc32(body) >>> 0);
	return Buffer.concat([len, body, crc]);
};

/**
 * Solid RGB PNG.
 */
const makePng = (width, height, rgb) => {
	const color = rgb || [200, 120, 40];
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => color).flat())]);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))
	]);
};

module.exports = {
	makePdf: makePdf,
	makePng: makePng
};
