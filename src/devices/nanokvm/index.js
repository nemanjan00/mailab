// Sipeed NanoKVM (Cube Lite/Full, PCIe; NanoKVM-Pro Desk/ATX) as a lab device:
// the HDMI screen of a target machine, its USB keyboard/mouse and its ATX
// power/reset, through the KVM's own HTTP/WebSocket API. The AI uses the same
// commands as the `vnc` device (screenshot / type / key / click / move / drag /
// scroll / wait_change), plus power, virtual media (ISO) and stream settings;
// people use the `kvm` pane (MJPEG through /api/kvm/<id>/mjpeg, input through
// /ws/kvm/<id>, both served by src/web/kvm from this device's connection).
//
// Protocol (sipeed/NanoKVM abb83f34c8107e47da8bb1167e329e22ee6f4267, 2.5.4;
// the same on sipeed/NanoKVM-Pro 3b45b354118570fbf8257e13237ae1d793c78c39):
//   screen  GET /api/stream/mjpeg: multipart/x-mixed-replace; boundary=frame
//           (server/service/stream/mjpeg/streamer.go)
//   HID     WebSocket /api/ws, binary messages, first byte = event
//           (server/service/ws/client.go, web/src/lib/websocket.ts):
//             [0]                          heartbeat (web UI: every 10 s; server drops after 90 s)
//             [1, 8-byte boot keyboard report]
//             [2, buttons, xL, xH, yL, yH, wheel]  absolute mouse, x/y 0..0x7fff
//                                                  (web/src/lib/mouse.ts, pages/desktop/mouse/absolute.tsx)
//             [2, buttons, dx, dy, wheel]          relative mouse
//           buttons: 1 left, 2 right, 4 middle; wheel > 0 scrolls up
//           Firmware before 2.3.2 (CHANGELOG: "transmit keyboard and mouse data
//           using the standard HID format") used JSON arrays instead: not supported.
//   power   POST /api/vm/gpio {type: power|reset, duration: ms}; GET /api/vm/gpio {pwr, hdd}
//           (server/service/vm/gpio.go; web UI: short 800 ms, long 12 s)
//   media   GET /api/storage/image, /api/storage/image/mounted, POST /api/storage/image/mount
//           {file, cdrom} (the pre-2.6 API, kept by 2.5.3+ as a compatibility layer and
//           present on the Pro); POST /api/storage/media/eject {force} (2.5.3+)
//   screen  POST /api/vm/screen {type: fps|quality, value} (Cube/PCIe, server/service/vm/screen.go);
//   setup   POST /api/stream/fps {fps}, /api/stream/quality {quality} (Pro, server/router/stream.go)
//   info    GET /api/vm/info, /api/vm/hardware, /api/hid/leds (2.5.x)
//
// Everything here is verified only against the fake NanoKVM in the tests, not
// against hardware.

const nanokvm = require("../../services/nanokvm");
const raster = require("../../services/raster");
const mjpeg = require("../../utils/mjpeg");
const png = require("../../utils/png");
const hidkeys = require("../../utils/hidkeys");
const parseNumber = require("../../utils/args").parseNumber;
const parseSwitch = require("../../utils/args").parseSwitch;

const DEFAULTS = { host: "", username: "admin", password: "", fps: 0, viewOnly: false, verifyTls: false };
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
// a wrong password counts towards the KVM's brute-force lockout: retry slowly
const AUTH_RETRY_MS = 300000;
const HEARTBEAT_MS = 10000;
const MAX_FPS = 30;
const MAX_TEXT = 10000;
const KEY_DELAY_MS = 20;
const CLICK_DELAY_MS = 40;
const WAIT_DEFAULT_MS = 10000;
const WAIT_MAX_MS = 300000;
const FRAME_TIMEOUT_MS = 5000;
const STREAM_LINGER_MS = 5000;
const COMPARE_INTERVAL_MS = 200;
// a pixel counts as changed when a channel moves more than this (JPEG noise stays below)
const PIXEL_DIFF = 24;
const SCREENSHOT_LEVEL = 6;
const EVENT_HEARTBEAT = 0;
const EVENT_KEYBOARD = 1;
const EVENT_MOUSE = 2;
const ABS_MAX = 0x7fff;
const BUTTONS = { left: 1, right: 2, middle: 4, 1: 1, 2: 4, 3: 2 };
const SHORT_PRESS_MS = 800;
const LONG_PRESS_MS = 12000;
const POWER_ACTIONS = {
	on: { type: "power", ms: SHORT_PRESS_MS },
	// a short press: the OS shuts down if it handles the power button (ACPI)
	off: { type: "power", ms: SHORT_PRESS_MS },
	reset: { type: "reset", ms: SHORT_PRESS_MS },
	// held: forced off on ATX boards
	long_press: { type: "power", ms: LONG_PRESS_MS }
};
const PRESS_MIN_MS = 100;
const PRESS_MAX_MS = 30000;
const SCREEN_FPS_MIN = 10;
const SCREEN_FPS_MAX = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// run steps one after another with a pause after each
const sequence = (steps, delayMs) => steps.reduce((p, step) => p.then(() => {
	step();
	return sleep(delayMs);
}), Promise.resolve());

/**
 * Copy a region out of packed RGB.
 */
const cropRgb = (rgb, width, region) => {
	const out = Buffer.alloc(region.w * region.h * 3);
	Array.from({ length: region.h }, (_, row) => row).forEach((row) => {
		const src = ((region.y + row) * width + region.x) * 3;
		rgb.copy(out, row * region.w * 3, src, src + region.w * 3);
	});
	return out;
};

/**
 * Pixels whose largest channel difference exceeds PIXEL_DIFF.
 */
const changedPixels = (a, b) => {
	let n = 0;
	// hot path (whole screens): a plain loop
	for (let i = 0; i < a.length; i += 3) {
		const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
		if (d > PIXEL_DIFF) {
			n++;
		}
	}
	return n;
};

/**
 * Absolute mouse report (6 bytes) for screen pixel x, y on a width x height screen.
 */
const absoluteReport = (x, y, size, buttons, wheel) => {
	const scale = (v, n) => Math.min(ABS_MAX, Math.max(1, Math.round(v * ABS_MAX / Math.max(1, n - 1))));
	const r = Buffer.alloc(6);
	r[0] = buttons;
	r.writeUInt16LE(scale(x, size.width), 1);
	r.writeUInt16LE(scale(y, size.height), 3);
	r.writeInt8(Math.max(-127, Math.min(127, wheel || 0)), 5);
	return r;
};

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	settings.fps = parseNumber(settings.fps, "fps", { min: 0, max: MAX_FPS });
	settings.viewOnly = parseSwitch(settings.viewOnly, "viewOnly");
	settings.verifyTls = parseSwitch(settings.verifyTls, "verifyTls");
	if (settings.quality !== undefined && settings.quality !== "") {
		settings.quality = Math.round(parseNumber(settings.quality, "quality", { min: 1, max: 100 }));
	}
	const kvm = nanokvm.create({ host: settings.host, username: settings.username, password: settings.password, verifyTls: settings.verifyTls });
	const target = kvm.base.origin;
	const st = {
		sock: null, connected: false, stopping: false, backoff: BACKOFF_MIN_MS, retry: null, heartbeat: null,
		reconnects: 0, lastError: "", info: {}, events: {}, buttons: 0, x: 0, y: 0,
		frame: null, frames: 0, stream: null, streamOpening: false, streamSince: 0, streamBackoff: BACKOFF_MIN_MS,
		streamRetry: null, linger: null, pushTimer: null, pushedSeq: 0, pushFps: settings.fps, unpush: null
	};
	const watchers = new Set();
	const waiters = new Set();

	// ---- screen (MJPEG) ---------------------------------------------------

	const onFrame = (data) => {
		const kind = raster.sniff(data);
		if (!kind || kind.mime !== "image/jpeg") {
			return;
		}
		st.frames++;
		st.frame = { data: data, t: Date.now(), width: kind.width, height: kind.height, seq: st.frames };
		watchers.forEach((w) => w(st.frame));
	};

	const closeStream = () => {
		clearTimeout(st.streamRetry);
		st.streamRetry = null;
		if (st.stream) {
			const res = st.stream;
			st.stream = null;
			res.destroy();
		}
	};

	const openStream = () => {
		if (st.stream || st.streamOpening || st.stopping || !watchers.size) {
			return;
		}
		st.streamOpening = true;
		kvm.stream("/api/stream/mjpeg").then((res) => {
			st.streamOpening = false;
			if (st.stopping || !watchers.size) {
				res.destroy();
				return;
			}
			const parser = mjpeg.createParser(mjpeg.boundaryOf(res.headers["content-type"]) || "frame", onFrame);
			let ended = false;
			const end = (err) => {
				if (ended) {
					return;
				}
				ended = true;
				if (st.stream === res) {
					st.stream = null;
				}
				if (st.stopping || !watchers.size) {
					return;
				}
				io.log("screen stream ended: " + (err ? err.message : "closed by the KVM"), "warn");
				st.streamRetry = setTimeout(openStream, st.streamBackoff);
				st.streamBackoff = Math.min(BACKOFF_MAX_MS, st.streamBackoff * 2);
			};
			st.stream = res;
			st.streamSince = Date.now();
			res.on("data", (chunk) => {
				st.streamBackoff = BACKOFF_MIN_MS;
				try {
					parser.push(chunk);
				} catch (err) {
					res.destroy(err);
				}
			});
			res.on("error", end);
			res.on("close", () => end(null));
		}, (err) => {
			st.streamOpening = false;
			if (st.stopping || !watchers.size) {
				return;
			}
			st.lastError = err.message;
			io.log("screen stream: " + err.message, "warn");
			st.streamRetry = setTimeout(openStream, st.streamBackoff);
			st.streamBackoff = Math.min(BACKOFF_MAX_MS, st.streamBackoff * 2);
		});
	};

	/**
	 * Get every frame while subscribed; the stream runs while anyone watches
	 * (and a few seconds after, so screenshot bursts reuse it).
	 * @returns {function} unsubscribe
	 */
	const watch = (fn) => {
		watchers.add(fn);
		clearTimeout(st.linger);
		st.linger = null;
		openStream();
		return () => {
			if (!watchers.delete(fn) || watchers.size) {
				return;
			}
			clearTimeout(st.linger);
			st.linger = setTimeout(() => {
				st.linger = null;
				if (!watchers.size) {
					closeStream();
				}
			}, STREAM_LINGER_MS);
		};
	};

	const nextFrame = (timeoutMs) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unwatch();
			reject(new Error("no screen frame from " + target + " within " + (timeoutMs || FRAME_TIMEOUT_MS) + " ms"
				+ (st.lastError ? " (" + st.lastError + ")" : "") + "; is the HDMI input connected?"));
		}, timeoutMs || FRAME_TIMEOUT_MS);
		const unwatch = watch((frame) => {
			clearTimeout(timer);
			unwatch();
			resolve(frame);
		});
	});

	// the latest frame while the stream is live (the KVM may skip unchanged frames), else a fresh one
	const currentFrame = () => {
		if (st.stream && st.frame && st.frame.t >= st.streamSince) {
			return Promise.resolve(st.frame);
		}
		return nextFrame();
	};

	const screenSize = () => currentFrame().then((f) => ({ width: f.width, height: f.height }));

	const regionOf = (r, size) => {
		if (!r) {
			return { x: 0, y: 0, w: size.width, h: size.height };
		}
		const x = Math.round(parseNumber(r.x || 0, "region.x", { min: 0, max: size.width - 1 }));
		const y = Math.round(parseNumber(r.y || 0, "region.y", { min: 0, max: size.height - 1 }));
		const w = Math.round(parseNumber(r.w === undefined ? size.width - x : r.w, "region.w", { min: 1 }));
		const h = Math.round(parseNumber(r.h === undefined ? size.height - y : r.h, "region.h", { min: 1 }));
		return { x: x, y: y, w: Math.min(w, size.width - x), h: Math.min(h, size.height - y) };
	};

	const decodeRegion = (frame, region) => raster.rgb(frame.data).then((img) => {
		if (region.x + region.w > img.width || region.y + region.h > img.height) {
			throw new Error("screen resized to " + img.width + "x" + img.height);
		}
		return cropRgb(img.data, img.width, region);
	});

	const pushLatest = () => {
		if (st.frame && st.frame.seq !== st.pushedSeq) {
			st.pushedSeq = st.frame.seq;
			io.image("screen", st.frame.data, "image/jpeg");
		}
	};

	const setPush = (fps) => {
		clearInterval(st.pushTimer);
		st.pushTimer = null;
		if (st.unpush) {
			st.unpush();
			st.unpush = null;
		}
		st.pushFps = fps;
		if (fps > 0 && !st.stopping) {
			st.unpush = watch(() => null);
			st.pushTimer = setInterval(pushLatest, 1000 / fps);
		}
	};

	// ---- keyboard / mouse (HID websocket) ----------------------------------

	const scheduleReconnect = (waitMs) => {
		if (st.stopping || st.retry) {
			return;
		}
		const wait = waitMs || st.backoff;
		st.backoff = Math.min(BACKOFF_MAX_MS, st.backoff * 2);
		io.log("reconnecting to " + target + " in " + wait + " ms", "warn");
		st.retry = setTimeout(() => {
			st.retry = null;
			st.reconnects++;
			connect();
		}, wait);
	};

	const loadInfo = () => Promise.all([
		kvm.api("GET", "/api/vm/info").catch(() => null),
		kvm.api("GET", "/api/vm/hardware").catch(() => null)
	]).then((r) => {
		st.info = {
			application: r[0] && r[0].application ? r[0].application : "",
			image: r[0] && r[0].image ? r[0].image : "",
			mdns: r[0] && r[0].mdns ? r[0].mdns : "",
			hardware: r[1] && r[1].version ? r[1].version : ""
		};
	});

	const connect = () => {
		const session = kvm.hasSession() ? Promise.resolve() : kvm.login();
		return session
			.then(() => kvm.socket("/api/ws"))
			.then((sock) => {
				if (st.stopping) {
					sock.terminate();
					return null;
				}
				st.sock = sock;
				st.connected = true;
				st.backoff = BACKOFF_MIN_MS;
				st.lastError = "";
				sock.removeAllListeners("error");
				sock.on("error", (err) => {
					st.lastError = err.message;
				});
				sock.on("message", (data, isBinary) => {
					if (isBinary) {
						return;
					}
					try {
						const msg = JSON.parse(data.toString());
						if (msg && typeof msg.type === "string") {
							st.events[msg.type] = msg.data;
						}
					} catch (_err) {
						// not JSON: ignore
					}
				});
				sock.on("close", (code, reason) => {
					if (st.sock !== sock) {
						return;
					}
					st.sock = null;
					st.connected = false;
					clearInterval(st.heartbeat);
					if (st.stopping) {
						return;
					}
					st.lastError = "HID socket closed (" + code + (reason && reason.length ? " " + reason.toString() : "") + ")";
					io.status("error", "disconnected: " + st.lastError);
					io.log("disconnected from " + target + ": " + st.lastError, "warn");
					scheduleReconnect();
				});
				clearInterval(st.heartbeat);
				st.heartbeat = setInterval(() => {
					if (sock.readyState === sock.OPEN) {
						sock.send(Buffer.from([EVENT_HEARTBEAT]));
					}
				}, HEARTBEAT_MS);
				return loadInfo().then(() => {
					const what = [st.info.hardware && "hw " + st.info.hardware, st.info.application && "app " + st.info.application].filter(Boolean).join(", ");
					io.status("running", target + (what ? " (" + what + ")" : ""));
					io.log("connected to " + target + (what ? " (" + what + ")" : "") + (settings.viewOnly ? ", view-only" : ""));
					if (settings.quality !== undefined && settings.quality !== "") {
						return commands.stream({ quality: settings.quality }).catch((err) => io.log("quality " + settings.quality + ": " + err.message, "warn"));
					}
					return null;
				});
			})
			.catch((err) => {
				st.lastError = err.message;
				if (st.stopping) {
					return;
				}
				io.status("error", err.message);
				io.log("connect to " + target + " failed: " + err.message, "error");
				scheduleReconnect(/login failed/.test(err.message) ? AUTH_RETRY_MS : 0);
			});
	};

	const connected = () => {
		if (!st.sock || !st.connected) {
			throw new Error("not connected to " + target + (st.lastError ? ": " + st.lastError : ""));
		}
		return st.sock;
	};

	const writable = () => {
		if (settings.viewOnly) {
			throw new Error("device is view-only (option viewOnly)");
		}
	};

	const input = () => {
		writable();
		return connected();
	};

	const send = (event, report) => {
		connected().send(Buffer.concat([Buffer.from([event]), report]));
	};

	const sendKeys = (reports, delayMs) => sequence(reports.map((r) => () => send(EVENT_KEYBOARD, r)), delayMs === undefined ? KEY_DELAY_MS : delayMs);

	const point = (a, size, prefix) => ({
		x: Math.round(parseNumber(a.x, (prefix || "") + "x", { min: 0, max: size.width - 1 })),
		y: Math.round(parseNumber(a.y, (prefix || "") + "y", { min: 0, max: size.height - 1 }))
	});

	const buttonMask = (button) => {
		const b = button === undefined ? "left" : String(button).toLowerCase();
		if (!BUTTONS[b]) {
			throw new Error("button must be left, middle or right");
		}
		return BUTTONS[b];
	};

	const pointer = (x, y, size, mask, wheel) => {
		st.x = Math.round(x);
		st.y = Math.round(y);
		st.buttons = mask;
		send(EVENT_MOUSE, absoluteReport(x, y, size, mask, wheel));
	};

	const gpio = () => kvm.api("GET", "/api/vm/gpio").then((d) => ({ power: Boolean(d && d.pwr), hdd: Boolean(d && d.hdd) }), () => null);

	const mediaList = () => kvm.api("GET", "/api/storage/image").then((d) => (d && Array.isArray(d.files) ? d.files : []));

	// Cube / PCIe first, then the Pro's API
	const screenSetting = (type, value) => kvm.api("POST", "/api/vm/screen", { type: type, value: value })
		.then(() => "vm/screen", (err) => {
			if (err.status !== 404) {
				throw err;
			}
			const body = {};
			body[type] = value;
			return kvm.api("POST", "/api/stream/" + type, body).then(() => "stream/" + type);
		});

	const commands = {
		screenshot: (a) => currentFrame().then((frame) => {
			if (!a.region) {
				io.image("screen", frame.data, "image/jpeg");
				return { image: io.id + "_screen", width: frame.width, height: frame.height, bytes: frame.data.length,
					_image: { data: frame.data.toString("base64"), mime: "image/jpeg" } };
			}
			const region = regionOf(a.region, frame);
			return decodeRegion(frame, region).then((rgb) => {
				const out = png.encode({ width: region.w, height: region.h, channels: 3, data: rgb, level: SCREENSHOT_LEVEL });
				io.image("screen", out, "image/png");
				return { image: io.id + "_screen", region: region, bytes: out.length, _image: { data: out.toString("base64"), mime: "image/png" } };
			});
		}),

		type: (a) => {
			input();
			const text = String(a.text === undefined ? "" : a.text);
			if (!text || text.length > MAX_TEXT) {
				throw new Error("text must be 1.." + MAX_TEXT + " characters");
			}
			return sendKeys(hidkeys.typeReports(text), a.delayMs).then(() => ({ typed: text.length }));
		},

		key: (a) => {
			input();
			const reports = hidkeys.comboReports(a.keys);
			return sendKeys(reports, a.delayMs).then(() => ({ keys: a.keys, reports: reports.length }));
		},

		move: (a) => {
			input();
			return screenSize().then((size) => {
				const p = point(a, size);
				pointer(p.x, p.y, size, st.buttons, 0);
				return { x: p.x, y: p.y };
			});
		},

		click: (a) => {
			input();
			return screenSize().then((size) => {
				const p = point(a, size);
				const mask = buttonMask(a.button);
				const once = [() => pointer(p.x, p.y, size, 0), () => pointer(p.x, p.y, size, mask), () => pointer(p.x, p.y, size, 0)];
				const doubled = parseSwitch(a.double === undefined ? false : a.double, "double");
				return sequence(doubled ? once.concat(once.slice(1)) : once, CLICK_DELAY_MS).then(() => ({ x: p.x, y: p.y, double: doubled }));
			});
		},

		drag: (a) => {
			input();
			return screenSize().then((size) => {
				const from = point(a.from || { x: a.x1, y: a.y1 }, size, "from.");
				const to = point(a.to || { x: a.x2, y: a.y2 }, size, "to.");
				const mask = buttonMask(a.button);
				const steps = Math.round(parseNumber(a.steps === undefined ? 10 : a.steps, "steps", { min: 1, max: 200 }));
				const path = Array.from({ length: steps }, (_, i) => (i + 1) / steps)
					.map((f) => () => pointer(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f, size, mask));
				return sequence([() => pointer(from.x, from.y, size, 0), () => pointer(from.x, from.y, size, mask)].concat(path, [() => pointer(to.x, to.y, size, 0)]), CLICK_DELAY_MS)
					.then(() => ({ from: from, to: to }));
			});
		},

		scroll: (a) => {
			input();
			return screenSize().then((size) => {
				const p = point(a, size);
				const dy = Math.round(parseNumber(a.dy === undefined ? 1 : a.dy, "dy", { min: -50, max: 50 }));
				// HID wheel > 0 scrolls up; dy < 0 means up (like the vnc device)
				const wheel = dy < 0 ? 1 : -1;
				const ticks = Array.from({ length: Math.abs(dy) }, () => [() => pointer(p.x, p.y, size, st.buttons, wheel), () => pointer(p.x, p.y, size, st.buttons, 0)])
					.reduce((all, t) => all.concat(t), []);
				return sequence([() => pointer(p.x, p.y, size, st.buttons, 0)].concat(ticks), CLICK_DELAY_MS).then(() => ({ x: p.x, y: p.y, dy: dy }));
			});
		},

		wait_change: (a) => {
			const timeoutMs = parseNumber(a.timeoutMs === undefined ? WAIT_DEFAULT_MS : a.timeoutMs, "timeoutMs", { min: 0, max: WAIT_MAX_MS });
			const settleMs = parseNumber(a.settleMs === undefined ? 0 : a.settleMs, "settleMs", { min: 0, max: WAIT_MAX_MS });
			const threshold = parseNumber(a.threshold === undefined ? 0 : a.threshold, "threshold", { min: 0, max: 1 });
			const started = Date.now();
			return currentFrame().then((first) => {
				const region = regionOf(a.region, first);
				const limit = Math.max(1, Math.ceil(threshold * region.w * region.h));
				return decodeRegion(first, region).then((base) => new Promise((resolve) => {
					const w = { changedAt: 0, prevData: first.data, prev: base, busy: false, pending: null, timer: null, settle: null, unwatch: null };
					const finish = (changed, settled) => {
						if (w.done) {
							return;
						}
						w.done = true;
						clearTimeout(w.timer);
						clearTimeout(w.settle);
						waiters.delete(w);
						if (w.unwatch) {
							w.unwatch();
						}
						// settled: false when the region changed but never went still (a blinking cursor)
						const result = { changed: changed, settled: Boolean(settled), ms: Date.now() - started, region: region };
						if (changed && a.screenshot && st.frame) {
							io.image("screen", st.frame.data, "image/jpeg");
							result._image = { data: st.frame.data.toString("base64"), mime: "image/jpeg" };
						}
						resolve(result);
					};
					w.finish = finish;
					const armSettle = () => {
						clearTimeout(w.settle);
						w.settle = setTimeout(() => finish(true, true), settleMs);
					};
					const examine = (frame) => {
						if (w.done) {
							return;
						}
						if (w.busy) {
							w.pending = frame;
							return;
						}
						// identical JPEG bytes: an identical screen, no decoding needed
						if (frame.data.equals(w.prevData)) {
							return;
						}
						w.busy = true;
						decodeRegion(frame, region).then((rgb) => {
							const fromBase = changedPixels(rgb, base) >= limit;
							const fromPrev = changedPixels(rgb, w.prev) >= limit;
							w.prevData = frame.data;
							w.prev = rgb;
							if (!w.changedAt) {
								if (!fromBase) {
									return;
								}
								w.changedAt = Date.now();
								if (!settleMs) {
									finish(true, true);
									return;
								}
								armSettle();
							} else if (fromPrev) {
								// done once the region stops changing for settleMs
								armSettle();
							}
						}, (err) => {
							// the screen was resized under the region: that's a change too;
							// a frame that doesn't decode is skipped
							if (/resized/.test(err.message)) {
								finish(true, false);
							}
						}).then(() => setTimeout(() => {
							w.busy = false;
							const next = w.pending;
							w.pending = null;
							if (next) {
								examine(next);
							}
						}, COMPARE_INTERVAL_MS));
					};
					w.timer = setTimeout(() => finish(Boolean(w.changedAt), false), timeoutMs);
					waiters.add(w);
					w.unwatch = watch(examine);
				}));
			});
		},

		power: (a) => {
			writable();
			const action = String(a.action === undefined ? "" : a.action).toLowerCase();
			const spec = POWER_ACTIONS[action];
			if (!spec) {
				throw new Error("action must be one of " + Object.keys(POWER_ACTIONS).join(", "));
			}
			const ms = Math.round(a.durationMs === undefined ? spec.ms : parseNumber(a.durationMs, "durationMs", { min: PRESS_MIN_MS, max: PRESS_MAX_MS }));
			const s = {};
			return gpio()
				.then((leds) => {
					s.before = leds;
					io.log("power: " + action + " (" + spec.type + " button " + ms + " ms)");
					// the KVM answers after releasing the button
					return kvm.api("POST", "/api/vm/gpio", { type: spec.type, duration: ms }, ms + 10000);
				})
				.then(gpio)
				.then((leds) => ({ action: action, button: spec.type, ms: ms, ledBefore: s.before, ledAfter: leds }));
		},

		status: () => Promise.all([
			gpio(),
			kvm.api("GET", "/api/hid/leds").catch(() => null)
		]).then((r) => ({
			connected: st.connected,
			host: target,
			username: settings.username,
			application: st.info.application || "",
			image: st.info.image || "",
			hardware: st.info.hardware || "",
			leds: {
				power: r[0] ? r[0].power : null,
				hdd: r[0] ? r[0].hdd : null,
				numLock: r[1] && r[1].known ? Boolean(r[1].numLock) : null,
				capsLock: r[1] && r[1].known ? Boolean(r[1].capsLock) : null,
				scrollLock: r[1] && r[1].known ? Boolean(r[1].scrollLock) : null
			},
			width: st.frame ? st.frame.width : 0,
			height: st.frame ? st.frame.height : 0,
			streaming: Boolean(st.stream),
			frames: st.frames,
			fps: st.pushFps,
			viewOnly: settings.viewOnly,
			reconnects: st.reconnects,
			logins: kvm.logins(),
			lastError: st.lastError,
			pointer: { x: st.x, y: st.y, buttons: st.buttons }
		})),

		iso_list: () => Promise.all([
			mediaList(),
			kvm.api("GET", "/api/storage/image/mounted").catch(() => null),
			kvm.api("GET", "/api/storage/cdrom").catch(() => null)
		]).then((r) => ({
			files: r[0],
			mounted: r[1] && r[1].file ? r[1].file : "",
			cdrom: r[2] ? Boolean(r[2].cdrom) : null
		})),

		iso_mount: (a) => {
			writable();
			const want = String(a.file === undefined ? "" : a.file).trim();
			if (!want) {
				throw new Error("file is required (see iso_list)");
			}
			const cdrom = parseSwitch(a.cdrom === undefined ? false : a.cdrom, "cdrom");
			return mediaList().then((files) => {
				// only images the KVM lists: a full path or a unique file name
				const exact = files.filter((f) => f === want);
				const named = files.filter((f) => f.split("/").pop() === want);
				const file = exact[0] || (named.length === 1 ? named[0] : null);
				if (!file) {
					throw new Error(named.length > 1 ? "ambiguous file " + want + ": " + named.join(", ") : "no such image on the KVM: " + want + " (have: " + (files.join(", ") || "none") + ")");
				}
				return kvm.api("POST", "/api/storage/image/mount", { file: file, cdrom: cdrom }, 60000).then(() => {
					io.log("mounted " + file + (cdrom ? " as CD-ROM" : " as USB disk"));
					return { mounted: file, cdrom: cdrom };
				});
			});
		},

		iso_unmount: () => {
			writable();
			// 2.5.3+: eject; older firmware and the Pro: mount nothing
			return kvm.api("POST", "/api/storage/media/eject", { force: false }, 60000)
				.then(() => "media/eject", (err) => {
					if (err.status !== 404) {
						throw err;
					}
					return kvm.api("POST", "/api/storage/image/mount", { file: "", cdrom: false }, 60000).then(() => "image/mount");
				})
				.then((api) => {
					io.log("unmounted the virtual media");
					return { unmounted: true, api: api };
				});
		},

		stream: (a) => {
			const out = {};
			const steps = [];
			if (a.fps !== undefined) {
				out.fps = Math.round(parseNumber(a.fps, "fps", { min: SCREEN_FPS_MIN, max: SCREEN_FPS_MAX }));
				steps.push(() => screenSetting("fps", out.fps).then((api) => {
					out.api = api;
				}));
			}
			if (a.quality !== undefined) {
				out.quality = Math.round(parseNumber(a.quality, "quality", { min: 1, max: 100 }));
				steps.push(() => screenSetting("quality", out.quality).then((api) => {
					out.api = api;
				}));
			}
			if (a.push !== undefined) {
				out.push = parseNumber(a.push, "push", { min: 0, max: MAX_FPS });
				steps.push(() => setPush(out.push));
			}
			if (!steps.length) {
				throw new Error("give fps (10..60, the KVM's encoder), quality (MJPEG: 50, 60, 80 or 100 on the Cube) and/or push (lab image rate, 0..30)");
			}
			return steps.reduce((p, step) => p.then(step), Promise.resolve()).then(() => out);
		}
	};

	return {
		start: () => {
			setPush(settings.fps);
			return connect();
		},

		stop: () => {
			st.stopping = true;
			clearTimeout(st.retry);
			clearInterval(st.heartbeat);
			clearInterval(st.pushTimer);
			clearTimeout(st.linger);
			waiters.forEach((w) => w.finish(false, false));
			watchers.clear();
			closeStream();
			if (st.sock) {
				st.sock.terminate();
				st.sock = null;
			}
			kvm.close();
			return Promise.resolve();
		},

		command: (name, args) => {
			if (!Object.prototype.hasOwnProperty.call(commands, name)) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		},

		// for the kvm pane (src/web/kvm): the shared screen stream and raw HID
		kvm: {
			watch: watch,
			latest: () => st.frame,
			viewOnly: () => settings.viewOnly,
			/**
			 * Forward one validated HID message ([1, 8 bytes] keyboard, [2, 6 bytes]
			 * absolute or [2, 4 bytes] relative mouse) from a person's pane.
			 */
			input: (msg) => {
				writable();
				const ok = (msg[0] === EVENT_KEYBOARD && msg.length === 9) || (msg[0] === EVENT_MOUSE && (msg.length === 7 || msg.length === 5));
				if (!ok) {
					throw new Error("bad HID message");
				}
				connected().send(msg);
			}
		}
	};
};

module.exports = {
	name: "nanokvm",
	description: "Sipeed NanoKVM IP-KVM (Cube Lite/Full, PCIe, Pro; firmware 2.3.2+): the target's HDMI screen as image <id>_screen (MJPEG), "
		+ "USB keyboard/mouse with the vnc device's commands, ATX power/reset, virtual media (ISO); the kvm pane shows it live",
	options: {
		host: "KVM address: 192.168.1.50, http://nanokvm.lan or https://... (only this host is contacted; redirects are refused)",
		username: "web login (default admin)",
		password: "web password. Masked in listings, never logged",
		fps: "push image <id>_screen this many times a second (keeps the MJPEG stream open; default 0 = only on screenshot)",
		quality: "set the KVM's MJPEG quality on connect (Cube: 50, 60, 80 or 100)",
		verifyTls: "check the https certificate (default false: the KVM's is self-signed)",
		viewOnly: "true: refuse input, power and media commands; the pane is view-only"
	},
	commands: {
		screenshot: "{region: {x, y, w, h}} the screen as image <id>_screen (JPEG; a region is cropped to PNG), returned to the AI",
		type: "{text, delayMs: 20} type ASCII text on a US layout (\\n = Enter, \\t = Tab)",
		key: "{keys: \"ctrl+alt+del\" | \"alt+f4\" | \"F10\" | \"alt+f x\" | [\"ctrl+c\", \"enter\"], delayMs} key combos, in order",
		click: "{x, y, button: left|middle|right, double: false} screen pixels (absolute mouse)",
		move: "{x, y} move the pointer",
		drag: "{from: {x, y}, to: {x, y}, button: left, steps: 10}",
		scroll: "{x, y, dy} wheel clicks (negative = up)",
		wait_change: "{timeoutMs: 10000, region: {x, y, w, h}, settleMs: 0, threshold: 0, screenshot: false} resolve when the region changes "
			+ "(threshold: fraction of its pixels; then still for settleMs: settled); {changed: false} on timeout",
		power: "{action: on|off|reset|long_press, durationMs} press the ATX power (800 ms; long_press 12 s = forced off) or reset button; LEDs before/after",
		status: "connection, firmware/hardware version, LEDs (power, HDD, num/caps/scroll lock), screen size, stream state",
		iso_list: "images on the KVM's virtual media storage, the mounted one, CD-ROM mode",
		iso_mount: "{file, cdrom: false} attach an image (full path or unique name from iso_list) to the target as USB disk or CD-ROM",
		iso_unmount: "detach the virtual media",
		stream: "{fps: 10..60, quality: 50|60|80|100, push: 0..30} the KVM's MJPEG encoder settings; push = lab image rate"
	},
	create: create,
	_absoluteReport: absoluteReport
};
