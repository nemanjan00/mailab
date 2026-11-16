// multipart/x-mixed-replace (MJPEG over HTTP) parser: push chunks as they
// arrive, get whole JPEG frames out. Parts are found by Content-Length when
// the part header has one (NanoKVM writes "--frame\r\nContent-Type:
// image/jpeg\r\nContent-Length: N\r\n\r\n<jpeg>\r\n", sipeed/NanoKVM
// server/service/stream/mjpeg/streamer.go), otherwise by the next boundary.
// Boundaries, headers and bodies may be split across chunks anywhere.

const MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HEADER_END = Buffer.from("\r\n\r\n", "latin1");

/**
 * Boundary from a Content-Type header ("multipart/x-mixed-replace; boundary=frame").
 * @returns {string|null}
 */
const boundaryOf = (contentType) => {
	const m = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ""));
	if (!m) {
		return null;
	}
	// some servers put the leading dashes into the parameter as well
	return (m[1] || m[2]).replace(/^--/, "");
};

/**
 * @param {string} boundary without the leading "--"
 * @param {function(Buffer, Object)} onFrame (body, part headers with lower-case names)
 * @param {{maxFrameBytes: number}} [options]
 * @returns {{push: function(Buffer), buffered: function(): number, frames: function(): number}}
 */
const createParser = (boundary, onFrame, options) => {
	const marker = Buffer.from("--" + boundary, "latin1");
	const nextMarker = Buffer.from("\r\n--" + boundary, "latin1");
	const maxFrame = (options && options.maxFrameBytes) || DEFAULT_MAX_FRAME_BYTES;
	const st = { buf: Buffer.alloc(0), part: null, frames: 0 };

	const parseHeaders = (text) => {
		const headers = {};
		text.split("\r\n").forEach((line) => {
			const i = line.indexOf(":");
			if (i > 0) {
				headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
			}
		});
		return headers;
	};

	const emit = (body, headers) => {
		st.frames++;
		onFrame(body, headers);
	};

	// one parsing step; false when more bytes are needed
	const step = () => {
		if (!st.part) {
			const start = st.buf.indexOf(marker);
			if (start === -1) {
				// keep a possible partial marker at the end
				st.buf = st.buf.subarray(Math.max(0, st.buf.length - marker.length));
				return false;
			}
			const end = st.buf.indexOf(HEADER_END, start + marker.length);
			if (end === -1) {
				if (st.buf.length - start > MAX_HEADER_BYTES) {
					throw new Error("MJPEG part header too long");
				}
				st.buf = st.buf.subarray(start);
				return false;
			}
			const headers = parseHeaders(st.buf.subarray(start + marker.length, end).toString("latin1"));
			const length = headers["content-length"] === undefined ? -1 : Number(headers["content-length"]);
			if (length > maxFrame) {
				throw new Error("MJPEG frame too large: " + length + " bytes");
			}
			st.part = { headers: headers, length: Number.isInteger(length) && length >= 0 ? length : -1 };
			st.buf = st.buf.subarray(end + HEADER_END.length);
			return true;
		}
		if (st.part.length >= 0) {
			if (st.buf.length < st.part.length) {
				return false;
			}
			const body = Buffer.from(st.buf.subarray(0, st.part.length));
			const headers = st.part.headers;
			st.buf = st.buf.subarray(st.part.length);
			st.part = null;
			emit(body, headers);
			return true;
		}
		const next = st.buf.indexOf(nextMarker);
		if (next === -1) {
			if (st.buf.length > maxFrame) {
				throw new Error("MJPEG frame larger than " + maxFrame + " bytes without a boundary");
			}
			return false;
		}
		const body = Buffer.from(st.buf.subarray(0, next));
		const headers = st.part.headers;
		st.buf = st.buf.subarray(next + 2);
		st.part = null;
		emit(body, headers);
		return true;
	};

	return {
		push: (chunk) => {
			st.buf = st.buf.length ? Buffer.concat([st.buf, chunk]) : chunk;
			let more = true;
			while (more) {
				more = step();
			}
		},
		buffered: () => st.buf.length,
		frames: () => st.frames
	};
};

/**
 * One multipart part for serving MJPEG (the same layout NanoKVM writes).
 */
const part = (boundary, jpeg) => Buffer.concat([
	Buffer.from("--" + boundary + "\r\nContent-Type: image/jpeg\r\nContent-Length: " + jpeg.length + "\r\n\r\n", "latin1"),
	jpeg,
	Buffer.from("\r\n", "latin1")
]);

module.exports = {
	boundaryOf: boundaryOf,
	createParser: createParser,
	part: part
};
