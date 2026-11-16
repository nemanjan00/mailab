// Live remote desktop for a `vnc` device (noVNC through /ws/vnc/<device>).
// The server does the VNC auth with the device's password and only relays to
// that device's host:port; read-only users (and view-only devices) get their
// input dropped server-side. Toolbar: connection state, scale to fit, view
// only, Ctrl-Alt-Del, clipboard text send, screenshot into the lab (image
// <device>_screen, the same one the AI gets), reconnect.

import RFB from "@novnc/novnc";
import { el, onDispose, state, when } from "@nemanjan00/qrp";
import { empty, iconButton, pane, toolbar, widget } from "../sdk/index.js";

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;
const BACKGROUND = "#282a36";

const wsUrl = (device) => (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws/vnc/" + encodeURIComponent(device);

const vnc = (ctx, p, device) => {
	const view = state({
		status: "connecting",
		detail: "",
		scale: true,
		viewOnly: Boolean(p.pane.config.viewOnly),
		clip: "",
		remoteClip: "",
		note: "",
		error: ""
	});
	let rfb = null;
	let host = null;
	let retry = null;
	let retryMs = RETRY_MIN_MS;
	let disposed = false;

	const deviceViewOnly = () => {
		const d = ctx.state.devices.find((x) => x.id === device);
		return Boolean(d && d.options && (d.options.viewOnly === true || d.options.viewOnly === "true"));
	};

	const flash = (text) => {
		view.note = text;
		setTimeout(() => {
			if (view.note === text) {
				view.note = "";
			}
		}, 2000);
	};

	const connect = () => {
		retry = null;
		if (disposed || !host) {
			return;
		}
		view.status = "connecting";
		view.detail = "";
		rfb = new RFB(host, wsUrl(device), { shared: true });
		rfb.background = BACKGROUND;
		rfb.scaleViewport = view.scale;
		rfb.viewOnly = view.viewOnly || deviceViewOnly();
		rfb.addEventListener("connect", () => {
			retryMs = RETRY_MIN_MS;
			view.error = "";
			view.status = "connected";
		});
		rfb.addEventListener("desktopname", (e) => {
			view.detail = e.detail.name;
		});
		rfb.addEventListener("clipboard", (e) => {
			view.remoteClip = e.detail.text;
		});
		rfb.addEventListener("securityfailure", (e) => {
			view.error = e.detail.reason || "security failure";
		});
		rfb.addEventListener("disconnect", () => {
			rfb = null;
			view.status = "disconnected";
			if (disposed) {
				return;
			}
			retry = setTimeout(connect, retryMs);
			retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
		});
	};

	const reconnect = () => {
		clearTimeout(retry);
		retryMs = RETRY_MIN_MS;
		if (rfb) {
			// the disconnect event schedules the new connection
			rfb.disconnect();
		} else {
			connect();
		}
	};

	const setScale = (on) => {
		view.scale = on;
		if (rfb) {
			rfb.scaleViewport = on;
		}
	};

	const setViewOnly = (on) => {
		view.viewOnly = on;
		if (rfb) {
			rfb.viewOnly = on || deviceViewOnly();
		}
	};

	const sendClip = () => {
		if (!rfb || !view.clip) {
			return;
		}
		rfb.clipboardPasteFrom(view.clip);
		flash("clipboard sent");
	};

	const screenshot = () => ctx.api("POST", "/devices/" + device + "/command", { command: "screenshot", args: {} })
		.then(() => flash("saved as " + device + "_screen"), (err) => flash("⚠ " + err.message));

	onDispose(() => {
		disposed = true;
		clearTimeout(retry);
		if (rfb) {
			rfb.disconnect();
		}
	});

	const screen = widget((h) => {
		host = h;
		connect();
		return {
			resize: () => null,
			destroy: () => {
				host = null;
			}
		};
	});

	const toggle = (label, title, get, set) => el("label", { class: "vnc-toggle", title: title },
		el("input", { type: "checkbox", checked: get, onchange: (e) => set(e.target.checked) }), label);

	return el("div", { class: "vnc" },
		toolbar(
			el("span", { class: () => "state " + (view.status === "connected" ? "running" : view.status === "connecting" ? "starting" : "error"), title: () => view.detail },
				() => (view.status === "connected" && view.detail ? view.detail : view.status)),
			toggle("scale", "scale the remote screen to fit the pane", () => view.scale, setScale),
			toggle("view only", "don't send keyboard / mouse input", () => view.viewOnly, setViewOnly),
			el("button", { title: "send Ctrl-Alt-Del", disabled: () => view.status !== "connected" || view.viewOnly, onclick: () => rfb && rfb.sendCtrlAltDel() }, "Ctrl-Alt-Del"),
			el("input", { class: "vnc-clip", placeholder: "text → remote clipboard", title: () => (view.remoteClip ? "remote clipboard: " + view.remoteClip : ""), bind: [view, "clip"],
				onkeydown: (e) => {
					if (e.key === "Enter") {
						sendClip();
					}
				} }),
			el("button", { title: "send the text to the remote clipboard", disabled: () => view.status !== "connected" || view.viewOnly || !view.clip, onclick: sendClip }, "send"),
			iconButton("📷", "screenshot into the lab (image " + device + "_screen)", screenshot),
			iconButton("⟳", "reconnect", reconnect),
			el("span", { class: "muted mono" }, () => view.note)),
		when(() => view.status !== "connected" && view.error, () => el("div", { class: "error pad" }, () => view.error)),
		screen);
};

export default pane((ctx, p) => when(
	() => p.pane.config.device,
	(device) => vnc(ctx, p, device),
	() => empty("set config.device to a vnc device id")
));
