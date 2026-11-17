// mailab web UI: keeps a live copy of lab state, mounts panes on a grid and
// syncs layout edits back. Panes are modules in ./panes, one per pane type.
// Bundled with esbuild (yarn build) into public/build/.

import { GridStack } from "gridstack";
import { batch, el, mount, state, when } from "@nemanjan00/qrp";
import profilesDialog from "./profiles.js";
import "gridstack/dist/gridstack.min.css";
import "uplot/dist/uPlot.min.css";
import "katex/dist/katex.min.css";
import "./style.css";

import chart from "./panes/chart.js";
import value from "./panes/value.js";
import trace from "./panes/trace.js";
import waterfall from "./panes/waterfall.js";
import image from "./panes/image.js";
import markdown from "./panes/markdown.js";
import mathPane from "./panes/math.js";
import log from "./panes/log.js";
import activity from "./panes/activity.js";
import devices from "./panes/devices.js";
import settings from "./panes/settings.js";
import channels from "./panes/channels.js";
import audio from "./panes/audio.js";
import json from "./panes/json.js";
import flowgraph from "./panes/flowgraph.js";
import kaitai from "./panes/kaitai.js";
import chat from "./panes/chat.js";
import graph from "./panes/graph.js";
import blob from "./panes/blob.js";
import hex from "./panes/hex.js";
import classifier from "./panes/classifier.js";
import trend from "./panes/trend.js";
import custom from "./panes/custom.js";
import usb from "./panes/usb.js";
import terminal from "./panes/terminal.js";
import capture from "./panes/capture.js";
import board from "./panes/board.js";
import datasheets from "./panes/datasheets.js";
import vnc from "./panes/vnc.js";
import kvm from "./panes/kvm.js";
import vision from "./panes/vision.js";

const PANES = { chart, value, trace, waterfall, image, markdown, math: mathPane, log, activity, devices, settings, channels, audio, json, flowgraph, kaitai, chat, graph, blob, classifier, trend, custom, usb, terminal, capture, board, datasheets, vnc, kvm, hex, vision };
const HISTORY_SECONDS = 600;
const MAX_POINTS = 120000;
const PALETTE_SIZE = 8;
const THEMES = ["dracula", "lab", "light"];

// ---- events -------------------------------------------------------------

const listeners = {};
const on = (event, fn) => {
	(listeners[event] = listeners[event] || []).push(fn);
	return () => {
		listeners[event] = listeners[event].filter((f) => f !== fn);
	};
};
const emit = (event, payload) => {
	(listeners[event] || []).forEach((fn) => {
		try {
			fn(payload);
		} catch (err) {
			console.error(err);
		}
	});
};

// ---- api ----------------------------------------------------------------

// collaboration mode: the server wants a token; keep it in a cookie for api + ws.
// Modal, not prompt(): when the lab has NO tokens configured a token can't
// help (the host/origin is untrusted) — say that instead of asking.
let asked = false;
const authVeil = (content) => {
	const veil = document.createElement("div");
	veil.className = "auth-veil";
	const card = document.createElement("div");
	card.className = "auth-card";
	card.appendChild(content);
	veil.appendChild(card);
	document.body.appendChild(veil);
	return veil;
};
const showTokenModal = () => {
	const box = document.createElement("div");
	const title = document.createElement("h3");
	title.textContent = "This lab needs an access token";
	const input = document.createElement("input");
	input.type = "password";
	input.placeholder = "paste the token";
	input.autocomplete = "off";
	const go = document.createElement("button");
	go.textContent = "sign in";
	const form = document.createElement("form");
	form.append(input, go);
	const err = document.createElement("div");
	err.className = "muted";
	box.append(title, form, err);
	const veil = authVeil(box);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const token = input.value.trim();
		if (!token) {
			return;
		}
		// the server swaps it for an HttpOnly cookie and redirects to the clean URL
		location.href = "/?token=" + encodeURIComponent(token);
	});
	return veil;
};
const showRefusedModal = (host) => {
	const box = document.createElement("div");
	const title = document.createElement("h3");
	title.textContent = "This host isn't trusted";
	const msg = document.createElement("p");
	msg.textContent = "The lab runs without tokens but refuses this host/origin. Open it via its configured address"
		+ (host ? " (you came in as " + host + ")" : "")
		+ ", or set MAILAB_TOKENS on the server.";
	box.append(title, msg);
	authVeil(box);
};
const askToken = () => {
	if (asked) {
		return;
	}
	asked = true;
	fetch("/api/auth/status").then((res) => res.json()).then((st) => {
		if (st.enabled) {
			showTokenModal();
		} else {
			showRefusedModal(st.host);
		}
	}, () => {
		// status probe failed (older server?): fall back to asking
		showTokenModal();
	});
};

const api = (method, path, body) => {
	return fetch("/api" + path, {
		method: method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body)
	}).then((res) => {
		if (res.status === 401) {
			askToken();
		}
		return res.json().then((json) => {
			if (!res.ok) {
				throw new Error(json.error || res.statusText);
			}
			return json;
		});
	});
};

// ---- client-side channel buffers (t in seconds for uPlot) ---------------

const buffers = {};
const backfilled = {};

const trim = (buf) => {
	const cutoff = Date.now() / 1000 - HISTORY_SECONDS;
	let drop = 0;
	while (drop < buf.t.length && buf.t[drop] < cutoff) {
		drop++;
	}
	drop = Math.max(drop, buf.t.length - MAX_POINTS);
	if (drop > 0) {
		buf.t.splice(0, drop);
		buf.v.splice(0, drop);
	}
};

const data = {
	series: (name) => {
		return buffers[name] || (buffers[name] = { t: [], v: [] });
	},

	// fetch server history once per channel, merged before live samples
	backfill: (name) => {
		if (backfilled[name]) {
			return backfilled[name];
		}
		backfilled[name] = api("GET", "/channels/" + name + "?seconds=" + HISTORY_SECONDS).then((hist) => {
			const buf = data.series(name);
			const firstLive = buf.t.length ? buf.t[0] : Infinity;
			const keep = hist.t.map((t) => t / 1000).filter((t) => t < firstLive);
			buf.t = keep.concat(buf.t);
			buf.v = hist.v.slice(0, keep.length).concat(buf.v);
			trim(buf);
			emit("samples", {});
		}).catch(() => {
			delete backfilled[name];
		});
		return backfilled[name];
	}
};

// ---- traces & state -------------------------------------------------------

const traces = {};
// latest value per channel, refreshed a few times a second (readouts, tables)
const LIVE_REFRESH_MS = 250;
const FEED_SIZE = 500;

const ctx = {
	// reactive (qrp) store: lab state from the server, feeds, live values.
	// qrp panes bind to it; imperative panes read it like a plain object.
	state: state({ devices: [], channels: [], traces: [], images: [], values: [], blobs: [], panes: [], tabs: ["main"], paneTypes: {} }),
	store: state({ activity: [], chat: [], live: {}, approvals: {} }),
	data: data,
	traces: traces,
	api: api,
	on: on,
	// series colours come from the theme (--c0 .. --c7)
	color: (i) => getComputedStyle(document.documentElement).getPropertyValue("--c" + (i % PALETTE_SIZE)).trim(),
	fetchTrace: (name) => {
		return api("GET", "/traces/" + name).then((tr) => {
			traces[name] = tr;
			emit("trace", tr);
			return tr;
		});
	},
	dialog: null,
	editPane: null,
	// send a message to the server over the live socket (capture pane: mic / camera);
	// false while disconnected. "ws_open" fires on every (re)connect.
	send: (msg) => {
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			return false;
		}
		socket.send(JSON.stringify(msg));
		return true;
	},
	// bytes queued on the socket, for senders that back off when the link is slow
	sendBacklog: () => (socket ? socket.bufferedAmount : 0)
};

const pushFeed = (feed, entry) => {
	feed.push(entry);
	if (feed.length > FEED_SIZE) {
		feed.splice(0, feed.length - FEED_SIZE);
	}
};

// feeds start from the server's history; live entries arrive over ws
api("GET", "/activity").then((entries) => {
	ctx.store.activity = entries.slice(-FEED_SIZE);
}, () => null);
api("GET", "/chat").then((messages) => {
	ctx.store.chat = messages;
}, () => null);
api("GET", "/safety").then((safety) => {
	safety.pending.forEach((entry) => {
		ctx.store.approvals[entry.id] = entry;
	});
}, () => null);

setInterval(() => {
	batch(() => {
		Object.keys(buffers).forEach((name) => {
			const buf = buffers[name];
			if (buf.v.length && ctx.store.live[name] !== buf.v[buf.v.length - 1]) {
				ctx.store.live[name] = buf.v[buf.v.length - 1];
			}
		});
	});
}, LIVE_REFRESH_MS);

// ---- websocket ------------------------------------------------------------

let socket = null;

const connect = () => {
	const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
	const dot = document.getElementById("conn");
	socket = ws;
	ws.onopen = () => {
		dot.classList.add("on");
		emit("ws_open", {});
	};
	ws.onclose = () => {
		dot.classList.remove("on");
		emit("ws_close", {});
		setTimeout(connect, 1000);
	};
	ws.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.type === "state") {
			batch(() => {
				Object.keys(msg.state).forEach((key) => {
					ctx.state[key] = msg.state[key];
				});
			});
			syncBypassBanner(msg.state.bypass);
			syncTxBanner(msg.state.tx);
			renderTabs();
			syncPanes(msg.state.panes);
			emit("state", msg.state);
		} else if (msg.type === "samples") {
			Object.keys(msg.samples).forEach((name) => {
				const buf = data.series(name);
				const s = msg.samples[name];
				s.t.forEach((t, i) => {
					buf.t.push(t / 1000);
					buf.v.push(s.v[i]);
				});
				trim(buf);
			});
			emit("samples", msg.samples);
		} else if (msg.type === "activity") {
			pushFeed(ctx.store.activity, msg.entry);
			emit("activity", msg);
		} else if (msg.type === "approval") {
			ctx.store.approvals[msg.approval.id] = msg.approval;
		} else if (msg.type === "chat") {
			pushFeed(ctx.store.chat, msg.message);
			emit("chat", msg);
		} else if (msg.type === "trace") {
			traces[msg.trace.name] = msg.trace;
			emit("trace", msg.trace);
		} else {
			emit(msg.type, msg);
		}
	};
};

// ---- dialog -----------------------------------------------------------------

/**
 * Show a form dialog; resolves with field values, or null on cancel.
 * fields: [{name, label, type: text|textarea|select, value, options, hint, link: {text, href(value)}}]
 * validate(values) may return a promise; a rejection keeps the dialog open.
 */
ctx.dialog = (title, fields, validate) => {
	const dialog = document.getElementById("dialog");
	const body = document.getElementById("dialog-body");
	const error = document.getElementById("dialog-error");
	document.getElementById("dialog-title").textContent = title;
	error.textContent = "";
	body.innerHTML = "";
	const inputs = {};
	fields.forEach((field) => {
		const label = document.createElement("label");
		label.textContent = field.label || field.name;
		body.appendChild(label);
		let input;
		if (field.type === "select") {
			input = document.createElement("select");
			field.options.forEach((opt) => {
				const o = document.createElement("option");
				o.value = opt;
				o.textContent = opt;
				input.appendChild(o);
			});
		} else if (field.type === "textarea") {
			input = document.createElement("textarea");
		} else {
			input = document.createElement("input");
		}
		input.value = field.value || "";
		inputs[field.name] = input;
		body.appendChild(input);
		if (field.hint) {
			const hint = document.createElement("div");
			hint.className = "hint";
			hint.textContent = typeof field.hint === "function" ? field.hint(input.value) : field.hint;
			body.appendChild(hint);
			if (typeof field.hint === "function") {
				input.addEventListener("change", () => {
					hint.textContent = field.hint(input.value);
					if (field.onChange) {
						field.onChange(input.value, inputs);
					}
				});
			}
		}
		if (field.link) {
			// {text, href(value)}: e.g. a block's docs page, follows the selected option
			const link = document.createElement("a");
			link.className = "hint";
			link.target = "_blank";
			link.rel = "noopener";
			link.textContent = field.link.text;
			link.href = field.link.href(input.value);
			body.appendChild(link);
			input.addEventListener("change", () => {
				link.href = field.link.href(input.value);
			});
		}
	});
	return new Promise((resolve) => {
		const okButton = document.getElementById("dialog-ok");
		const onOk = (event) => {
			event.preventDefault();
			const values = {};
			Object.keys(inputs).forEach((key) => {
				values[key] = inputs[key].value;
			});
			Promise.resolve(validate ? validate(values) : values).then((result) => {
				cleanup();
				dialog.close();
				resolve(result);
			}, (err) => {
				error.textContent = err.message;
			});
		};
		const onClose = () => {
			cleanup();
			resolve(null);
		};
		const cleanup = () => {
			okButton.removeEventListener("click", onOk);
			dialog.removeEventListener("close", onClose);
		};
		okButton.addEventListener("click", onOk);
		dialog.addEventListener("close", onClose);
		dialog.showModal();
	});
};

const parseJson = (text) => {
	if (!text.trim()) {
		return {};
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new Error("invalid JSON: " + err.message, { cause: err });
	}
};

ctx.editPane = (pane) => {
	const type = ctx.state.paneTypes[pane.type] || { config: {} };
	return ctx.dialog("Edit " + pane.type + " pane", [
		{ name: "title", value: pane.title },
		{ name: "config", type: "textarea", value: JSON.stringify(pane.config, null, 2), hint: JSON.stringify(type.config, null, 1) }
	], (values) => {
		return api("PATCH", "/panes/" + pane.id, { title: values.title, config: parseJson(values.config) });
	});
};

// ---- grid -------------------------------------------------------------------

const grid = GridStack.init({
	column: 12,
	cellHeight: 64,
	margin: 3,
	handle: ".pane-head",
	float: false,
	columnOpts: { breakpoints: [{ w: 700, c: 1 }] }
}, "#grid");

const mounted = {};
let applyingRemote = false;

// ---- tabs, collapse, maximize ----------------------------------------------------

const TAB_KEY = "mailab.tab";

const readStored = () => {
	try {
		return localStorage.getItem(TAB_KEY);
	} catch (_err) {
		return null;
	}
};

// HTML5 navigation: tabs are real URLs (/tab/<name>) — deep links, reload,
// back/forward all work; the server serves the app for those paths.
// (legacy #tab= links are still read, but never written)
const fromUrl = () => {
	const m = /^\/tab\/([^/]+)$/.exec(location.pathname);
	if (m) {
		try {
			return decodeURIComponent(m[1]);
		} catch (_err) {
			return null;
		}
	}
	return new URLSearchParams(location.hash.slice(1)).get("tab");
};

let currentTab = fromUrl() || readStored();

// the remembered tab, if it still exists; else the first one
const activeTab = () => {
	const tabs = ctx.state.tabs.length ? ctx.state.tabs : ["main"];
	return tabs.indexOf(currentTab) !== -1 ? currentTab : tabs[0];
};

const setTab = (tab, opts) => {
	currentTab = tab;
	try {
		localStorage.setItem(TAB_KEY, tab);
	} catch (_err) {
		// private mode: per-session only
	}
	if (!opts || opts.push !== false) {
		history.pushState({ tab: tab }, "", "/tab/" + encodeURIComponent(tab));
	}
	renderTabs();
	syncPanes(ctx.state.panes);
};

// back/forward walks the tab history
window.addEventListener("popstate", () => {
	const t = fromUrl();
	if (t && t !== currentTab) {
		setTab(t, { push: false });
	}
});

const tabButton = (tab) => {
	const count = ctx.state.panes.filter((p) => (p.tab || "main") === tab).length;
	// a real link: middle-click opens the tab in a new tab, pushState keeps
	// the current one from reloading
	const a = document.createElement("a");
	a.className = "tab" + (tab === activeTab() ? " active" : "");
	a.href = "/tab/" + encodeURIComponent(tab);
	a.title = "double-click to rename";
	a.textContent = tab;
	a.addEventListener("click", (e) => {
		e.preventDefault();
		setTab(tab);
	});
	const n = document.createElement("span");
	n.className = "count";
	n.textContent = count;
	a.appendChild(n);
	a.addEventListener("dblclick", () => {
		const name = prompt("Rename tab", tab);
		if (name && name !== tab) {
			api("PATCH", "/tabs/" + encodeURIComponent(tab), { name: name }).then(() => setTab(name), (err) => alert(err.message));
		}
	});
	if (tab === activeTab() && ctx.state.tabs.length > 1) {
		const x = document.createElement("span");
		x.className = "close";
		x.title = "remove tab (its panes move to the first other tab)";
		x.textContent = "×";
		x.addEventListener("click", (e) => {
			e.stopPropagation();
			e.preventDefault();
			if (confirm("Remove tab \"" + tab + "\"?" + (count ? " Its " + count + " pane(s) move to another tab." : ""))) {
				api("DELETE", "/tabs/" + encodeURIComponent(tab)).then((r) => setTab(r.into), (err) => alert(err.message));
			}
		});
		a.appendChild(x);
	}
	return a;
};

const renderTabs = () => {
	const nav = document.getElementById("tabs");
	nav.replaceChildren(...ctx.state.tabs.map(tabButton));
	const add = document.createElement("button");
	add.className = "tab add";
	add.title = "new tab";
	add.textContent = "+";
	add.addEventListener("click", () => {
		const name = prompt("New tab name");
		if (name) {
			api("POST", "/tabs", { name: name }).then(() => setTab(name.trim()), (err) => alert(err.message));
		}
	});
	nav.appendChild(add);
};

const fillMove = (select, pane) => {
	const tabs = ctx.state.tabs.length ? ctx.state.tabs : ["main"];
	select.replaceChildren(...tabs.map((t) => {
		const o = document.createElement("option");
		o.value = t;
		o.textContent = t === (pane.tab || "main") ? "⇢ " + t : t;
		o.selected = t === (pane.tab || "main");
		return o;
	}), Object.assign(document.createElement("option"), { value: "+", textContent: "+ new tab…" }));
};

const shownHeight = (pane) => (pane.collapsed ? 1 : pane.h);

const showCollapsed = (root, item, pane) => {
	root.classList.toggle("collapsed", Boolean(pane.collapsed));
	root.querySelector("[data-act=collapse]").textContent = pane.collapsed ? "▸" : "▾";
	if (pane.collapsed) {
		item.setAttribute("gs-no-resize", "true");
	} else {
		item.removeAttribute("gs-no-resize");
	}
};

let maximized = null;

const toggleMaximize = (id) => {
	const was = maximized;
	if (maximized && mounted[maximized]) {
		mounted[maximized].item.classList.remove("maximized");
	}
	maximized = was === id ? null : id;
	if (maximized) {
		mounted[maximized].item.classList.add("maximized");
	}
	document.body.classList.toggle("has-maximized", Boolean(maximized));
	const m = mounted[id];
	if (m && m.instance && m.instance.resize) {
		requestAnimationFrame(() => m.instance.resize());
	}
};

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && maximized) {
		toggleMaximize(maximized);
	}
});

const mountPane = (pane) => {
	const item = document.createElement("div");
	item.className = "grid-stack-item";
	item.setAttribute("gs-id", pane.id);
	item.setAttribute("gs-x", pane.x);
	item.setAttribute("gs-y", pane.y);
	item.setAttribute("gs-w", pane.w);
	item.setAttribute("gs-h", shownHeight(pane));
	const content = document.createElement("div");
	content.className = "grid-stack-item-content";
	item.appendChild(content);

	const root = document.createElement("div");
	root.className = "pane";
	root.innerHTML = "<div class=\"pane-head\"><button class=\"icon\" data-act=\"collapse\" title=\"collapse / expand\"></button>"
		+ "<span class=\"pane-title\"></span><span class=\"pane-type\"></span>"
		+ "<span class=\"pane-move-wrap icon\" title=\"move to tab\">⇢<select class=\"pane-move\"></select></span>"
		+ "<button class=\"icon\" data-act=\"max\" title=\"maximize (Esc to restore)\">⤢</button>"
		+ "<button class=\"icon\" data-act=\"edit\" title=\"edit\">⚙</button>"
		+ "<button class=\"icon\" data-act=\"close\" title=\"remove\">×</button></div><div class=\"pane-body\"></div>";
	content.appendChild(root);
	const body = root.querySelector(".pane-body");
	root.querySelector(".pane-title").textContent = pane.title;
	root.querySelector(".pane-type").textContent = pane.type;

	root.querySelector("[data-act=edit]").addEventListener("click", () => {
		ctx.editPane(mounted[pane.id].pane);
	});
	root.querySelector("[data-act=close]").addEventListener("click", () => {
		api("DELETE", "/panes/" + pane.id);
	});
	root.querySelector("[data-act=collapse]").addEventListener("click", () => {
		api("PATCH", "/panes/" + pane.id, { collapsed: !mounted[pane.id].pane.collapsed });
	});
	root.querySelector("[data-act=max]").addEventListener("click", () => {
		toggleMaximize(pane.id);
	});
	const move = root.querySelector(".pane-move");
	move.addEventListener("change", () => {
		const tab = move.value === "+" ? prompt("New tab name") : move.value;
		if (tab && tab !== mounted[pane.id].pane.tab) {
			api("PATCH", "/panes/" + pane.id, { tab: tab });
		} else {
			fillMove(move, mounted[pane.id].pane);
		}
	});
	// the drag handle shouldn't start a drag from the header controls
	[move].concat(Array.from(root.querySelectorAll(".pane-head button"))).forEach((control) => {
		control.addEventListener("mousedown", (e) => e.stopPropagation());
	});
	fillMove(move, pane);
	showCollapsed(root, item, pane);

	applyingRemote = true;
	grid.el.appendChild(item);
	grid.makeWidget(item);
	applyingRemote = false;

	const module = PANES[pane.type];
	let instance = null;
	if (module) {
		instance = module.mount(body, pane, ctx);
	} else {
		body.innerHTML = "<div class=\"empty\">unknown pane type</div>";
	}
	const observer = new ResizeObserver(() => {
		if (instance && instance.resize) {
			instance.resize();
		}
	});
	observer.observe(body);
	mounted[pane.id] = { pane: pane, item: item, root: root, instance: instance, observer: observer };
};

const unmountPane = (id) => {
	const m = mounted[id];
	if (maximized === id) {
		toggleMaximize(id);
	}
	if (m.instance && m.instance.destroy) {
		m.instance.destroy();
	}
	m.observer.disconnect();
	applyingRemote = true;
	grid.removeWidget(m.item);
	applyingRemote = false;
	delete mounted[id];
};

const syncPanes = (allPanes) => {
	const seen = {};
	// only the active tab's panes are mounted
	const panes = allPanes.filter((pane) => (pane.tab || "main") === activeTab());
	panes.forEach((pane) => {
		seen[pane.id] = true;
		const m = mounted[pane.id];
		if (!m) {
			mountPane(pane);
			return;
		}
		if (m.pane.type !== pane.type) {
			unmountPane(pane.id);
			mountPane(pane);
			return;
		}
		const node = m.item.gridstackNode;
		const h = shownHeight(pane);
		if (node && (node.x !== pane.x || node.y !== pane.y || node.w !== pane.w || node.h !== h)) {
			applyingRemote = true;
			grid.update(m.item, { x: pane.x, y: pane.y, w: pane.w, h: h, noResize: Boolean(pane.collapsed) });
			applyingRemote = false;
		}
		if (JSON.stringify(m.pane) !== JSON.stringify(pane)) {
			m.root.querySelector(".pane-title").textContent = pane.title;
			fillMove(m.root.querySelector(".pane-move"), pane);
			showCollapsed(m.root, m.item, pane);
			if (m.instance && m.instance.update) {
				m.instance.update(pane);
			}
		}
		m.pane = pane;
	});
	Object.keys(mounted).forEach((id) => {
		if (!seen[id]) {
			unmountPane(id);
		}
	});
};

grid.on("change", (_event, items) => {
	if (applyingRemote || !items) {
		return;
	}
	api("PUT", "/layout", {
		items: items.map((item) => {
			const m = mounted[item.id];
			// a collapsed pane keeps its expanded height on the server
			const h = m && m.pane.collapsed ? m.pane.h : item.h;
			return { id: item.id, x: item.x, y: item.y, w: item.w, h: h };
		})
	});
});

// ---- header actions (qrp) ---------------------------------------------------

// copy that also works on non-secure origins (http://<ip>) where
// navigator.clipboard does not exist: hidden textarea + execCommand
const copyText = (text) => {
	if (navigator.clipboard && navigator.clipboard.writeText) {
		return navigator.clipboard.writeText(text);
	}
	return new Promise((resolve, reject) => {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		try {
			if (document.execCommand("copy")) {
				resolve();
			} else {
				reject(new Error("copy refused"));
			}
		} catch (err) {
			reject(err);
		} finally {
			ta.remove();
		}
	});
};

const identity = state({ name: "local" });
api("GET", "/whoami").then((who) => {
	identity.name = who.name || "local";
}, () => null);

const openProfiles = () => {
	profilesDialog(document.getElementById("lab-dialog"), document.getElementById("lab-dialog-body"), ctx);
};

// "how do I connect my AI" help, filled with this lab's real address
const openMcpHelp = () => {
	const url = location.origin + "/mcp";
	document.getElementById("mcp-claude").textContent = "claude mcp add --transport http mailab " + url;
	document.getElementById("mcp-json").textContent = JSON.stringify({ mcpServers: { mailab: { type: "http", url: url } } }, null, 2);
	document.getElementById("mcp-channel").textContent = JSON.stringify({ mcpServers: { "mailab-chat": {
		command: "node", args: ["/path/to/mailab/bin/channel.js"],
		env: { MAILAB_URL: location.origin, MAILAB_NAME: "claude" }
	} } }, null, 2);
	api("GET", "/whoami").then((who) => {
		document.getElementById("mcp-auth").hidden = who.name === "local";
	}, () => null);
	document.getElementById("mcp-dialog").showModal();
};

const addPane = () => {
	const types = Object.keys(ctx.state.paneTypes);
	const describe = (type) => {
		const t = ctx.state.paneTypes[type];
		if (!t) {
			return "";
		}
		return t.description + "\n\nconfig: " + JSON.stringify(t.config, null, 1);
	};
	ctx.dialog("Add pane", [
		{ name: "type", type: "select", options: types, hint: describe },
		{ name: "title", value: "" },
		{ name: "config", type: "textarea", value: "{}" }
	], (values) => {
		return api("POST", "/panes", { type: values.type, title: values.title || values.type, config: parseJson(values.config), tab: activeTab() });
	});
};

const addDevice = () => {
	api("GET", "/drivers").then((drivers) => {
		const byName = {};
		drivers.forEach((d) => {
			byName[d.name] = d;
		});
		const describe = (name) => {
			const d = byName[name];
			if (!d) {
				return "";
			}
			return d.description + "\n\noptions: " + JSON.stringify(d.options, null, 1) + "\ncommands: " + JSON.stringify(d.commands, null, 1);
		};
		ctx.dialog("Add device", [
			{ name: "driver", type: "select", options: drivers.map((d) => d.name), hint: describe },
			{ name: "id", label: "id (channel prefix; empty = automatic)", value: "" },
			{ name: "options", type: "textarea", value: "{}" }
		], (values) => {
			return api("POST", "/devices", { id: values.id, driver: values.driver, options: parseJson(values.options) });
		});
	});
};

const cycleTheme = (event) => {
	const current = THEMES.indexOf(document.documentElement.getAttribute("data-theme"));
	const next = THEMES[(current + 1) % THEMES.length];
	if (event && event.currentTarget) {
		event.currentTarget.title = "theme: " + next;
	}
	applyTheme(next);
	try {
		localStorage.setItem("mailab-theme", next);
	} catch (_err) {
		// storage unavailable; theme still applies for this session
	}
};

mount(document.getElementById("header-actions"), () => el("span", { class: "actions" },
	el("button", { class: "mcp", title: "How to connect an AI", onclick: openMcpHelp },
		"MCP ", el("code", {}, location.origin + "/mcp"), " ?"),
	el("button", { title: "save / load the lab setup", onclick: openProfiles }, "lab"),
	el("button", { onclick: addDevice }, "+ device"),
	el("button", { onclick: addPane }, "+ pane"),
	el("button", { title: "toggle theme", onclick: cycleTheme }, "◐"),
	when(() => identity.name !== "local", () => {
		return el("button", {
			class: "signout",
			title: "signed in as " + identity.name + " — sign out",
			onclick: () => {
				location.href = "/api/auth/logout";
			}
		}, "sign out");
	})));

document.getElementById("mcp-dialog").addEventListener("click", (event) => {
	const button = event.target.closest("button[data-copy]");
	if (!button) {
		return;
	}
	copyText(document.getElementById(button.dataset.copy).textContent).then(() => {
		button.textContent = "copied";
		setTimeout(() => {
			button.textContent = "copy";
		}, 1200);
	}, (err) => {
		button.textContent = "⚠ " + err.message;
		setTimeout(() => {
			button.textContent = "copy";
		}, 1500);
	});
});

// ---- safety bypass banner ---------------------------------------------------
// chamber / unsafe bypass (env-only, fixed at server start): a loud,
// persistent strip at the top of every page so a bypassed bench can't be
// mistaken for a fully-protected one (src/utils/bypass)
const bypassBanner = document.createElement("div");
bypassBanner.className = "bypass-banner";
bypassBanner.hidden = true;
document.body.prepend(bypassBanner);

// live RF transmit sessions: the kill switch (server-side auto-stop also applies,
// the banner is just the fast, obvious way to cut a transmission)
const txBanner = document.createElement("div");
txBanner.className = "tx-banner";
txBanner.hidden = true;
document.body.prepend(txBanner);

const syncBypassBanner = (bypass) => {
	const on = Boolean(bypass && bypass.active);
	bypassBanner.hidden = !on;
	document.body.classList.toggle("has-bypass-banner", on);
	if (on) {
		bypassBanner.textContent = (bypass.text || "⚠ SAFETY BYPASSED — chamber mode") + " — every action is still logged";
	}
};

const syncTxBanner = (tx) => {
	const sessions = Array.isArray(tx) ? tx : [];
	txBanner.hidden = sessions.length === 0;
	document.body.classList.toggle("has-tx-banner", sessions.length > 0);
	txBanner.replaceChildren();
	sessions.forEach((s) => {
		const row = document.createElement("span");
		row.className = "tx-session";
		const mhz = (s.freqHz / 1e6).toFixed(3);
		const left = Math.max(0, Math.round((s.endsAt - Date.now()) / 1000));
		row.append(mhz + " MHz, gain " + s.gainDb + " dB, " + s.device + " (" + (s.kind || "tx") + ", by " + (s.startedBy || "?") + ", " + (s.endsAt ? left + "s left" : "until stopped") + " ");
		const kill = document.createElement("button");
		kill.className = "tx-kill";
		kill.textContent = "✕ kill";
		kill.title = "stop this transmission now";
		kill.addEventListener("click", () => {
			kill.disabled = true;
			fetch("/api/tx/kill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: s.id }) })
				.catch((err) => window.alert("kill failed: " + err.message));
		});
		row.append(kill);
		txBanner.append(row);
	});
};

const applyTheme = (theme) => {
	document.documentElement.setAttribute("data-theme", theme);
	emit("theme", theme);
};
let savedTheme;
try {
	savedTheme = localStorage.getItem("mailab-theme") || "dracula";
} catch (_err) {
	savedTheme = "dracula";
}
applyTheme(THEMES.indexOf(savedTheme) === -1 ? "dracula" : savedTheme);

connect();
