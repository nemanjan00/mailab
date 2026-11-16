// HTTP server: static UI, REST API for the UI, WebSocket push, and the MCP
// endpoint (Streamable HTTP, stateless: one MCP server per request).

const path = require("path");
const http = require("http");
const express = require("express");
const ws = require("ws");
const mcpSessions = require("../mcp/sessions");
const authModule = require("../auth");
const math = require("../math");
const devices = require("../devices");
const kaitai = require("../kaitai");
const blobs = require("../blobs");
const captureModule = require("../capture");
const fccid = require("../services/fccid");
const datasheets = require("../services/datasheets");
const vncProxy = require("./vnc");

const STATE_DEBOUNCE_MS = 100;
const TRACE_MIN_INTERVAL_MS = 100;
const ROOT = path.join(__dirname, "..", "..");
// browsers send capture messages (camera frames up to 2 MB, base64) over /ws
const WS_MAX_PAYLOAD = 4 * 1024 * 1024;

// wrap a handler returning a value/promise into an express route
const route = (handler) => {
	return (req, res) => {
		Promise.resolve()
			.then(() => {
				return handler(req, res);
			})
			.then((result) => {
				if (!res.headersSent) {
					res.json(result === undefined ? { ok: true } : result);
				}
			}, (err) => {
				res.status(err.status || 400).json({ error: err.message });
			});
	};
};

const api = (lab) => {
	const router = express.Router();
	router.use(express.json({ limit: "20mb" }));

	router.get("/state", route(() => {
		return lab.state();
	}));
	router.get("/drivers", route(() => {
		return devices.list();
	}));
	router.get("/channels/:name", route((req) => {
		// a chart may ask before the channel's first sample: empty, not an error
		if (!lab.channels.has(req.params.name)) {
			return { t: [], v: [] };
		}
		const opts = {};
		["seconds", "since", "last"].forEach((key) => {
			if (req.query[key] !== undefined) {
				opts[key] = Number(req.query[key]);
			}
		});
		return lab.channels.read(req.params.name, opts);
	}));
	router.get("/traces/:name", route((req) => {
		return lab.getTrace(req.params.name);
	}));
	router.get("/images/:name", (req, res) => {
		try {
			const img = lab.getImage(req.params.name);
			res.type(img.mime).send(img.data);
		} catch (err) {
			res.status(404).json({ error: err.message });
		}
	});
	router.get("/values/:name", route((req) => {
		return lab.getValue(req.params.name);
	}));
	router.put("/values/:name", route((req) => {
		lab.setValue(req.params.name, req.body, "ui");
	}));
	router.get("/blobs/:name", (req, res) => {
		try {
			const blob = lab.getBlob(req.params.name);
			res.type("application/octet-stream").send(blob.data);
		} catch (err) {
			res.status(404).json({ error: err.message });
		}
	});
	router.put("/blobs/:name", express.raw({ type: "*/*", limit: "64mb" }), route((req) => {
		lab.setBlob(req.params.name, req.body, "ui");
		return { name: req.params.name, bytes: req.body.length };
	}));
	router.get("/blobs/:name/analysis", route((req) => {
		return blobs.analyze(lab.getBlob(req.params.name).data, { window: Number(req.query.window) || undefined });
	}));
	router.get("/blobs/:a/diff/:b", route((req) => {
		return blobs.diff(lab.getBlob(req.params.a).data, lab.getBlob(req.params.b).data);
	}));
	router.post("/kaitai", route((req) => {
		return kaitai.parse(req.body.ksy, lab.getBlob(req.body.blob).data);
	}));
	router.get("/chat", route((req) => {
		return lab.getChat({ since: req.query.since === undefined ? undefined : Number(req.query.since), last: Number(req.query.last) || 200 });
	}));
	router.post("/chat", route((req) => {
		// the authenticated name wins over whatever the browser claims
		let from = req.body.from || "anonymous";
		if (req.who && req.who.name !== "local") {
			from = req.who.name;
		}
		// the channel bridge posts on behalf of an AI
		let kind = "human";
		if (req.body.kind === "ai") {
			kind = "ai";
		}
		return lab.postChat({ from: from, kind: kind, text: req.body.text });
	}));
	router.get("/safety", route(() => {
		return { rules: lab.safety.listRules(), policy: lab.safety.getPolicy(), pending: lab.safety.listPending(), fired: lab.safety.firedLog() };
	}));
	router.post("/safety/rules", route((req) => {
		return lab.safety.addRule(req.body, (req.who && req.who.name) || "local");
	}));
	// people only (role human): locked rules, the policy, approvals
	const human = (req) => {
		if (!authModule.isHuman(req.who)) {
			throw Object.assign(new Error((req.who && req.who.name) + " is not a human approver (role human)"), { status: 403 });
		}
	};
	router.delete("/safety/rules/:id", route((req) => {
		const rule = lab.safety.listRules().find((r) => r.id === req.params.id);
		if (rule && rule.locked) {
			human(req);
		}
		return lab.safety.removeRule(req.params.id, authModule.isHuman(req.who));
	}));
	router.put("/safety/policy", route((req) => {
		human(req);
		lab.safety.setPolicy(req.body.policy || []);
		return lab.safety.getPolicy();
	}));
	router.post("/approvals/:id", route((req) => {
		human(req);
		const decision = req.body.approve === true ? "approved" : "denied";
		return lab.safety.decide(req.params.id, decision, (req.who && req.who.name) || "local");
	}));
	router.get("/trends/:channel", route((req) => lab.trends.read(req.params.channel, {
		from: Number(req.query.from) || undefined, to: Number(req.query.to) || undefined, points: Number(req.query.points) || undefined
	})));
	router.get("/trends", route(() => ({ patterns: lab.trends.getPatterns(), recording: lab.trends.channels() })));
	router.put("/trends", route((req) => {
		lab.trends.setPatterns(req.body.patterns || []);
		return { patterns: lab.trends.getPatterns() };
	}));
	// lab profiles: saving a new one is a normal write; overwriting, loading/importing/deleting can
	// replace safety rules and the policy, so only people do it
	router.get("/profiles", route(() => lab.profiles.list()));
	router.post("/profiles", route((req) => {
		// a new profile is a normal write; replacing one (a profile people trust by name) is human-only
		if (lab.profiles.exists(req.body.name)) {
			human(req);
		}
		return lab.profiles.save(req.body.name);
	}));
	router.get("/profiles/:name/diff", route((req) => ({ load: lab.profiles.loadDiff(req.params.name), save: lab.profiles.saveDiff(req.params.name) })));
	router.get("/profiles/:name", (req, res) => {
		try {
			res.attachment(req.params.name + ".mailab.json").json(lab.profiles.get(req.params.name));
		} catch (err) {
			res.status(404).json({ error: err.message });
		}
	});
	router.post("/profiles/:name/load", route((req) => {
		human(req);
		return lab.profiles.load(req.params.name);
	}));
	router.delete("/profiles/:name", route((req) => {
		human(req);
		return lab.profiles.remove(req.params.name);
	}));
	// boards (PCB / schematic tracing): edits are normal writes, deleting a board is for people
	router.get("/boards", route(() => lab.boards.list()));
	router.post("/boards", route((req) => lab.boards.create(req.body.name, req.body.title)));
	router.get("/boards/:name", route((req) => lab.boards.snapshot(req.params.name)));
	router.delete("/boards/:name", route((req) => {
		human(req);
		return lab.boards.remove(req.params.name);
	}));
	// upload a PDF / image file as new layer(s); options in the query string
	router.put("/boards/:name/upload", express.raw({ type: "*/*", limit: "200mb" }), route((req) => lab.boards.importData(req.params.name, req.body, {
		label: req.query.label, pages: req.query.pages, dpi: req.query.dpi, side: req.query.side
	}).then((layers) => ({ layers: layers.map((l) => l.id) }))));
	router.get("/boards/:name/layers/:id/image", (req, res) => {
		try {
			const file = lab.boards.layerFile(req.params.name, req.params.id);
			res.type(file.mime).sendFile(file.path);
		} catch (err) {
			res.status(404).json({ error: err.message });
		}
	});
	router.patch("/boards/:name/layers/:id", route((req) => lab.boards.updateLayer(req.params.name, req.params.id, req.body || {})));
	router.post("/boards/:name/layers/:id/align", route((req) => lab.boards.alignLayer(req.params.name, req.params.id, req.body.pairs, req.body.flip)));
	router.delete("/boards/:name/layers/:id", route((req) => lab.boards.removeLayer(req.params.name, req.params.id)));
	router.get("/boards/:name/text", route((req) => {
		const q = req.query;
		const region = q.w ? { x: Number(q.x), y: Number(q.y), w: Number(q.w), h: Number(q.h) } : undefined;
		return lab.boards.text(req.params.name, { layer: q.layer, region: region, limit: Number(q.limit) || undefined });
	}));
	router.get("/boards/:name/search", route((req) => lab.boards.search(req.params.name, req.query.q, {
		regex: req.query.regex === "1", exact: req.query.exact === "1"
	})));
	router.post("/boards/:name/draw", route((req) => lab.boards.draw(req.params.name, req.body.ops)));
	router.post("/boards/:name/query", route((req) => lab.boards.query(req.params.name, req.body || {})));
	router.get("/boards/:name/netlist", (req, res) => {
		try {
			const format = req.query.format || "json";
			const out = lab.boards.netlist(req.params.name, format);
			if (format === "json") {
				res.json(out);
				return;
			}
			res.attachment(req.params.name + (format === "kicad" ? ".net" : ".csv")).type("text/plain").send(out);
		} catch (err) {
			res.status(400).json({ error: err.message });
		}
	});
	router.get("/lab/export", (req, res) => {
		res.attachment("lab.mailab.json").json(lab.exportState());
	});
	router.post("/lab/import", route((req) => {
		human(req);
		return lab.importState(req.body);
	}));
	// recordings: starting/stopping is a normal write, deleting is for people
	router.get("/recordings", route(() => lab.recordings.list()));
	router.post("/recordings", route((req) => lab.recordings.start(req.body || {}, (req.who && req.who.name) || "local")));
	router.post("/recordings/:name/stop", route((req) => lab.recordings.stop(req.params.name)));
	router.get("/recordings/:name", (req, res) => {
		try {
			res.attachment(req.params.name + ".ndjson").sendFile(lab.recordings.fileFor(req.params.name));
		} catch (err) {
			res.status(404).json({ error: err.message });
		}
	});
	router.delete("/recordings/:name", route((req) => {
		human(req);
		return lab.recordings.remove(req.params.name);
	}));
	router.get("/usb", route(() => lab.usbTree()));
	router.get("/uart/ports", route(() => lab.uartPorts()));
	router.post("/usb/power", route((req) => {
		human(req);
		const usb = require("../services/usb");
		lab.recordActivity({ who: (req.who && req.who.name) || "local", tool: "usb_power", args: JSON.stringify(req.body), ok: true });
		return usb.setPower(req.body.hub, req.body.port, req.body.action);
	}));
	router.get("/udev", route(() => lab.udev.list()));
	router.post("/udev", route((req) => lab.udev.add(req.body || {})));
	router.delete("/udev/:id", route((req) => lab.udev.remove(req.params.id)));
	router.get("/classifier", route(() => lab.classifier.status({ limit: 200 })));
	router.post("/classifier/templates", route((req) => lab.classifier.addTemplate(req.body)));
	router.delete("/classifier/templates/:name", route((req) => lab.classifier.removeTemplate(req.params.name)));
	router.get("/notifications", route((req) => lab.getNotifications({ since: req.query.since === undefined ? undefined : Number(req.query.since) })));
	router.get("/whoami", route((req) => {
		return req.who || { name: "local", role: "rw" };
	}));
	router.get("/logs", route((req) => {
		return lab.getLogs({ device: req.query.device, last: Number(req.query.last) || 300 });
	}));
	router.get("/activity", route(() => {
		return lab.getActivity();
	}));

	router.post("/eval", route((req) => {
		const result = lab.evaluate(req.body.expression, { samples: req.body.samples, seconds: req.body.seconds });
		let tex;
		try {
			tex = math.tex(req.body.expression);
		} catch (_err) {
			tex = "";
		}
		return Object.assign({ tex: tex }, result);
	}));

	router.post("/devices", route((req) => {
		return lab.addDevice(req.body.id, req.body.driver, req.body.options || {});
	}));
	router.delete("/devices/:id", route((req) => {
		return lab.removeDevice(req.params.id);
	}));
	router.post("/devices/:id/start", route((req) => {
		return lab.startDevice(req.params.id);
	}));
	router.post("/devices/:id/stop", route((req) => {
		return lab.stopDevice(req.params.id);
	}));
	// web terminal: scrollback, and keystrokes as typed (raw bytes, base64)
	router.get("/devices/:id/term", route((req) => {
		lab.getDevice(req.params.id);
		return { data: lab.getTerm(req.params.id) };
	}));
	router.post("/devices/:id/term", route((req) => lab.commandDevice(req.params.id, "write_raw", { data: String(req.body.data || "") })));
	router.post("/devices/:id/command", route((req) => {
		return lab.commandDevice(req.params.id, req.body.command, req.body.args || {});
	}));

	router.post("/plot", route((req) => {
		return lab.plot(req.body);
	}));

	router.post("/derived", route((req) => {
		return lab.defineDerived(req.body.name, req.body.expression, req.body.unit);
	}));
	router.delete("/derived/:name", route((req) => {
		return lab.removeDerived(req.params.name);
	}));

	router.post("/panes", route((req) => {
		return lab.panes.add(req.body);
	}));
	router.patch("/panes/:id", route((req) => {
		return lab.panes.update(req.params.id, req.body);
	}));
	router.delete("/panes/:id", route((req) => {
		return lab.panes.remove(req.params.id);
	}));
	// dashboard tabs (pages of panes)
	router.get("/tabs", route(() => lab.panes.tabs()));
	router.post("/tabs", route((req) => lab.panes.addTab(req.body.name)));
	router.put("/tabs", route((req) => lab.panes.orderTabs([].concat(req.body.tabs || []))));
	router.patch("/tabs/:name", route((req) => lab.panes.renameTab(req.params.name, req.body.name)));
	router.delete("/tabs/:name", route((req) => lab.panes.removeTab(req.params.name, req.query.into)));
	router.put("/layout", route((req) => {
		return lab.panes.arrange(req.body.items || []);
	}));

	// research: FCC ID filings and the datasheet DB (GETs only read; they may fill the HTTP cache)
	// produce() may throw synchronously (unknown id): still a JSON error
	const sendFile = (res, produce) => {
		Promise.resolve().then(produce).then((r) => {
			res.type(r.mime).set("cache-control", "private, max-age=3600").send(r.data);
		}, (err) => {
			res.status(err.status || 400).json({ error: err.message });
		});
	};
	router.get("/fccid/search", route((req) => fccid.find(req.query.q)));
	router.get("/fccid/exhibit", route((req) => fccid.exhibit(req.query.url)));
	router.get("/fccid/preview", (req, res) => sendFile(res, () => fccid.preview(req.query.url)));
	router.get("/fccid/:id", route((req) => fccid.lookup(req.params.id)));
	router.post("/fccid/fetch", route((req) => {
		return fccid.download({ url: req.body.url }).then((r) => {
			const name = String(req.body.name || "fcc_" + (r.exhibit.documentId || Date.now())).replace(/[^A-Za-z0-9_]+/g, "_");
			lab.setBlob(name, r.data, "fccid");
			if (/^image\//.test(r.mime)) {
				lab.setImage(name, r.data, r.mime);
			}
			return { name: name, bytes: r.data.length, mime: r.mime, title: r.exhibit.title };
		});
	}));
	router.get("/datasheets", route(() => ({ items: datasheets.library().list(), providers: datasheets.providers() })));
	router.get("/datasheets/search", route((req) => datasheets.search(req.query.q, { online: req.query.online !== "0" })));
	router.get("/datasheets/find", route((req) => datasheets.find({ query: req.query.q, kind: req.query.kind || undefined, id: req.query.id || undefined, limit: Number(req.query.limit) || undefined })));
	router.post("/datasheets/fetch", route((req) => datasheets.fetch(req.body || {})));
	router.get("/datasheets/:id/pdf", (req, res) => {
		try {
			res.type("application/pdf").sendFile(datasheets.library().file(req.params.id));
		} catch (err) {
			res.status(err.status || 404).json({ error: err.message });
		}
	});
	router.get("/datasheets/:id/text/:page", route((req) => ({ id: req.params.id, page: Number(req.params.page), text: datasheets.library().pageText(req.params.id, req.params.page) })));
	router.get("/datasheets/:id/page/:page", (req, res) => {
		sendFile(res, () => datasheets.render(req.params.id, req.params.page, Number(req.query.dpi) || undefined).then((png) => ({ data: png, mime: "image/png" })));
	});
	router.get("/datasheets/:id", route((req) => datasheets.library().get(req.params.id)));
	router.delete("/datasheets/:id", route((req) => datasheets.library().remove(req.params.id)));

	return router;
};

/**
 * Push lab events to every connected browser.
 */
const attachSockets = (server, lab, pushIntervalMs, auth, capture) => {
	// one upgrade handler for every WebSocket path: two ws servers attached to
	// the same http server would each reject the other's paths
	const wss = new ws.Server({
		noServer: true,
		maxPayload: WS_MAX_PAYLOAD,
		verifyClient: (info) => {
			return Boolean(auth.identify(info.req));
		}
	});
	const vnc = vncProxy.create(lab, auth);
	server.on("upgrade", (req, socket, head) => {
		const url = String(req.url || "");
		const pathname = url.indexOf("?") === -1 ? url : url.slice(0, url.indexOf("?"));
		if (pathname === "/ws") {
			wss.handleUpgrade(req, socket, head, (client) => {
				wss.emit("connection", client, req);
			});
		} else if (vnc.handles(req)) {
			vnc.upgrade(req, socket, head);
		} else {
			socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			socket.destroy();
		}
	});
	const lastTraceSent = {};
	const traceTimers = {};
	let stateTimer = null;

	const broadcast = (msg) => {
		const data = JSON.stringify(msg);
		wss.clients.forEach((client) => {
			if (client.readyState === ws.OPEN) {
				client.send(data);
			}
		});
	};

	const sendTrace = (name) => {
		lastTraceSent[name] = Date.now();
		traceTimers[name] = null;
		broadcast({ type: "trace", trace: lab.getTrace(name) });
	};

	lab.events.on("state", () => {
		clearTimeout(stateTimer);
		stateTimer = setTimeout(() => {
			broadcast({ type: "state", state: lab.state() });
		}, STATE_DEBOUNCE_MS);
	});

	// throttle per trace: fast sweeps and glitch campaigns update very often
	lab.events.on("trace", (e) => {
		if (traceTimers[e.name]) {
			return;
		}
		const wait = TRACE_MIN_INTERVAL_MS - (Date.now() - (lastTraceSent[e.name] || 0));
		traceTimers[e.name] = setTimeout(() => {
			sendTrace(e.name);
		}, Math.max(0, wait));
	});

	lab.events.on("chat", (msg) => {
		const entry = Object.assign({}, msg);
		delete entry.session;
		broadcast({ type: "chat", message: entry });
	});
	// low-volume events go to every browser and the channel bridge;
	// per-line events (match, line) only to MCP sessions that subscribed
	lab.events.on("notify", (ev) => {
		if (ev.type !== "match" && ev.type !== "line") {
			broadcast({ type: "notify", event: ev });
		}
	});
	lab.events.on("approval", (entry) => {
		broadcast({ type: "approval", approval: entry });
	});
	lab.events.on("blob", (e) => {
		broadcast({ type: "blob", name: e.name });
	});
	lab.events.on("value", (e) => {
		broadcast({ type: "value", value: lab.getValue(e.name) });
	});
	lab.events.on("term", (chunk) => {
		broadcast({ type: "term", device: chunk.device, data: chunk.data });
	});
	lab.events.on("audio", (chunk) => {
		broadcast({ type: "audio", chunk: chunk });
	});
	lab.events.on("image", (e) => {
		broadcast({ type: "image", name: e.name, t: Date.now() });
	});
	lab.events.on("board", (e) => {
		broadcast({ type: "board", name: e.name });
	});
	lab.events.on("log", (entry) => {
		broadcast({ type: "log", entry: entry });
	});
	lab.events.on("activity", (entry) => {
		broadcast({ type: "activity", entry: entry });
	});

	// unref: the push loop alone shouldn't keep the process (or a test worker) alive
	const pusher = setInterval(() => {
		const samples = lab.drainPending();
		if (Object.keys(samples).length && wss.clients.size) {
			broadcast({ type: "samples", samples: samples });
		}
	}, pushIntervalMs);
	pusher.unref();
	server.on("close", () => {
		clearInterval(pusher);
		wss.close();
		vnc.close();
	});

	wss.on("connection", (socket, req) => {
		socket.send(JSON.stringify({ type: "state", state: lab.state() }));
		// browsers push media (mic, camera) as capture_* messages; the identity
		// decides whether they may (rw / human)
		const sendTo = (msg) => {
			if (socket.readyState === ws.OPEN) {
				socket.send(JSON.stringify(msg));
			}
		};
		const client = capture.connect(auth.identify(req), sendTo);
		socket.on("message", (raw, isBinary) => {
			let msg = null;
			try {
				msg = isBinary ? null : JSON.parse(raw.toString());
			} catch (_err) {
				msg = null;
			}
			capture.message(client, msg).then((reply) => {
				if (reply) {
					sendTo(reply);
				}
			}, (err) => {
				sendTo({ type: "capture_error", device: msg && msg.device, ref: msg && msg.ref, error: err.message });
			});
		});
		socket.on("close", () => {
			capture.disconnect(client);
		});
	});

	return wss;
};

/**
 * @param {Object} lab
 * @param {{pushIntervalMs: number}} options
 * @returns {{app: Object, server: http.Server}}
 */
// REST calls that only read even though they POST
const READ_POSTS = ["/eval", "/kaitai", "/chat", "/plot"];

const create = (lab, options) => {
	const app = express();
	const auth = options.auth || authModule.create();
	const sessions = mcpSessions.create(lab);
	const capture = captureModule.create(lab, { limits: options.captureLimits });

	// chat reaches connected AIs as MCP notifications (Claude Code shows them via the
	// stdio channel bridge, bin/channel.js; other clients may read them as log messages)
	lab.events.on("chat", (msg) => {
		const text = msg.from + ": " + msg.text;
		sessions.notifyAll("notifications/claude/channel", { content: text, meta: { source: "mailab", from: msg.from, kind: msg.kind } }, msg.session);
		sessions.notifyAll("notifications/message", { level: "info", logger: "mailab-chat", data: text }, msg.session);
	});

	// MCP calls are checked per tool (read-only tokens get read tools only)
	app.all("/mcp", auth.middleware(() => true), express.json({ limit: "20mb" }), sessions.handle);

	app.use("/api", auth.middleware((req) => {
		return req.method === "GET" || READ_POSTS.indexOf(req.path) !== -1;
	}), api(lab));
	app.get("/", auth.login);
	app.use(express.static(path.join(ROOT, "public")));

	const server = http.createServer(app);
	attachSockets(server, lab, options.pushIntervalMs, auth, capture);
	return { app: app, server: server, sessions: sessions, capture: capture };
};

module.exports = {
	create: create
};
