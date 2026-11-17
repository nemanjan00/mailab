// Live remote screen of a RIGOL Web Control instrument (DM858, MHO98,
// MHO900): the device's own http-live-player stack (WSAvcPlayer, served by
// the instrument) decodes the H.264 screen stream from ws://host:9001;
// clicks/drags on the canvas become touch events through the rigol driver's
// input injection (ws://host:9002). View-only drops input.

const loadScript = (src) => {
	return new Promise((resolve, reject) => {
		const s = document.createElement("script");
		s.src = src;
		s.onload = resolve;
		s.onerror = () => reject(new Error("failed to load " + src));
		document.head.appendChild(s);
	});
};

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		body.classList.add("rigol-pane", "fill");

		const status = { text: "connecting", detail: "", viewOnly: Boolean(pane.config.viewOnly) };
		const device = () => ctx.state.devices.find((d) => d.id === pane.config.device);
		const hostOf = () => {
			const d = device();
			return String(pane.config.host || (d && d.options && d.options.host) || "").trim();
		};
		const videoPort = () => {
			const d = device();
			return (d && Number(d.options.videoPort)) || 9001;
		};

		// ---- toolbar (plain DOM) -------------------------------------------------
		const wrap = document.createElement("div");
		wrap.className = "rigol-wrap";
		const bar = document.createElement("div");
		bar.className = "toolbar pad";
		const statusEl = document.createElement("span");
		statusEl.className = "muted";
		const modeBtn = document.createElement("button");
		modeBtn.className = "icon";
		const ext = document.createElement("a");
		ext.className = "hint";
		ext.target = "_blank";
		ext.rel = "noopener";
		ext.textContent = "instrument UI ↗";
		bar.append(statusEl, modeBtn, ext);
		wrap.appendChild(bar);

		const paint = () => {
			statusEl.textContent = status.text + (status.detail ? " — " + status.detail : "");
			modeBtn.textContent = status.viewOnly ? "👁" : "🖱";
			modeBtn.title = status.viewOnly ? "view only (input dropped)" : "input on";
			const h = hostOf();
			ext.style.display = h ? "" : "none";
			if (h) {
				ext.href = "http://" + h + "/control.html";
			}
		};
		modeBtn.addEventListener("click", () => {
			status.viewOnly = !status.viewOnly;
			paint();
		});
		paint();

		// ---- screen stage ---------------------------------------------------------
		const stage = document.createElement("div");
		stage.className = "rigol-stage";
		wrap.appendChild(stage);
		body.replaceChildren(wrap);

		const touch = (command, args) => {
			const id = pane.config.device;
			if (!id || status.viewOnly) {
				return Promise.resolve();
			}
			return ctx.api("POST", "/devices/" + id + "/command", { command: command, args: args }).catch(() => null);
		};

		let player = null;
		let canvas = null;
		let disposed = false;
		let retry = null;
		// native instrument screen size (from the player's init); the
		// displayed canvas is CSS-scaled, input maps to the native space
		let native = { w: 1024, h: 600 };

		// sizing is pure CSS (flex stage + contain); no JS measurements, no
		// resize feedback loop

		const wireInput = () => {
			let down = false;
			const toNative = (event) => {
				const r = canvas.getBoundingClientRect();
				return [
					Math.round((event.clientX - r.left) * native.w / Math.max(1, r.width)),
					Math.round((event.clientY - r.top) * native.h / Math.max(1, r.height))
				];
			};
			canvas.addEventListener("mousedown", (e) => {
				down = true;
				const xy = toNative(e);
				touch("touch", { state: "down", x: xy[0], y: xy[1] });
			});
			canvas.addEventListener("mousemove", (e) => {
				if (down) {
					const xy = toNative(e);
					touch("touch", { state: "move", x: xy[0], y: xy[1] });
				}
			});
			canvas.addEventListener("mouseup", (e) => {
				if (down) {
					const xy = toNative(e);
					touch("touch", { state: "up", x: xy[0], y: xy[1] });
					down = false;
				}
			});
		};

		const start = () => {
			const h = hostOf();
			if (!h) {
				status.text = "error";
				status.detail = "set config.device (a rigol device) or config.host";
				paint();
				return;
			}
			status.text = "connecting";
			status.detail = h;
			paint();
			loadScript("http://" + h + "/res/http-live-player.js").then(() => {
				if (disposed) {
					return;
				}
				if (typeof window.WSAvcPlayer !== "function") {
					throw new Error("the instrument's player did not expose WSAvcPlayer");
				}
				canvas = document.createElement("canvas");
				stage.replaceChildren(canvas);
				wireInput();
				player = new window.WSAvcPlayer(canvas, "webgl", 1, 35);
				if (player.setSizeChangedCallback) {
					player.setSizeChangedCallback((w, hh) => {
						native = { w: w, h: hh };
						status.detail = h + " — " + w + "x" + hh;
						paint();
					});
				}
				const closed = () => {
					if (!disposed) {
						status.text = "reconnecting";
						paint();
						retry = setTimeout(start, 2000);
					}
				};
				if (player.setSocketClosedCallback) {
					player.setSocketClosedCallback(closed);
				} else if (player.setOnCloseCallBack) {
					player.setOnCloseCallBack(closed);
				}
				player.connect("ws://" + h + ":" + videoPort());
				status.text = "live";
				paint();
			}, (err) => {
				status.text = "error";
				status.detail = err.message;
				paint();
			});
		};
		start();


		return {
			update: (next) => {
				const rehome = next.config.device !== pane.config.device || next.config.host !== pane.config.host;
				pane = next;
				paint();
				if (rehome) {
					if (player && player.disconnect) {
						try {
							player.disconnect();
						} catch (_err) {
							// already gone
						}
					}
					start();
				}
			},
			destroy: () => {
				disposed = true;
				clearTimeout(retry);
				if (player && player.disconnect) {
					try {
						player.disconnect();
					} catch (_err) {
						// already gone
					}
				}
			}
		};
	}
};
