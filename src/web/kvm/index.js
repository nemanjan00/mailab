// The kvm pane's server side, bound to `nanokvm` devices only:
//   GET  /api/kvm/<device>/mjpeg   the screen as MJPEG, re-served from the
//                                  device's own KVM connection (the KVM
//                                  credentials never reach the browser)
//   GET  /api/kvm/<device>/status  LEDs, size, versions
//   POST /api/kvm/<device>/power   {action} power buttons, people only
//   WS   /ws/kvm/<device>          keyboard / mouse from the pane: one HID
//                                  message per WebSocket message ([1, 8-byte
//                                  keyboard report] or [2, 6-byte absolute /
//                                  4-byte relative mouse report]), validated
//                                  and forwarded by the device
//
// Same restrictions as the vnc bridge (src/web/vnc): lab auth (token /
// cookie), the Origin must match the Host whenever a browser sends one (and
// cross-site fetches are refused), and input is for people only: an AI with an
// rw token drives the KVM through device commands, which the approval policy
// can gate. Read-only users and view-only devices get a view-only socket.

const express = require("express");
const ws = require("ws");
const authModule = require("../../auth");
const mjpeg = require("../../utils/mjpeg");
const parseSwitch = require("../../utils/args").parseSwitch;

const WS_PATH = /^\/ws\/kvm\/([A-Za-z_][A-Za-z0-9_]*)$/;
const DRIVER = "nanokvm";
const BOUNDARY = "mailabframe";
const MAX_WS_MESSAGE = 64;
const MAX_VIEWERS = 8;
// skip frames for a viewer that is this far behind instead of buffering them
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

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
	if (req.headers["sec-fetch-site"] === "cross-site") {
		return false;
	}
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

const httpError = (status, message) => Object.assign(new Error(message), { status: status });

/**
 * @param {Object} lab
 * @param {Object} auth from src/auth
 * @returns {{router: Object, handles: function(Object): boolean, upgrade: function(Object, Object, Buffer), close: function}}
 */
const create = (lab, auth) => {
	const wss = new ws.Server({ noServer: true, maxPayload: MAX_WS_MESSAGE });
	const viewers = {};

	// the device, only if it is a nanokvm device
	const kvmDevice = (id) => {
		try {
			const device = lab.getDevice(id);
			return device.driver === DRIVER ? device : null;
		} catch (_err) {
			return null;
		}
	};

	const running = (id) => {
		const device = kvmDevice(id);
		if (!device) {
			throw httpError(404, "no nanokvm device " + id);
		}
		if (!device.instance || !device.instance.kvm) {
			throw httpError(503, "device " + id + " is not running");
		}
		return device;
	};

	const route = (handler) => (req, res) => {
		Promise.resolve()
			.then(() => handler(req, res))
			.then((result) => {
				if (!res.headersSent) {
					res.json(result === undefined ? { ok: true } : result);
				}
			}, (err) => {
				if (!res.headersSent) {
					res.status(err.status || 400).json({ error: err.message });
				}
			});
	};

	const router = express.Router();
	router.use((req, res, next) => {
		if (!sameOrigin(req)) {
			res.status(403).json({ error: "cross-origin request refused" });
			return;
		}
		next();
	});
	router.use(express.json({ limit: "4kb" }));

	router.get("/:id/mjpeg", route((req, res) => {
		const id = req.params.id;
		const device = running(id);
		if ((viewers[id] || 0) >= MAX_VIEWERS) {
			throw httpError(429, "too many viewers for " + id);
		}
		viewers[id] = (viewers[id] || 0) + 1;
		res.status(200);
		res.set({
			"Content-Type": "multipart/x-mixed-replace; boundary=" + BOUNDARY,
			"Cache-Control": "no-cache, no-store",
			"X-Content-Type-Options": "nosniff"
		});
		res.flushHeaders();
		const send = (frame) => {
			if (res.writableLength > MAX_BUFFERED_BYTES) {
				return;
			}
			res.write(mjpeg.part(BOUNDARY, frame.data));
		};
		const latest = device.instance.kvm.latest();
		if (latest) {
			send(latest);
		}
		const unwatch = device.instance.kvm.watch(send);
		res.on("close", () => {
			unwatch();
			viewers[id] = Math.max(0, (viewers[id] || 1) - 1);
		});
	}));

	router.get("/:id/status", route((req) => {
		running(req.params.id);
		return lab.commandDevice(req.params.id, "status", {});
	}));

	router.post("/:id/power", route((req) => {
		running(req.params.id);
		if (!authModule.isHuman(req.who)) {
			throw httpError(403, (req.who && req.who.name) + " is not a person (role human): AIs use device_command power, which needs approval");
		}
		const args = { action: String((req.body && req.body.action) || "") };
		const who = (req.who && req.who.name) || "local";
		return lab.commandDevice(req.params.id, "power", args).then((result) => {
			lab.recordActivity({ who: who, tool: "kvm_power", args: req.params.id + " " + args.action, ok: true });
			return result;
		}, (err) => {
			lab.recordActivity({ who: who, tool: "kvm_power", args: req.params.id + " " + args.action, ok: false, error: err.message });
			throw err;
		});
	}));

	return {
		router: router,

		handles: (req) => WS_PATH.test(pathOf(req.url)),

		upgrade: (req, socket, head) => {
			const id = WS_PATH.exec(pathOf(req.url))[1];
			const who = auth.identify(req);
			if (!who) {
				reply(socket, 401, "Unauthorized");
				return;
			}
			if (!sameOrigin(req)) {
				reply(socket, 403, "Forbidden");
				return;
			}
			const device = kvmDevice(id);
			if (!device) {
				reply(socket, 404, "Not Found");
				return;
			}
			// keyboard / mouse through the pane is for people: an AI with an rw
			// token drives the KVM with device commands, which the approval
			// policy can gate (this socket would bypass it)
			const viewOnly = who.role !== "human" || isViewOnly(device.options || {});
			wss.handleUpgrade(req, socket, head, (client) => {
				lab.log(id, "kvm pane: " + who.name + " connected" + (viewOnly ? " (view-only)" : ""));
				const state = { dropped: 0, warned: false };
				client.send(JSON.stringify({ type: "hello", viewOnly: viewOnly }));
				client.on("message", (data, isBinary) => {
					if (!isBinary || viewOnly) {
						state.dropped++;
						return;
					}
					const inst = lab.getDevice(id).instance;
					try {
						if (!inst || !inst.kvm) {
							throw new Error("device is not running");
						}
						inst.kvm.input(Buffer.isBuffer(data) ? data : Buffer.from(data));
					} catch (err) {
						state.dropped++;
						if (!state.warned) {
							state.warned = true;
							lab.log(id, "kvm pane input: " + err.message, "warn");
						}
						if (client.readyState === ws.OPEN) {
							client.send(JSON.stringify({ type: "error", error: err.message }));
						}
					}
				});
			});
		},

		close: () => {
			wss.clients.forEach((c) => c.terminate());
			wss.close();
		}
	};
};

module.exports = {
	create: create
};
