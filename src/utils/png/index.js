// Minimal PNG encoder (RGB / RGBA, 8 bits per channel) on node's zlib: no
// native image libraries. Used for VNC screenshots.

const zlib = require("zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_RGB = 2;
const COLOR_RGBA = 6;
const DEFAULT_LEVEL = 6;

const chunk = (type, data) => {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.slice(4), data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
};

/**
 * Encode pixels as PNG.
 * @param {{width: number, height: number, data: Buffer, channels: number, level: number}} image
 *   data: rows of width*channels bytes (channels 3 = RGB, 4 = RGBA, default 4); level: zlib 0..9
 * @returns {Buffer}
 */
const encode = (image) => {
	const channels = image.channels || 4;
	if (channels !== 3 && channels !== 4) {
		throw new Error("PNG: channels must be 3 or 4");
	}
	const stride = image.width * channels;
	if (!image.width || !image.height || image.data.length < stride * image.height) {
		throw new Error("PNG: " + image.width + "x" + image.height + " needs " + stride * image.height + " bytes, got " + image.data.length);
	}
	// filter type 0 (none) per row
	const raw = Buffer.alloc((stride + 1) * image.height);
	Array.from({ length: image.height }, (_, y) => y).forEach((y) => {
		image.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	});
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(image.width, 0);
	ihdr.writeUInt32BE(image.height, 4);
	ihdr[8] = 8;
	ihdr[9] = channels === 4 ? COLOR_RGBA : COLOR_RGB;
	return Buffer.concat([
		SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw, { level: image.level === undefined ? DEFAULT_LEVEL : image.level })),
		chunk("IEND", Buffer.alloc(0))
	]);
};

module.exports = {
	encode: encode
};
