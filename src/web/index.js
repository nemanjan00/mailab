// HTTP server: static UI, REST API for the UI, WebSocket push, and the MCP
// endpoint (Streamable HTTP, stateless: one MCP server per request).

const path = require("path");
const http = require("http");
const express = require("express");
const ws = require("ws");
const StreamableHTTPServerTransport = require("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
const mcp = require("../mcp");
const math = require("../math");
const devices = require("../devices");

const STATE_DEBOUNCE_MS = 100;
const TRACE_MIN_INTERVAL_MS = 100;
const ROOT = path.join(__dirname, "..", "..");
const VENDOR = {
	uplot: "node_modules/uplot/dist",
	gridstack: "node_modules/gridstack/dist",
	katex: "node_modules/katex/dist",
	marked: "node_modules/marked/lib"
};

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
				res.status(400).json({ error: err.message });
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
	router.post("/devices/:id/command", route((req) => {
		return lab.commandDevice(req.params.id, req.body.command, req.body.args || {});
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
	router.put("/layout", route((req) => {
		return lab.panes.arrange(req.body.items || []);
	}));

	return router;
};

const mcpHandler = (lab) => {
	return (req, res) => {
		const server = mcp.create(lab);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true
		});
		res.on("close", () => {
			transport.close();
			server.close();
		});
		server.connect(transport)
			.then(() => {
				return transport.handleRequest(req, res, req.body);
			})
			.catch((err) => {
				if (!res.headersSent) {
					res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null });
				}
			});
	};
};

/**
 * Push lab events to every connected browser.
 */
const attachSockets = (server, lab, pushIntervalMs) => {
	const wss = new ws.Server({ server: server, path: "/ws" });
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

	lab.events.on("image", (e) => {
		broadcast({ type: "image", name: e.name, t: Date.now() });
	});
	lab.events.on("log", (entry) => {
		broadcast({ type: "log", entry: entry });
	});
	lab.events.on("activity", (entry) => {
		broadcast({ type: "activity", entry: entry });
	});

	setInterval(() => {
		const samples = lab.drainPending();
		if (Object.keys(samples).length && wss.clients.size) {
			broadcast({ type: "samples", samples: samples });
		}
	}, pushIntervalMs);

	wss.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: "state", state: lab.state() }));
	});

	return wss;
};

/**
 * @param {Object} lab
 * @param {{pushIntervalMs: number}} options
 * @returns {{app: Object, server: http.Server}}
 */
const create = (lab, options) => {
	const app = express();

	app.post("/mcp", express.json({ limit: "20mb" }), mcpHandler(lab));
	app.all("/mcp", (req, res) => {
		res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
	});

	app.use("/api", api(lab));
	Object.keys(VENDOR).forEach((name) => {
		app.use("/vendor/" + name, express.static(path.join(ROOT, VENDOR[name])));
	});
	app.use(express.static(path.join(ROOT, "public")));

	const server = http.createServer(app);
	attachSockets(server, lab, options.pushIntervalMs);
	return { app: app, server: server };
};

module.exports = {
	create: create
};
