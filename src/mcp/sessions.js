// MCP over Streamable HTTP with sessions, so the lab knows who each connected
// AI is and can push to it (chat messages) over the session's SSE stream.
// Requests without a session id that aren't `initialize` are served
// statelessly (one-shot server), which keeps curl/simple clients working.

const randomUUID = require("crypto").randomUUID;
const StreamableHTTPServerTransport = require("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
const mcp = require(".");

const isInitialize = (body) => {
	return [].concat(body || []).some((msg) => {
		return msg && msg.method === "initialize";
	});
};

/**
 * @param {Object} lab
 */
const create = (lab) => {
	// session id -> {server, transport, who, client}
	const sessions = {};

	const fail = (res, status, message) => {
		if (!res.headersSent) {
			res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message: message }, id: null });
		}
	};

	const stateless = (req, res) => {
		const server = mcp.create(lab, { who: req.who });
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		res.on("close", () => {
			transport.close();
			server.close();
		});
		return server.connect(transport).then(() => {
			return transport.handleRequest(req, res, req.body);
		});
	};

	const open = (req, res) => {
		const session = { who: req.who, client: null };
		session.server = mcp.create(lab, { who: req.who, session: session });
		session.transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: randomUUID,
			enableJsonResponse: true,
			onsessioninitialized: (id) => {
				session.id = id;
				sessions[id] = session;
			}
		});
		session.transport.onclose = () => {
			if (session.id) {
				delete sessions[session.id];
			}
		};
		// remember the client's name (e.g. "claude-code") for the activity feed and chat
		session.server.server.oninitialized = () => {
			const info = session.server.server.getClientVersion();
			session.client = info && info.name;
		};
		return session.server.connect(session.transport).then(() => {
			return session.transport.handleRequest(req, res, req.body);
		});
	};

	const handle = (req, res) => {
		const id = req.headers["mcp-session-id"];
		let work;
		if (id && sessions[id]) {
			work = sessions[id].transport.handleRequest(req, res, req.body);
		} else if (id) {
			fail(res, 404, "unknown or expired session");
			return;
		} else if (req.method === "POST" && isInitialize(req.body)) {
			work = open(req, res);
		} else if (req.method === "POST") {
			work = stateless(req, res);
		} else {
			fail(res, 400, "mcp-session-id required");
			return;
		}
		Promise.resolve(work).catch((err) => {
			fail(res, 500, err.message);
		});
	};

	return {
		handle: handle,

		list: () => {
			return Object.keys(sessions).map((id) => {
				const s = sessions[id];
				return { id: id, who: s.who && s.who.name, client: s.client };
			});
		},

		/**
		 * Send a notification to every session (except `exceptId`).
		 * @returns {number} sessions notified
		 */
		notifyAll: (method, params, exceptId) => {
			const targets = Object.keys(sessions).filter((id) => id !== exceptId);
			targets.forEach((id) => {
				sessions[id].server.server.notification({ method: method, params: params }).catch(() => {
					return null;
				});
			});
			return targets.length;
		}
	};
};

module.exports = {
	create: create
};
