// WebSocket -> VNC bridge for the noVNC pane: /ws/vnc/<device>.
//
// Not an open proxy: the only target is the host:port of an existing `vnc`
// device. The security handshake with the VNC server happens here, with the
// device's stored password; the browser is offered security type None, so
// the password never reaches it. After ServerInit, bytes from the server are
// passed through, and every client message is parsed: unknown messages close
// the connection, and input (keys, pointer, clipboard, resize, power) from
// read-only users or view-only devices is dropped.
//
// Same auth as /ws (token / cookie, Host + Origin checks in open mode), plus
// the Origin must match the Host whenever a browser sends one.

const ws = require("ws");
const rfb = require("../../services/rfb");
const WRITE_ROLES = require("../../auth").WRITE_ROLES;
const parseSwitch = require("../../utils/args").parseSwitch;

const PATH = /^\/ws\/vnc\/([A-Za-z_][A-Za-z0-9_]*)$/;
const MAX_WS_MESSAGE = 1024 * 1024;
const MAX_CUT_TEXT = 1024 * 1024;
const MAX_ENCODINGS = 1024;
const MAX_FENCE_PAYLOAD = 64;
const MAX_SCREENS = 16;
// pause reading from the VNC server while the browser falls behind
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const DRAIN_POLL_MS = 50;
const SECURITY_NONE = 1;

const reply = (socket, status, text) => {
	socket.write("HTTP/1.1 " + status + " " + text + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
	socket.destroy();
};

const pathOf = (url) => {
	const s = String(url || "");
	const q = s.indexOf("?");
	return q === -1 ? s : s.slice(0, q);
};

const sameOrigin = (req) => {
	const origin = req.headers.origin;
	if (!origin) {
		return true;
	}
	try {
		return new URL(origin).host.toLowerCase() === String(req.headers.host || "").toLowerCase();
	} catch (_err) {
		return false;
	}
};

// the lab device behind a proxy path, only if it is a vnc device
const vncDevice = (lab, id) => {
	try {
		const device = lab.getDevice(id);
		return device.driver === "vnc" ? device : null;
	} catch (_err) {
		return null;
	}
};

const isViewOnly = (options) => {
	if (options.viewOnly === undefined) {
		return false;
	}
	try {
		return parseSwitch(options.viewOnly, "viewOnly");
	} catch (_err) {
		// an unparseable setting fails safe
		return true;
	}
};

/**
 * Read one RFB client-to-server message after ServerInit.
 * @param {Object} reader from rfb.createReader
 * @returns {Promise<{type: number, input: boolean, bytes: Buffer}>}
 *   input: keyboard, pointer, clipboard, desktop resize or power (xvp) -- dropped for viewers
 */
const readClientMessage = (reader) => {
	const msg = (type, input, parts) => ({ type: type, input: input, bytes: Buffer.concat(parts) });
	return reader.read(1).then((head) => {
		const type = head[0];
		if (type === 0) {
			return reader.read(19).then((rest) => msg(type, false, [head, rest]));
		}
		if (type === 2) {
			return reader.read(3).then((rest) => {
				const n = rest.readUInt16BE(1);
				if (n > MAX_ENCODINGS) {
					throw new Error("too many encodings: " + n);
				}
				return reader.read(4 * n).then((list) => msg(type, false, [head, rest, list]));
			});
		}
		if (type === 3) {
			return reader.read(9).then((rest) => msg(type, false, [head, rest]));
		}
		if (type === 4) {
			return reader.read(7).then((rest) => msg(type, true, [head, rest]));
		}
		if (type === 5) {
			// marker bit 0x80: extended pointer event, one more byte of buttons
			return reader.read(5).then((rest) => {
				if (!(rest[0] & 0x80)) {
					return msg(type, true, [head, rest]);
				}
				return reader.read(1).then((more) => msg(type, true, [head, rest, more]));
			});
		}
		if (type === 6) {
			return reader.read(7).then((rest) => {
				// negative length = extended clipboard
				const n = Math.abs(rest.readInt32BE(3));
				if (n > MAX_CUT_TEXT) {
					throw new Error("clipboard too large: " + n + " bytes");
				}
				return reader.read(n).then((text) => msg(type, true, [head, rest, text]));
			});
		}
		if (type === 150) {
			return reader.read(9).then((rest) => msg(type, false, [head, rest]));
		}
		if (type === 248) {
			return reader.read(8).then((rest) => {
				const n = rest[7];
				if (n > MAX_FENCE_PAYLOAD) {
					throw new Error("fence payload too large");
				}
				return reader.read(n).then((payload) => msg(type, false, [head, rest, payload]));
			});
		}
		if (type === 250) {
			return reader.read(3).then((rest) => msg(type, true, [head, rest]));
		}
		if (type === 251) {
			return reader.read(7).then((rest) => {
				const n = rest[5];
				if (n > MAX_SCREENS) {
					throw new Error("too many screens");
				}
				return reader.read(16 * n).then((screens) => msg(type, true, [head, rest, screens]));
			});
		}
		if (type === 255) {
			// QEMU client message; only the extended key event (subtype 0)
			return reader.read(1).then((sub) => {
				if (sub[0] !== 0) {
					throw new Error("unsupported QEMU message subtype " + sub[0]);
				}
				return reader.read(10).then((rest) => msg(type, true, [head, sub, rest]));
			});
		}
		throw new Error("unsupported client message type " + type);
	});
};

/**
 * Server side of the handshake towards the browser (security None).
 * Resolves once the browser sent ClientInit.
 * @param {Object} reader browser bytes
 * @param {function(Buffer)} send
 * @param {Promise<Object>} upstream rfb.open() towards the VNC server
 */
const greetBrowser = (reader, send, upstream) => {
	send(Buffer.from("RFB 003.008\n", "latin1"));
	const s = {};
	return reader.read(12)
		.then((version) => {
			s.minor = rfb.parseVersion(version);
			// a server problem goes to the browser as the refusal reason
			return upstream.then((conn) => {
				s.conn = conn;
			}, (err) => {
				s.error = err;
			});
		})
		.then(() => {
			if (s.error) {
				const reason = Buffer.from("VNC server: " + s.error.message, "utf8");
				const len = Buffer.alloc(4);
				len.writeUInt32BE(reason.length, 0);
				send(Buffer.concat([s.minor === 3 ? Buffer.alloc(4) : Buffer.from([0]), len, reason]));
				throw s.error;
			}
			if (s.minor === 3) {
				const type = Buffer.alloc(4);
				type.writeUInt32BE(SECURITY_NONE, 0);
				send(type);
				return null;
			}
			send(Buffer.from([1, SECURITY_NONE]));
			return reader.read(1).then((choice) => {
				if (choice[0] !== SECURITY_NONE) {
					throw new Error("browser chose security type " + choice[0]);
				}
				if (s.minor === 8) {
					send(Buffer.alloc(4));
				}
			});
		})
		.then(() => reader.read(1))
		.then(() => {
			send(s.conn.info.serverInit);
			return s.conn;
		});
};

/**
 * @param {Object} lab
 * @param {Object} auth from src/auth
 * @returns {{handles: function(Object): boolean, upgrade: function(Object, Object, Buffer), close: function}}
 */
const create = (lab, auth) => {
	const wss = new ws.Server({ noServer: true, maxPayload: MAX_WS_MESSAGE });

	const bridge = (client, deviceId, options, viewOnly) => {
		const reader = rfb.createReader();
		const state = { conn: null, closed: false, dropped: 0 };
		const upstream = rfb.open({ host: options.host || "127.0.0.1", port: Number(options.port) || rfb.DEFAULT_PORT, password: options.password });
		const close = () => {
			if (state.closed) {
				return;
			}
			state.closed = true;
			reader.fail(new Error("closed"));
			if (state.conn) {
				state.conn.socket.destroy();
			}
			if (client.readyState === ws.OPEN) {
				client.close();
			}
		};
		const send = (buf) => {
			if (client.readyState === ws.OPEN) {
				client.send(buf);
			}
		};
		client.on("message", (data) => reader.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
		client.on("close", close);
		client.on("error", close);
		upstream.then((conn) => {
			state.conn = conn;
			if (state.closed) {
				conn.socket.destroy();
			}
		}, () => null);

		const forward = () => {
			readClientMessage(reader).then((m) => {
				if (m.input && viewOnly) {
					state.dropped++;
				} else if (!state.closed) {
					state.conn.socket.write(m.bytes);
				}
				forward();
			}, (err) => {
				if (!state.closed) {
					lab.log(deviceId, "vnc pane: " + err.message, "warn");
				}
				close();
			});
		};

		greetBrowser(reader, send, upstream).then((conn) => {
			const socket = conn.socket;
			socket.removeListener("data", conn.reader.push);
			const pending = conn.reader.drain();
			if (pending.length) {
				send(pending);
			}
			const drain = () => {
				if (client.bufferedAmount > MAX_BUFFERED_BYTES && !state.closed) {
					setTimeout(drain, DRAIN_POLL_MS);
					return;
				}
				socket.resume();
			};
			socket.on("data", (chunk) => {
				send(chunk);
				if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
					socket.pause();
					setTimeout(drain, DRAIN_POLL_MS);
				}
			});
			socket.on("close", close);
			forward();
		}, (err) => {
			if (!state.closed) {
				lab.log(deviceId, "vnc pane: " + err.message, "warn");
			}
			// let the refusal reason reach the browser before closing
			setTimeout(close, DRAIN_POLL_MS);
		});
	};

	return {
		handles: (req) => PATH.test(pathOf(req.url)),

		upgrade: (req, socket, head) => {
			const id = PATH.exec(pathOf(req.url))[1];
			const who = auth.identify(req);
			if (!who) {
				reply(socket, 401, "Unauthorized");
				return;
			}
			if (!sameOrigin(req)) {
				reply(socket, 403, "Forbidden");
				return;
			}
			const device = vncDevice(lab, id);
			if (!device) {
				reply(socket, 404, "Not Found");
				return;
			}
			const options = device.options || {};
			const deviceViewOnly = isViewOnly(options);
			const viewOnly = WRITE_ROLES.indexOf(who.role) === -1 || deviceViewOnly;
			wss.handleUpgrade(req, socket, head, (client) => {
				lab.log(id, "vnc pane: " + who.name + " connected" + (viewOnly ? " (view-only)" : ""));
				bridge(client, id, options, viewOnly);
			});
		},

		close: () => {
			wss.clients.forEach((c) => c.terminate());
			wss.close();
		}
	};
};

module.exports = {
	create: create,
	readClientMessage: readClientMessage
};
