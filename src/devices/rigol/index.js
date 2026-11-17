// RIGOL Web Control devices (DM858, MHO98/MHO900, ...): live screen video
// over ws://<host>:9001 (Annex-B H.264, the instrument's own player) and
// front-panel input injection over ws://<host>:9002
// ({"type":"CONTROL_KEY_DOWN|MOVE|UP","downDelta":ms,"clientX":x,"clientY":y},
// {"type":"CONTROL_BACK|CONTROL_HOME"} — protocol read from the device's
// control.html). The browser pane plays the video with the instrument's
// own http-live-player stack; this driver is the AI's input path and
// exposes the host for the pane. Verified live on a DM858 + MHO98.

const WS = require("ws");

// input dialects, learned live: the DM858 speaks CONTROL_KEY_* with a
// millisecond downDelta, the MHO98 (patched FW) speaks DOM-style
// onmouse* with downDelta null
const DIALECTS = {
	rigol: {
		events: { down: "CONTROL_KEY_DOWN", move: "CONTROL_KEY_MOVE", up: "CONTROL_KEY_UP" },
		keys: { back: "CONTROL_BACK", home: "CONTROL_HOME" },
		downDelta: () => 0
	},
	dom: {
		events: { down: "onmousedown", move: "onmousemove", up: "onmouseup" },
		keys: { back: "CONTROL_BACK", home: "CONTROL_HOME" },
		downDelta: () => null
	}
};

const create = (options, io) => {
	if (!options.host) {
		throw new Error("rigol needs a `host` (the instrument's IP)");
	}
	const settings = {
		host: options.host,
		videoPort: Number(options.videoPort) || 9001,
		controlPort: Number(options.controlPort) || 9002,
		dialect: DIALECTS[options.dialect] ? options.dialect : "dom"
	};
	const dialect = DIALECTS[settings.dialect];
	let ws = null;
	let opening = null;
	let idleTimer = null;
	const stats = { sent: 0 };
	// the meter locks its front panel ("remote mode") while a web-control
	// session is attached; release the seat a few seconds after the last
	// injected event so the local panel unlocks
	const idleCloseMs = Math.max(500, Number(options.idleCloseMs) || 3000);

	const controlUrl = () => "ws://" + settings.host + ":" + settings.controlPort;

	const open = () => {
		if (ws && ws.readyState === WS.OPEN) {
			return Promise.resolve(ws);
		}
		if (opening) {
			return opening;
		}
		opening = new Promise((resolve, reject) => {
			const sock = new WS(controlUrl(), { perMessageDeflate: false });
			const timer = setTimeout(() => {
				opening = null;
				reject(new Error("rigol control connect timeout: " + controlUrl()));
			}, 5000);
			sock.on("open", () => {
				clearTimeout(timer);
				ws = sock;
				opening = null;
				io.log("control ws open: " + controlUrl(), "info");
				resolve(sock);
			});
			sock.on("error", (err) => {
				clearTimeout(timer);
				if (opening) {
					opening = null;
					reject(err);
				}
			});
			sock.on("close", () => {
				ws = null;
			});
		});
		return opening;
	};

	const armIdleClose = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			if (ws) {
				io.log("control idle — releasing the session (front panel unlocks)", "info");
				try {
					ws.close();
				} catch (_err) {
					// already closed
				}
				ws = null;
			}
		}, idleCloseMs);
	};

	const send = (obj) => {
		const line = JSON.stringify(obj);
		return open().then((sock) => {
			armIdleClose();
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error("rigol control send timeout: " + line));
				}, 5000);
				sock.send(line, (err) => {
					clearTimeout(timer);
					if (err) {
						reject(err);
						return;
					}
					stats.sent++;
					io.log("> " + line, "tx");
					resolve({ ok: true });
				});
			});
		});
	};

	// coordinates are the instrument's native screen space (DM858: 1024x600)
	const clampXY = (x, y) => {
		const px = Math.round(Number(x));
		const py = Math.round(Number(y));
		if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px > 10000 || py > 10000) {
			throw new Error("x/y must be positive screen coordinates");
		}
		return [px, py];
	};

	const commands = {
		touch: (args) => {
			const type = dialect.events[String(args.state || "down").toLowerCase()];
			if (!type) {
				throw new Error("state must be one of " + Object.keys(dialect.events).join("|"));
			}
			const xy = clampXY(args.x, args.y);
			return send({ type: type, downDelta: dialect.downDelta(), clientX: xy[0], clientY: xy[1] });
		},

		// a quick tap = down + up at the same spot
		tap: (args) => {
			const xy = clampXY(args.x, args.y);
			return send({ type: dialect.events.down, downDelta: dialect.downDelta(), clientX: xy[0], clientY: xy[1] }).then(() => {
				return send({ type: dialect.events.up, downDelta: 120, clientX: xy[0], clientY: xy[1] });
			});
		},

		key: (args) => {
			const type = dialect.keys[String(args.name || "").toLowerCase()];
			if (!type) {
				throw new Error("name must be one of " + Object.keys(dialect.keys).join("|"));
			}
			return send({ type: type });
		},

		swipe: (args) => {
			const from = clampXY(args.from_x, args.from_y);
			const to = clampXY(args.to_x, args.to_y);
			const steps = Math.max(1, Math.min(50, Math.round(Number(args.steps) || 8)));
			return send({ type: dialect.events.down, downDelta: dialect.downDelta(), clientX: from[0], clientY: from[1] }).then(() => {
				let chain = Promise.resolve();
				for (let i = 1; i <= steps; i++) {
					const x = Math.round(from[0] + (to[0] - from[0]) * i / steps);
					const y = Math.round(from[1] + (to[1] - from[1]) * i / steps);
					chain = chain.then(() => send({ type: dialect.events.move, downDelta: 16, clientX: x, clientY: y }));
				}
				return chain.then(() => send({ type: dialect.events.up, downDelta: 60, clientX: to[0], clientY: to[1] }));
			});
		},

		status: () => {
			return {
				host: settings.host,
				videoUrl: "ws://" + settings.host + ":" + settings.videoPort,
				controlUrl: controlUrl(),
				webUrl: "http://" + settings.host + "/control.html",
				controlOpen: Boolean(ws && ws.readyState === WS.OPEN),
				sent: stats.sent
			};
		}
	};

	return {
		start: () => Promise.resolve(),
		stop: () => {
			clearTimeout(idleTimer);
			if (ws) {
				try {
					ws.close();
				} catch (_err) {
					// already closed
				}
				ws = null;
			}
			return Promise.resolve();
		},
		command: (name, args) => {
			if (!commands[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		}
	};
};

module.exports = {
	name: "rigol",
	description: "RIGOL Web Control (DM858/MHO98/...): live screen video on ws:9001 + front-panel input injection on ws:9002. The rigol pane plays the screen and turns clicks into touch events; the AI has tap/touch/swipe/key commands",
	options: {
		host: "instrument IP (required)",
		videoPort: "screen-video WebSocket port (default 9001)",
		controlPort: "input-injection WebSocket port (default 9002)",
		idleCloseMs: "release the web-control session this long after the last injected event (default 3000; the meter locks its front panel while a session is attached)",
		dialect: "dom (onmouse*, default — both the DM858 and MHO98 live FW) | rigol (CONTROL_KEY_*, from a stale cached page)"
	},
	commands: {
		tap: "{x, y} tap the screen (native screen coordinates, DM858: 1024x600)",
		touch: "{state: down|move|up, x, y} raw touch event",
		swipe: "{from_x, from_y, to_x, to_y, steps?} drag across the screen",
		key: "{name: back|home} panel key",
		status: "{} video/control URLs, link state, event count"
	},
	create: create
};
