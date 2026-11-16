// VNC (RFB) desktop as a lab device: legacy GUIs (a Windows 3.1 dealer
// programmer in an emulator, a vendor tool in a VM) that both the person and
// the AI need to see and drive. The device keeps a server-side connection and
// framebuffer; the AI uses screenshot / type / key / click / wait_change, the
// person uses the `vnc` pane (noVNC through /ws/vnc/<id>, which opens its own
// connection with the same host, port and password).
//
// Input commands go through device_command, so the approval policy can gate
// them. The password stays in the device options: it is masked in device
// listings and activity previews and never logged.

const rfb = require("../../services/rfb");
const png = require("../../utils/png");
const keysym = require("../../utils/keysym");
const parseNumber = require("../../utils/args").parseNumber;
const parseSwitch = require("../../utils/args").parseSwitch;

const DEFAULTS = { host: "127.0.0.1", port: rfb.DEFAULT_PORT, fps: 0, viewOnly: false };
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const UPDATE_MIN_INTERVAL_MS = 30;
const MAX_FPS = 30;
const MAX_TEXT = 10000;
const KEY_DELAY_MS = 20;
const CLICK_DELAY_MS = 40;
const WAIT_DEFAULT_MS = 10000;
const WAIT_MAX_MS = 300000;
const SCREENSHOT_LEVEL = 6;
const BUTTONS = { left: 1, middle: 2, right: 4, 1: 1, 2: 2, 3: 4 };
const WHEEL_UP = 8;
const WHEEL_DOWN = 16;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// run steps one after another with a pause after each
const sequence = (steps, delayMs) => steps.reduce((p, step) => p.then(() => {
	step();
	return sleep(delayMs);
}), Promise.resolve());

const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Copy a region of an RGBX framebuffer out as packed RGB.
 */
const cropRgb = (fb, width, region) => {
	const out = Buffer.alloc(region.w * region.h * 3);
	const bpp = rfb.BYTES_PER_PIXEL;
	Array.from({ length: region.h }, (_, row) => row).forEach((row) => {
		const src = ((region.y + row) * width + region.x) * bpp;
		const dst = row * region.w * 3;
		// hot path (whole screens per update): a plain loop, not per-pixel Buffer.copy
		for (let col = 0; col < region.w; col++) {
			out[dst + col * 3] = fb[src + col * bpp];
			out[dst + col * 3 + 1] = fb[src + col * bpp + 1];
			out[dst + col * 3 + 2] = fb[src + col * bpp + 2];
		}
	});
	return out;
};

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	settings.port = parseNumber(settings.port, "port", { min: 1, max: 65535 });
	settings.fps = parseNumber(settings.fps, "fps", { min: 0, max: MAX_FPS });
	settings.viewOnly = parseSwitch(settings.viewOnly, "viewOnly");
	const st = { client: null, connected: false, stopping: false, backoff: BACKOFF_MIN_MS, retry: null, fpsTimer: null, dirty: false, reconnects: 0, lastError: "", clipboard: "", buttons: 0, x: 0, y: 0 };
	const waiters = new Set();
	const target = settings.host + ":" + settings.port;

	const regionOf = (r) => {
		const c = st.client;
		if (!r) {
			return { x: 0, y: 0, w: c.width, h: c.height };
		}
		const x = Math.round(parseNumber(r.x || 0, "region.x", { min: 0, max: c.width - 1 }));
		const y = Math.round(parseNumber(r.y || 0, "region.y", { min: 0, max: c.height - 1 }));
		const w = Math.round(parseNumber(r.w === undefined ? c.width - x : r.w, "region.w", { min: 1 }));
		const h = Math.round(parseNumber(r.h === undefined ? c.height - y : r.h, "region.h", { min: 1 }));
		return { x: x, y: y, w: Math.min(w, c.width - x), h: Math.min(h, c.height - y) };
	};

	const encodeScreen = (region) => {
		const c = st.client;
		const r = regionOf(region);
		return { region: r, png: png.encode({ width: r.w, height: r.h, channels: 3, data: cropRgb(c.framebuffer, c.width, r), level: SCREENSHOT_LEVEL }) };
	};

	const pushScreen = () => {
		st.dirty = false;
		io.image("screen", encodeScreen().png, "image/png");
	};

	const onUpdate = (rects) => {
		st.dirty = true;
		waiters.forEach((w) => {
			try {
				w.check(rects);
			} catch (_err) {
				// the desktop was resized under the region: that's a change too
				w.finish(true);
			}
		});
	};

	const scheduleReconnect = () => {
		if (st.stopping || st.retry) {
			return;
		}
		const wait = st.backoff;
		st.backoff = Math.min(BACKOFF_MAX_MS, st.backoff * 2);
		io.log("reconnecting to " + target + " in " + wait + " ms", "warn");
		st.retry = setTimeout(() => {
			st.retry = null;
			st.reconnects++;
			connect();
		}, wait);
	};

	const connect = () => {
		const c = rfb.connect({ host: settings.host, port: settings.port, password: settings.password, minIntervalMs: UPDATE_MIN_INTERVAL_MS });
		st.client = c;
		c.on("update", onUpdate);
		c.on("resize", (size) => io.log("desktop resized to " + size.width + "x" + size.height));
		c.on("cut", (text) => {
			st.clipboard = text;
			io.value("clipboard", { text: text });
		});
		c.on("close", (err) => {
			if (st.client !== c) {
				return;
			}
			st.connected = false;
			if (st.stopping) {
				return;
			}
			st.lastError = err ? err.message : "closed";
			io.status("error", "disconnected: " + st.lastError);
			io.log("disconnected from " + target + ": " + st.lastError, "warn");
			scheduleReconnect();
		});
		return c.ready.then((info) => {
			st.connected = true;
			st.backoff = BACKOFF_MIN_MS;
			st.lastError = "";
			io.status("running", info.name + " " + info.width + "x" + info.height);
			io.log("connected to " + target + " (RFB " + info.version + ", security " + info.security + ", " + info.width + "x" + info.height + " \"" + info.name + "\")");
		}, (err) => {
			if (st.client === c) {
				st.client = null;
			}
			st.lastError = err.message;
			if (st.stopping) {
				return;
			}
			io.status("error", err.message);
			io.log("connect to " + target + " failed: " + err.message, "error");
			scheduleReconnect();
		});
	};

	const connected = () => {
		if (!st.client || !st.connected) {
			throw new Error("not connected to " + target + (st.lastError ? ": " + st.lastError : ""));
		}
		return st.client;
	};

	const input = () => {
		if (settings.viewOnly) {
			throw new Error("device is view-only (option viewOnly)");
		}
		return connected();
	};

	const point = (a, prefix) => {
		const c = st.client;
		return {
			x: Math.round(parseNumber(a.x, (prefix || "") + "x", { min: 0, max: c.width - 1 })),
			y: Math.round(parseNumber(a.y, (prefix || "") + "y", { min: 0, max: c.height - 1 }))
		};
	};

	const buttonMask = (button) => {
		const b = button === undefined ? "left" : String(button).toLowerCase();
		if (!BUTTONS[b]) {
			throw new Error("button must be left, middle or right");
		}
		return BUTTONS[b];
	};

	const pointer = (x, y, mask) => {
		st.x = x;
		st.y = y;
		st.buttons = mask;
		st.client.pointer(x, y, mask);
	};

	const keyEvents = (events, delayMs) => {
		const c = st.client;
		return sequence(events.map((e) => () => c.key(e.keysym, e.down)), delayMs === undefined ? KEY_DELAY_MS : delayMs);
	};

	const commands = {
		screenshot: (a) => {
			connected();
			const shot = encodeScreen(a.region);
			io.image("screen", shot.png, "image/png");
			return { image: io.id + "_screen", region: shot.region, bytes: shot.png.length, _image: { data: shot.png.toString("base64"), mime: "image/png" } };
		},

		type: (a) => {
			input();
			const text = String(a.text === undefined ? "" : a.text);
			if (!text || text.length > MAX_TEXT) {
				throw new Error("text must be 1.." + MAX_TEXT + " characters");
			}
			return keyEvents(keysym.typeEvents(text), a.delayMs).then(() => ({ typed: text.length }));
		},

		key: (a) => {
			input();
			const events = keysym.comboEvents(a.keys);
			return keyEvents(events, a.delayMs).then(() => ({ keys: a.keys, events: events.length }));
		},

		move: (a) => {
			input();
			const p = point(a);
			pointer(p.x, p.y, st.buttons);
			return { x: p.x, y: p.y };
		},

		click: (a) => {
			input();
			const p = point(a);
			const mask = buttonMask(a.button);
			const once = [() => pointer(p.x, p.y, 0), () => pointer(p.x, p.y, mask), () => pointer(p.x, p.y, 0)];
			const doubled = parseSwitch(a.double === undefined ? false : a.double, "double");
			return sequence(doubled ? once.concat(once.slice(1)) : once, CLICK_DELAY_MS).then(() => ({ x: p.x, y: p.y, double: doubled }));
		},

		drag: (a) => {
			input();
			const from = point(a.from || { x: a.x1, y: a.y1 }, "from.");
			const to = point(a.to || { x: a.x2, y: a.y2 }, "to.");
			const mask = buttonMask(a.button);
			const steps = Math.round(parseNumber(a.steps === undefined ? 10 : a.steps, "steps", { min: 1, max: 200 }));
			const path = Array.from({ length: steps }, (_, i) => (i + 1) / steps).map((f) => () => pointer(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f, mask));
			return sequence([() => pointer(from.x, from.y, 0), () => pointer(from.x, from.y, mask)].concat(path, [() => pointer(to.x, to.y, 0)]), CLICK_DELAY_MS)
				.then(() => ({ from: from, to: to }));
		},

		scroll: (a) => {
			input();
			const p = point(a);
			const dy = Math.round(parseNumber(a.dy === undefined ? 1 : a.dy, "dy", { min: -50, max: 50 }));
			const wheel = dy < 0 ? WHEEL_UP : WHEEL_DOWN;
			const ticks = Array.from({ length: Math.abs(dy) }, () => [() => pointer(p.x, p.y, wheel), () => pointer(p.x, p.y, 0)]).reduce((all, t) => all.concat(t), []);
			return sequence(ticks, CLICK_DELAY_MS).then(() => ({ x: p.x, y: p.y, dy: dy }));
		},

		clipboard: (a) => {
			if (a.text === undefined) {
				return { text: st.clipboard };
			}
			input().cutText(String(a.text));
			return { sent: String(a.text).length };
		},

		wait_change: (a) => {
			const c = connected();
			const region = regionOf(a.region);
			const timeoutMs = parseNumber(a.timeoutMs === undefined ? WAIT_DEFAULT_MS : a.timeoutMs, "timeoutMs", { min: 0, max: WAIT_MAX_MS });
			const settleMs = parseNumber(a.settleMs === undefined ? 0 : a.settleMs, "settleMs", { min: 0, max: WAIT_MAX_MS });
			const baseline = cropRgb(c.framebuffer, c.width, region);
			const started = Date.now();
			return new Promise((resolve) => {
				const waiter = { changedAt: 0, settle: null, timer: null };
				const finish = (changed, settled) => {
					clearTimeout(waiter.timer);
					clearTimeout(waiter.settle);
					waiters.delete(waiter);
					// settled: false when the region changed but never went still (a blinking cursor)
					const result = { changed: changed, settled: Boolean(settled), ms: Date.now() - started, region: region };
					if (changed && a.screenshot && st.connected) {
						// the whole screen: the region may not exist any more after a resize
						const shot = encodeScreen();
						io.image("screen", shot.png, "image/png");
						result._image = { data: shot.png.toString("base64"), mime: "image/png" };
					}
					resolve(result);
				};
				waiter.finish = finish;
				waiter.check = (rects) => {
					if (!rects.some((r) => intersects(r, region)) || st.client !== c) {
						return;
					}
					if (!waiter.changedAt && cropRgb(c.framebuffer, c.width, region).equals(baseline)) {
						return;
					}
					waiter.changedAt = waiter.changedAt || Date.now();
					if (!settleMs) {
						finish(true, true);
						return;
					}
					// done once the region stops changing for settleMs
					clearTimeout(waiter.settle);
					waiter.settle = setTimeout(() => finish(true, true), settleMs);
				};
				waiter.timer = setTimeout(() => finish(Boolean(waiter.changedAt), false), timeoutMs);
				waiters.add(waiter);
			});
		},

		refresh: () => {
			connected().requestUpdate(false);
			return { ok: true };
		},

		status: () => {
			const c = st.client;
			return {
				connected: st.connected,
				host: settings.host,
				port: settings.port,
				width: c ? c.width : 0,
				height: c ? c.height : 0,
				name: c && c.info ? c.info.name : "",
				version: c && c.info ? c.info.version : "",
				security: c && c.info ? c.info.security : "",
				updates: c ? c.stats().updates : 0,
				viewOnly: settings.viewOnly,
				fps: settings.fps,
				reconnects: st.reconnects,
				lastError: st.lastError,
				pointer: { x: st.x, y: st.y, buttons: st.buttons }
			};
		}
	};

	return {
		start: () => {
			if (settings.fps > 0) {
				st.fpsTimer = setInterval(() => {
					if (st.dirty && st.connected) {
						pushScreen();
					}
				}, 1000 / settings.fps);
			}
			return connect();
		},

		stop: () => {
			st.stopping = true;
			clearTimeout(st.retry);
			clearInterval(st.fpsTimer);
			waiters.forEach((w) => {
				clearTimeout(w.timer);
				clearTimeout(w.settle);
			});
			waiters.clear();
			if (st.client) {
				st.client.close();
			}
			return Promise.resolve();
		},

		command: (name, args) => {
			if (!Object.prototype.hasOwnProperty.call(commands, name)) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		}
	};
};

module.exports = {
	name: "vnc",
	description: "VNC (RFB 3.3/3.7/3.8) desktop: legacy GUIs in emulators/VMs. Screenshots as image <id>_screen, keyboard/mouse input, wait for screen changes; the vnc pane shows it live (noVNC)",
	options: {
		host: "VNC server host (default 127.0.0.1)",
		port: "TCP port (default 5900; display :N is 5900+N)",
		password: "VNC password (security type 2; first 8 characters count). Masked in listings, never logged",
		fps: "push image <id>_screen this many times a second while the screen changes (default 0 = only on screenshot)",
		viewOnly: "true: refuse input commands, and the pane connects view-only"
	},
	commands: {
		screenshot: "{region: {x, y, w, h}} PNG of the screen (or a region) as image <id>_screen, returned to the AI",
		type: "{text, delayMs: 20} type text (\\n = Enter, \\t = Tab; Shift sent for capitals/symbols, US layout)",
		key: "{keys: \"ctrl+alt+del\" | \"alt+f4\" | \"F10\" | \"alt+f x\" | [\"ctrl+c\", \"enter\"], delayMs} key combos, in order",
		click: "{x, y, button: left|middle|right, double: false}",
		move: "{x, y} move the pointer",
		drag: "{from: {x, y}, to: {x, y}, button: left, steps: 10}",
		scroll: "{x, y, dy} wheel clicks (negative = up)",
		clipboard: "{text} send text to the remote clipboard; without text: the last text the server put on its clipboard",
		wait_change: "{timeoutMs: 10000, region: {x, y, w, h}, settleMs: 0, screenshot: false} resolve when pixels in the region change (and then stay still for settleMs: settled); {changed: false} on timeout",
		refresh: "request a full screen update",
		status: "connection, desktop size and name, RFB version, security, update count"
	},
	create: create,
	_cropRgb: cropRgb
};
