// Raster images: size/type sniffing in plain JS, crop / scale / overlay
// drawing through ImageMagick (`magick`), always with argument arrays.

const execFile = require("child_process").execFile;

const MAX_BUFFER = 128 * 1024 * 1024;
const TIMEOUT_MS = 60000;

const magick = (args, input) => new Promise((resolve, reject) => {
	const child = execFile("magick", args, { encoding: "buffer", maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
		if (err) {
			const reason = err.code === "ENOENT" ? "magick not found (install ImageMagick 7)" : "magick: " + (String(stderr || "").trim() || err.message);
			reject(new Error(reason));
			return;
		}
		resolve(stdout);
	});
	if (input) {
		child.stdin.on("error", () => null);
		child.stdin.end(input);
	}
});

const jpegSize = (buf) => {
	let off = 2;
	while (off + 9 < buf.length) {
		if (buf[off] !== 0xff) {
			return null;
		}
		const marker = buf[off + 1];
		const len = buf.readUInt16BE(off + 2);
		// SOF0..SOF15 except DHT (c4), JPG (c8), DAC (cc)
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
		}
		off += 2 + len;
	}
	return null;
};

const svgSize = (text) => {
	const tag = (/<svg\b[^>]*>/i.exec(text) || [""])[0];
	const attr = (name) => {
		const m = new RegExp("\\s" + name + "=\"([\\d.]+)(px)?\"", "i").exec(tag);
		return m ? Number(m[1]) : 0;
	};
	let width = attr("width");
	let height = attr("height");
	const vb = /viewBox="([^"]+)"/i.exec(tag);
	if ((!width || !height) && vb) {
		const parts = vb[1].trim().split(/[\s,]+/).map(Number);
		width = width || parts[2];
		height = height || parts[3];
	}
	return width && height ? { width: width, height: height } : null;
};

const raster = {
	/**
	 * Type and pixel size of PNG, JPEG, GIF, WebP (VP8X) or SVG data.
	 * @returns {{mime: string, ext: string, width: number, height: number}|null}
	 */
	sniff: (buf) => {
		if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
			return { mime: "image/png", ext: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
		}
		if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
			const size = jpegSize(buf);
			return size && Object.assign({ mime: "image/jpeg", ext: "jpg" }, size);
		}
		if (buf.length > 10 && buf.slice(0, 3).toString("latin1") === "GIF") {
			return { mime: "image/gif", ext: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
		}
		if (buf.length > 30 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 16).toString("latin1") === "WEBPVP8X") {
			return { mime: "image/webp", ext: "webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
		}
		const head = buf.slice(0, 4096).toString("utf8");
		if (/<svg\b/i.test(head)) {
			const size = svgSize(buf.toString("utf8"));
			return size && Object.assign({ mime: "image/svg+xml", ext: "svg" }, size);
		}
		return null;
	},

	/**
	 * Crop a region (pixels of the source) and scale it by `zoom`; PNG out.
	 */
	crop: (file, rect, zoom) => magick([file,
		"-crop", Math.round(rect.w) + "x" + Math.round(rect.h) + "+" + Math.round(rect.x) + "+" + Math.round(rect.y), "+repage",
		"-resize", (zoom * 100).toFixed(3) + "%", "png:-"]),

	/**
	 * Draw overlay primitives on a PNG.
	 * @param {Buffer} png
	 * @param {Array<{stroke: string, fill: string, width: number, draw: string}>} items
	 *   draw: ImageMagick -draw primitive ("polyline 1,2 3,4", "circle x,y x2,y2", "text x,y 'R1'")
	 */
	overlay: (png, items) => {
		if (!items.length) {
			return Promise.resolve(png);
		}
		const args = items.reduce((acc, item) => acc.concat([
			"-stroke", item.stroke || "none", "-fill", item.fill || "none", "-strokewidth", String(item.width || 1), "-draw", item.draw
		]), ["png:-"]);
		return magick(args.concat(["png:-"]), png);
	}
};

module.exports = raster;
