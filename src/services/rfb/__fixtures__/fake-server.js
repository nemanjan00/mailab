// Tiny RFB server for tests: versions 3.3 / 3.7 / 3.8, security None or VNC
// auth, Raw + CopyRect updates, records what clients send.

const net = require("net");
const randomBytes = require("crypto").randomBytes;
const rfb = require("..");
const des = require("../../../utils/des");

const BPP = 4;

/**
 * @param {{version: number, security: string, password: string, width: number, height: number, name: string}} options
 *   version: 3 | 7 | 8; security: "none" | "vnc"
 * @returns {Promise<Object>} {port, events, fb, fill(), copy(), close()}
 */
const start = (options) => {
	const o = Object.assign({ version: 8, security: "none", width: 16, height: 8, name: "fake" }, options);
	const server = {
		events: [],
		clients: [],
		fb: Buffer.alloc(o.width * o.height * BPP),
		width: o.width,
		height: o.height
	};
	const sockets = new Set();

	const u32 = (v) => {
		const b = Buffer.alloc(4);
		b.writeUInt32BE(v, 0);
		return b;
	};

	const rectHeader = (x, y, w, h, enc) => {
		const b = Buffer.alloc(12);
		b.writeUInt16BE(x, 0);
		b.writeUInt16BE(y, 2);
		b.writeUInt16BE(w, 4);
		b.writeUInt16BE(h, 6);
		b.writeInt32BE(enc, 8);
		return b;
	};

	const rawRect = (x, y, w, h) => {
		const rows = Array.from({ length: h }, (_, r) => server.fb.subarray(((y + r) * o.width + x) * BPP, ((y + r) * o.width + x + w) * BPP));
		return Buffer.concat([rectHeader(x, y, w, h, 0)].concat(rows));
	};

	const update = (rects) => {
		const head = Buffer.from([0, 0, 0, 0]);
		head.writeUInt16BE(rects.length, 2);
		return Buffer.concat([head].concat(rects));
	};

	const broadcast = (buf) => server.clients.forEach((c) => c.write(buf));

	/**
	 * Fill a rectangle with one colour and send it as a Raw update.
	 */
	server.fill = (x, y, w, h, rgb) => {
		Array.from({ length: h }, (_, r) => r).forEach((r) => {
			Array.from({ length: w }, (_, c) => c).forEach((c) => {
				const at = ((y + r) * o.width + x + c) * BPP;
				server.fb[at] = rgb[0];
				server.fb[at + 1] = rgb[1];
				server.fb[at + 2] = rgb[2];
			});
		});
		broadcast(update([rawRect(x, y, w, h)]));
	};

	/**
	 * Copy a rectangle inside the screen and send it as CopyRect.
	 */
	server.copy = (sx, sy, x, y, w, h) => {
		const tmp = Buffer.from(server.fb);
		Array.from({ length: h }, (_, r) => r).forEach((r) => {
			tmp.copy(server.fb, ((y + r) * o.width + x) * BPP, ((sy + r) * o.width + sx) * BPP, ((sy + r) * o.width + sx + w) * BPP);
		});
		const src = Buffer.alloc(4);
		src.writeUInt16BE(sx, 0);
		src.writeUInt16BE(sy, 2);
		broadcast(update([Buffer.concat([rectHeader(x, y, w, h, 1), src])]));
	};

	const messages = (socket, reader) => {
		const next = () => reader.read(1).then((t) => {
			const type = t[0];
			if (type === 0) {
				return reader.read(19).then(() => server.events.push({ type: "pixelFormat" }));
			}
			if (type === 2) {
				return reader.read(3).then((h) => reader.read(4 * h.readUInt16BE(1))).then((list) => {
					server.events.push({ type: "encodings", list: Array.from({ length: list.length / 4 }, (_, i) => list.readInt32BE(i * 4)) });
				});
			}
			if (type === 3) {
				return reader.read(9).then((b) => {
					server.events.push({ type: "updateRequest", incremental: b[0] });
					if (!b[0]) {
						socket.write(update([rawRect(0, 0, o.width, o.height)]));
					}
				});
			}
			if (type === 4) {
				return reader.read(7).then((b) => server.events.push({ type: "key", down: b[0], keysym: b.readUInt32BE(3) }));
			}
			if (type === 5) {
				return reader.read(5).then((b) => server.events.push({ type: "pointer", mask: b[0], x: b.readUInt16BE(1), y: b.readUInt16BE(3) }));
			}
			if (type === 6) {
				return reader.read(7).then((b) => reader.read(b.readUInt32BE(3))).then((text) => server.events.push({ type: "cut", text: text.toString("latin1") }));
			}
			throw new Error("fake server: unknown message " + type);
		}).then(next, () => socket.destroy());
		next();
	};

	const handshake = (socket, reader) => {
		const wanted = o.security === "vnc" ? 2 : 1;
		socket.write("RFB 003.00" + o.version + "\n");
		return reader.read(12)
			.then((v) => {
				server.events.push({ type: "version", version: v.toString("latin1").trim() });
				if (o.version === 3) {
					socket.write(u32(wanted));
					return wanted;
				}
				socket.write(Buffer.from([1, wanted]));
				return reader.read(1).then((b) => b[0]);
			})
			.then((chosen) => {
				if (chosen !== 2) {
					return true;
				}
				const challenge = randomBytes(16);
				socket.write(challenge);
				return reader.read(16).then((resp) => resp.equals(des.vncResponse(o.password, challenge)));
			})
			.then((ok) => {
				const needsResult = o.security === "vnc" || o.version === 8;
				if (needsResult) {
					socket.write(u32(ok ? 0 : 1));
					if (!ok && o.version === 8) {
						socket.write(Buffer.concat([u32(14), Buffer.from("wrong password")]));
					}
				}
				if (!ok) {
					server.events.push({ type: "authFailed" });
					socket.end();
					throw new Error("auth failed");
				}
				return reader.read(1);
			})
			.then((shared) => {
				server.events.push({ type: "clientInit", shared: shared[0] });
				const head = Buffer.alloc(24);
				head.writeUInt16BE(o.width, 0);
				head.writeUInt16BE(o.height, 2);
				Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(head, 4);
				head.writeUInt32BE(Buffer.byteLength(o.name), 20);
				socket.write(Buffer.concat([head, Buffer.from(o.name)]));
				server.clients.push(socket);
				messages(socket, reader);
			});
	};

	const tcp = net.createServer((socket) => {
		sockets.add(socket);
		const reader = rfb.createReader();
		socket.on("data", reader.push);
		socket.on("error", () => null);
		socket.on("close", () => {
			sockets.delete(socket);
			server.clients = server.clients.filter((c) => c !== socket);
			reader.fail(new Error("closed"));
		});
		handshake(socket, reader).catch(() => null);
	});

	server.close = () => new Promise((resolve) => {
		sockets.forEach((s) => s.destroy());
		tcp.close(() => resolve());
	});
	server.connections = () => sockets.size;

	return new Promise((resolve) => {
		tcp.listen(0, "127.0.0.1", () => {
			server.port = tcp.address().port;
			resolve(server);
		});
	});
};

module.exports = {
	start: start
};
