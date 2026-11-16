// mailab web UI: keeps a live copy of lab state, mounts panes on a grid and
// syncs layout edits back. Panes are modules in ./panes, one per pane type.
// Bundled with esbuild (yarn build) into public/build/.

import { GridStack } from "gridstack";
import { batch, state } from "@nemanjan00/qrp";
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

const PANES = { chart, value, trace, waterfall, image, markdown, math: mathPane, log, activity, devices, channels, audio, json, flowgraph, kaitai, chat, graph, blob, hex, classifier, trend, custom, usb, terminal };
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

// collaboration mode: the server wants a token; keep it in a cookie for api + ws
let asked = false;
const askToken = () => {
	if (asked) {
		return;
	}
	asked = true;
	const token = prompt("This lab needs an access token:");
	if (token) {
		// the server swaps it for an HttpOnly cookie and redirects to the clean URL
		location.href = "/?token=" + encodeURIComponent(token);
	}
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
	state: state({ devices: [], channels: [], traces: [], images: [], values: [], blobs: [], panes: [], paneTypes: {} }),
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
	editPane: null
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

const connect = () => {
	const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
	const dot = document.getElementById("conn");
	ws.onopen = () => {
		dot.classList.add("on");
	};
	ws.onclose = () => {
		dot.classList.remove("on");
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
 * fields: [{name, label, type: text|textarea|select, value, options, hint}]
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

const mountPane = (pane) => {
	const item = document.createElement("div");
	item.className = "grid-stack-item";
	item.setAttribute("gs-id", pane.id);
	item.setAttribute("gs-x", pane.x);
	item.setAttribute("gs-y", pane.y);
	item.setAttribute("gs-w", pane.w);
	item.setAttribute("gs-h", pane.h);
	const content = document.createElement("div");
	content.className = "grid-stack-item-content";
	item.appendChild(content);

	const root = document.createElement("div");
	root.className = "pane";
	root.innerHTML = "<div class=\"pane-head\"><span class=\"pane-title\"></span><span class=\"pane-type\"></span>"
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
	if (m.instance && m.instance.destroy) {
		m.instance.destroy();
	}
	m.observer.disconnect();
	applyingRemote = true;
	grid.removeWidget(m.item);
	applyingRemote = false;
	delete mounted[id];
};

const syncPanes = (panes) => {
	const seen = {};
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
		if (node && (node.x !== pane.x || node.y !== pane.y || node.w !== pane.w || node.h !== pane.h)) {
			applyingRemote = true;
			grid.update(m.item, { x: pane.x, y: pane.y, w: pane.w, h: pane.h });
			applyingRemote = false;
		}
		if (JSON.stringify(m.pane) !== JSON.stringify(pane)) {
			m.root.querySelector(".pane-title").textContent = pane.title;
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
			return { id: item.id, x: item.x, y: item.y, w: item.w, h: item.h };
		})
	});
});

// ---- toolbar ------------------------------------------------------------------

document.getElementById("mcp-url").textContent = location.origin + "/mcp";

document.getElementById("lab-menu").addEventListener("click", () => {
	profilesDialog(document.getElementById("lab-dialog"), document.getElementById("lab-dialog-body"), ctx);
});

// "how do I connect my AI" help, filled with this lab's real address
document.getElementById("mcp-help").addEventListener("click", () => {
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
});
document.getElementById("mcp-dialog").addEventListener("click", (event) => {
	const button = event.target.closest("button[data-copy]");
	if (!button) {
		return;
	}
	navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent).then(() => {
		button.textContent = "copied";
		setTimeout(() => {
			button.textContent = "copy";
		}, 1200);
	}, () => null);
});

document.getElementById("add-pane").addEventListener("click", () => {
	const types = Object.keys(ctx.state.paneTypes);
	const describe = (type) => {
		const t = ctx.state.paneTypes[type];
		return t.description + "\n\nconfig: " + JSON.stringify(t.config, null, 1);
	};
	ctx.dialog("Add pane", [
		{ name: "type", type: "select", options: types, hint: describe },
		{ name: "title", value: "" },
		{ name: "config", type: "textarea", value: "{}" }
	], (values) => {
		return api("POST", "/panes", { type: values.type, title: values.title || values.type, config: parseJson(values.config) });
	});
});

document.getElementById("add-device").addEventListener("click", () => {
	api("GET", "/drivers").then((drivers) => {
		const byName = {};
		drivers.forEach((d) => {
			byName[d.name] = d;
		});
		const describe = (name) => {
			const d = byName[name];
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
});

const themeButton = document.getElementById("theme");
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
themeButton.addEventListener("click", () => {
	const current = THEMES.indexOf(document.documentElement.getAttribute("data-theme"));
	const next = THEMES[(current + 1) % THEMES.length];
	themeButton.title = "theme: " + next;
	applyTheme(next);
	try {
		localStorage.setItem("mailab-theme", next);
	} catch (_err) {
		// storage unavailable; theme still applies for this session
	}
});

connect();
