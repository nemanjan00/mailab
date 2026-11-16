// RFB (VNC) client: protocol 3.3 / 3.7 / 3.8, security None and VNC auth,
// Raw + CopyRect (+ DesktopSize pseudo-encoding). Keeps the remote screen as
// an RGBX framebuffer and keeps one incremental update request in flight, so
// `update` fires whenever the remote screen changes.
//
//   const client = rfb.connect({host, port, password});
//   client.ready.then((info) => client.pointer(10, 10, 1));
//   client.on("update", (rects) => ...);
//
// `handshake` is exported on its own: the browser proxy (src/web/vnc) does
// the security handshake server-side so the VNC password never reaches the
// browser.

const net = require("net");
const EventEmitter = require("events");
const des = require("../../utils/des");

const DEFAULT_PORT = 5900;
const CONNECT_TIMEOUT_MS = 10000;
const HANDSHAKE_TIMEOUT_MS = 15000;
const MAX_REASON_BYTES = 64 * 1024;
const MAX_CUT_TEXT_BYTES = 1024 * 1024;
const MAX_DIMENSION = 16384;

const SECURITY = { invalid: 0, none: 1, vnc: 2 };
const SECURITY_NAMES = { 0: "invalid", 1: "none", 2: "vnc" };
const ENCODING = { raw: 0, copyRect: 1, desktopSize: -223 };
const SERVER_MSG = { framebufferUpdate: 0, colourMap: 1, bell: 2, cutText: 3 };
const CLIENT_MSG = { setPixelFormat: 0, setEncodings: 2, updateRequest: 3, key: 4, pointer: 5, cutText: 6 };
// 32 bpp, depth 24, little endian, true colour, 8 bits per channel at shifts
// 0 / 8 / 16: each pixel lands in memory as R, G, B, X
const PIXEL_FORMAT = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
const BYTES_PER_PIXEL = 4;

/**
 * Buffered byte reader over a stream of chunks: read(n) resolves with exactly n bytes.
 */
const createReader = () => {
	let chunks = [];
	let length = 0;
	let waiting = null;
	let failure = null;

	const pump = () => {
		if (!waiting) {
			return;
		}
		if (length < waiting.n) {
			if (failure) {
				const w = waiting;
				waiting = null;
				w.reject(failure);
			}
			return;
		}
		const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
		const out = all.subarray(0, waiting.n);
		const rest = all.subarray(waiting.n);
		chunks = rest.length ? [rest] : [];
		length = rest.length;
		const w = waiting;
		waiting = null;
		w.resolve(out);
	};

	return {
		push: (chunk) => {
			chunks.push(chunk);
			length += chunk.length;
			pump();
		},
		fail: (err) => {
			failure = failure || err;
			pump();
		},
		read: (n) => {
			if (waiting) {
				return Promise.reject(new Error("concurrent read"));
			}
			return new Promise((resolve, reject) => {
				waiting = { n: n, resolve: resolve, reject: reject };
				pump();
			});
		},
		// everything buffered and not yet read (handing a stream over to a proxy)
		drain: () => {
			const all = Buffer.concat(chunks, length);
			chunks = [];
			length = 0;
			return all;
		}
	};
};

const readU8 = (reader) => reader.read(1).then((b) => b[0]);
const readU32 = (reader) => reader.read(4).then((b) => b.readUInt32BE(0));
const readReason = (reader) => readU32(reader).then((n) => {
	if (n > MAX_REASON_BYTES) {
		throw new Error("server reason too long (" + n + " bytes)");
	}
	return reader.read(n);
}).then((b) => b.toString("utf8"));

const parseVersion = (buf) => {
	const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(buf.toString("latin1"));
	if (!m) {
		throw new Error("not an RFB server (greeting " + JSON.stringify(buf.toString("latin1")) + ")");
	}
	const major = Number(m[1]);
	const minor = Number(m[2]);
	if (major < 3) {
		throw new Error("unsupported RFB version " + major + "." + minor);
	}
	// 3.8 for anything newer; 3.5 (old Apple) and unknown 3.x behave like 3.3
	if (major > 3 || minor >= 8) {
		return 8;
	}
	if (minor === 7) {
		return 7;
	}
	return 3;
};

const chooseSecurity = (offered, password) => {
	if (password && offered.indexOf(SECURITY.vnc) !== -1) {
		return SECURITY.vnc;
	}
	if (offered.indexOf(SECURITY.none) !== -1) {
		return SECURITY.none;
	}
	if (offered.indexOf(SECURITY.vnc) !== -1) {
		throw new Error("server wants a VNC password (set the password option)");
	}
	throw new Error("no supported security type (server offers " + offered.join(", ") + "; supported: none, vnc)");
};

const parseServerInit = (head, nameBuf) => ({
	width: head.readUInt16BE(0),
	height: head.readUInt16BE(2),
	pixelFormat: head.subarray(4, 20),
	name: nameBuf.toString("utf8"),
	serverInit: Buffer.concat([head, nameBuf])
});

/**
 * Client side of the RFB handshake up to and including ServerInit.
 * @param {{read: function(number): Promise<Buffer>}} reader from createReader
 * @param {function(Buffer)} write
 * @param {{password: string, shared: boolean}} options
 * @returns {Promise<{version: string, security: string, width: number, height: number, pixelFormat: Buffer, name: string, serverInit: Buffer}>}
 */
const handshake = (reader, write, options) => {
	const opts = options || {};
	const session = {};
	return reader.read(12)
		.then((greeting) => {
			session.minor = parseVersion(greeting);
			session.version = "3." + session.minor;
			write(Buffer.from("RFB 003.00" + session.minor + "\n", "latin1"));
			if (session.minor === 3) {
				return readU32(reader).then((type) => {
					if (type === SECURITY.invalid) {
						return readReason(reader).then((reason) => {
							throw new Error("server refused: " + reason);
						});
					}
					if (type === SECURITY.vnc && !opts.password) {
						throw new Error("server wants a VNC password (set the password option)");
					}
					if (type !== SECURITY.none && type !== SECURITY.vnc) {
						throw new Error("unsupported security type " + type);
					}
					return type;
				});
			}
			return readU8(reader).then((count) => {
				if (count === 0) {
					return readReason(reader).then((reason) => {
						throw new Error("server refused: " + reason);
					});
				}
				return reader.read(count).then((types) => {
					const type = chooseSecurity(Array.from(types), opts.password);
					write(Buffer.from([type]));
					return type;
				});
			});
		})
		.then((type) => {
			session.security = SECURITY_NAMES[type];
			if (type === SECURITY.vnc) {
				return reader.read(16).then((challenge) => {
					write(des.vncResponse(opts.password, challenge));
					return true;
				});
			}
			// 3.8 sends SecurityResult for None too, older versions don't
			return session.minor === 8;
		})
		.then((hasResult) => {
			if (!hasResult) {
				return null;
			}
			return readU32(reader).then((result) => {
				if (result === 0) {
					return null;
				}
				if (session.minor === 8) {
					return readReason(reader).then((reason) => {
						throw new Error("authentication failed: " + reason);
					});
				}
				throw new Error("authentication failed");
			});
		})
		.then(() => {
			write(Buffer.from([opts.shared === false ? 0 : 1]));
			return reader.read(24);
		})
		.then((head) => {
			const nameLength = head.readUInt32BE(20);
			if (nameLength > MAX_REASON_BYTES) {
				throw new Error("desktop name too long");
			}
			return reader.read(nameLength).then((nameBuf) => Object.assign({ version: session.version, security: session.security }, parseServerInit(head, nameBuf)));
		});
};

const withTimeout = (promise, ms, what) => {
	let timer = null;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(what + " timed out after " + ms + " ms")), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Open a TCP connection and run the handshake.
 * @param {{host: string, port: number, password: string, shared: boolean}} options
 * @returns {Promise<{socket: net.Socket, reader: Object, info: Object}>}
 */
const open = (options) => {
	const reader = createReader();
	const socket = net.connect({ host: options.host || "127.0.0.1", port: Number(options.port) || DEFAULT_PORT });
	socket.setNoDelay(true);
	socket.on("data", reader.push);
	socket.on("error", reader.fail);
	socket.on("close", () => reader.fail(new Error("connection closed")));
	const connected = new Promise((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return withTimeout(connected, CONNECT_TIMEOUT_MS, "connect")
		.then(() => withTimeout(handshake(reader, (b) => socket.write(b), options), HANDSHAKE_TIMEOUT_MS, "RFB handshake"))
		.then((info) => ({ socket: socket, reader: reader, info: info }), (err) => {
			socket.destroy();
			throw err;
		});
};

/**
 * Connect and keep a framebuffer.
 * @param {{host: string, port: number, password: string, minIntervalMs: number}} options
 *   minIntervalMs: least time between incremental update requests (default 0)
 * @returns {EventEmitter} with ready (Promise<info>), width, height, framebuffer,
 *   pointer(), key(), cutText(), requestUpdate(), close(); events update, resize, bell, cut, close
 */
const connect = (options) => {
	const client = new EventEmitter();
	const state = { socket: null, closed: false, updates: 0, timer: null, lastRequest: 0 };
	client.width = 0;
	client.height = 0;
	client.framebuffer = Buffer.alloc(0);
	client.info = null;

	const send = (buf) => {
		if (state.socket && !state.closed) {
			state.socket.write(buf);
		}
	};

	const resize = (width, height) => {
		if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
			throw new Error("framebuffer too large: " + width + "x" + height);
		}
		client.width = width;
		client.height = height;
		client.framebuffer = Buffer.alloc(width * height * BYTES_PER_PIXEL);
	};

	client.requestUpdate = (incremental, region) => {
		const r = region || { x: 0, y: 0, w: client.width, h: client.height };
		const msg = Buffer.alloc(10);
		msg[0] = CLIENT_MSG.updateRequest;
		msg[1] = incremental ? 1 : 0;
		msg.writeUInt16BE(r.x, 2);
		msg.writeUInt16BE(r.y, 4);
		msg.writeUInt16BE(Math.min(r.w, client.width - r.x), 6);
		msg.writeUInt16BE(Math.min(r.h, client.height - r.y), 8);
		state.lastRequest = Date.now();
		send(msg);
	};

	// one incremental request in flight; spaced by minIntervalMs
	const scheduleUpdate = () => {
		const wait = Math.max(0, (options.minIntervalMs || 0) - (Date.now() - state.lastRequest));
		clearTimeout(state.timer);
		state.timer = setTimeout(() => client.requestUpdate(true), wait);
	};

	client.pointer = (x, y, mask) => {
		const msg = Buffer.alloc(6);
		msg[0] = CLIENT_MSG.pointer;
		msg[1] = mask & 0x7f;
		msg.writeUInt16BE(Math.max(0, Math.min(client.width - 1, Math.round(x))), 2);
		msg.writeUInt16BE(Math.max(0, Math.min(client.height - 1, Math.round(y))), 4);
		send(msg);
	};

	client.key = (keysym, down) => {
		const msg = Buffer.alloc(8);
		msg[0] = CLIENT_MSG.key;
		msg[1] = down ? 1 : 0;
		msg.writeUInt32BE(keysym >>> 0, 4);
		send(msg);
	};

	client.cutText = (text) => {
		const data = Buffer.from(String(text), "latin1");
		const msg = Buffer.alloc(8);
		msg[0] = CLIENT_MSG.cutText;
		msg.writeUInt32BE(data.length, 4);
		send(Buffer.concat([msg, data]));
	};

	client.close = () => {
		if (state.closed) {
			return;
		}
		state.closed = true;
		clearTimeout(state.timer);
		if (state.socket) {
			state.socket.destroy();
		}
	};

	client.stats = () => ({ updates: state.updates });

	const rawRect = (reader, r) => reader.read(r.w * r.h * BYTES_PER_PIXEL).then((data) => {
		const rowBytes = r.w * BYTES_PER_PIXEL;
		Array.from({ length: r.h }, (_, row) => row).forEach((row) => {
			data.copy(client.framebuffer, ((r.y + row) * client.width + r.x) * BYTES_PER_PIXEL, row * rowBytes, (row + 1) * rowBytes);
		});
	});

	const copyRect = (reader, r) => reader.read(4).then((src) => {
		const sx = src.readUInt16BE(0);
		const sy = src.readUInt16BE(2);
		if (sx + r.w > client.width || sy + r.h > client.height) {
			throw new Error("CopyRect source outside the framebuffer");
		}
		const rowBytes = r.w * BYTES_PER_PIXEL;
		// via a copy: source and destination may overlap
		const tmp = Buffer.alloc(rowBytes * r.h);
		Array.from({ length: r.h }, (_, row) => row).forEach((row) => {
			client.framebuffer.copy(tmp, row * rowBytes, ((sy + row) * client.width + sx) * BYTES_PER_PIXEL, ((sy + row) * client.width + sx) * BYTES_PER_PIXEL + rowBytes);
		});
		Array.from({ length: r.h }, (_, row) => row).forEach((row) => {
			tmp.copy(client.framebuffer, ((r.y + row) * client.width + r.x) * BYTES_PER_PIXEL, row * rowBytes, (row + 1) * rowBytes);
		});
	});

	const readRect = (reader, rects) => reader.read(12).then((head) => {
		const r = { x: head.readUInt16BE(0), y: head.readUInt16BE(2), w: head.readUInt16BE(4), h: head.readUInt16BE(6), encoding: head.readInt32BE(8) };
		if (r.encoding === ENCODING.desktopSize) {
			resize(r.w, r.h);
			client.emit("resize", { width: r.w, height: r.h });
			rects.push({ x: 0, y: 0, w: r.w, h: r.h });
			return null;
		}
		if (r.x + r.w > client.width || r.y + r.h > client.height) {
			throw new Error("rectangle outside the framebuffer: " + JSON.stringify(r));
		}
		rects.push({ x: r.x, y: r.y, w: r.w, h: r.h });
		if (r.encoding === ENCODING.raw) {
			return rawRect(reader, r);
		}
		if (r.encoding === ENCODING.copyRect) {
			return copyRect(reader, r);
		}
		throw new Error("unsupported encoding " + r.encoding);
	});

	const framebufferUpdate = (reader) => reader.read(3).then((head) => {
		const count = head.readUInt16BE(1);
		const rects = [];
		const next = (i) => {
			if (i >= count) {
				return Promise.resolve();
			}
			return readRect(reader, rects).then(() => next(i + 1));
		};
		return next(0).then(() => {
			state.updates++;
			client.emit("update", rects);
			scheduleUpdate();
		});
	});

	const message = (reader) => readU8(reader).then((type) => {
		if (type === SERVER_MSG.framebufferUpdate) {
			return framebufferUpdate(reader);
		}
		if (type === SERVER_MSG.colourMap) {
			return reader.read(5).then((head) => reader.read(head.readUInt16BE(3) * 6));
		}
		if (type === SERVER_MSG.bell) {
			client.emit("bell");
			return null;
		}
		if (type === SERVER_MSG.cutText) {
			return reader.read(7).then((head) => {
				const n = head.readUInt32BE(3);
				if (n > MAX_CUT_TEXT_BYTES) {
					throw new Error("server clipboard too large (" + n + " bytes)");
				}
				return reader.read(n);
			}).then((text) => {
				client.emit("cut", text.toString("latin1"));
			});
		}
		throw new Error("unknown server message " + type);
	});

	const fail = (err) => {
		const wasOpen = !state.closed;
		client.close();
		client.emit("close", wasOpen ? err : null);
	};

	// not `return loop()`: a long-lived promise chain would never be collected
	const loop = (reader) => {
		message(reader).then(() => loop(reader), fail);
	};

	client.ready = open(options).then((conn) => {
		state.socket = conn.socket;
		if (state.closed) {
			conn.socket.destroy();
			throw new Error("closed");
		}
		client.info = conn.info;
		resize(conn.info.width, conn.info.height);
		const encodings = [ENCODING.copyRect, ENCODING.raw, ENCODING.desktopSize];
		const setEnc = Buffer.alloc(4 + 4 * encodings.length);
		setEnc[0] = CLIENT_MSG.setEncodings;
		setEnc.writeUInt16BE(encodings.length, 2);
		encodings.forEach((e, i) => setEnc.writeInt32BE(e, 4 + 4 * i));
		send(Buffer.concat([Buffer.from([CLIENT_MSG.setPixelFormat, 0, 0, 0]), PIXEL_FORMAT, setEnc]));
		client.requestUpdate(false);
		loop(conn.reader);
		return conn.info;
	});
	// ready rejections are the caller's; don't crash on an unobserved one
	client.ready.catch(() => null);
	return client;
};

module.exports = {
	connect: connect,
	open: open,
	handshake: handshake,
	createReader: createReader,
	parseVersion: parseVersion,
	DEFAULT_PORT: DEFAULT_PORT,
	SECURITY: SECURITY,
	ENCODING: ENCODING,
	BYTES_PER_PIXEL: BYTES_PER_PIXEL
};
