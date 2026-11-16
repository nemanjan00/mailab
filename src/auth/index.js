// Optional access control for collaboration. Tokens come from MAILAB_TOKENS:
//   "alice:s3cret:rw,claude-bob:t0ken:rw,viewer:abc:ro"
// Without tokens the lab is open (fine on 127.0.0.1, the default HOST).
// A token is accepted as "Authorization: Bearer <token>", ?token=<token>,
// or the mailab_token cookie (set by the web UI).

const config = require("../config");

const ROLES = ["rw", "ro"];
const OPEN = { name: "local", role: "rw" };

const parseTokens = (text) => {
	const tokens = {};
	String(text || "").split(",").map((entry) => {
		return entry.trim();
	}).filter(Boolean).forEach((entry) => {
		const parts = entry.split(":");
		const role = parts[2] || "rw";
		if (parts.length < 2 || ROLES.indexOf(role) === -1) {
			throw new Error("bad MAILAB_TOKENS entry (name:token[:rw|ro]): " + entry);
		}
		tokens[parts[1]] = { name: parts[0], role: role };
	});
	return tokens;
};

const cookieToken = (header) => {
	const match = /(?:^|;\s*)mailab_token=([^;]+)/.exec(header || "");
	if (!match) {
		return null;
	}
	return decodeURIComponent(match[1]);
};

/**
 * @param {Object} [tokens] token -> {name, role}; default from MAILAB_TOKENS
 */
const create = (tokens) => {
	const table = tokens || parseTokens(config.get("MAILAB_TOKENS"));
	const enabled = Object.keys(table).length > 0;

	const auth = {
		enabled: enabled,

		/**
		 * Identity for a request (express req or a ws upgrade request), or null.
		 */
		identify: (req) => {
			if (!enabled) {
				return OPEN;
			}
			const header = req.headers.authorization || "";
			let token;
			if (header.startsWith("Bearer ")) {
				token = header.slice(7).trim();
			} else if (req.url && req.url.indexOf("token=") !== -1) {
				token = new URL(req.url, "http://x").searchParams.get("token");
			} else {
				token = cookieToken(req.headers.cookie);
			}
			return table[token] || null;
		},

		/**
		 * Express middleware: 401 without a valid token; read-only tokens may only read.
		 * @param {function(Object): boolean} [isRead] decides whether a request only reads
		 */
		middleware: (isRead) => {
			return (req, res, next) => {
				const who = auth.identify(req);
				if (!who) {
					res.status(401).json({ error: "token required" });
					return;
				}
				const reading = isRead ? isRead(req) : req.method === "GET";
				if (who.role === "ro" && !reading) {
					res.status(403).json({ error: who.name + " is read-only" });
					return;
				}
				req.who = who;
				next();
			};
		}
	};

	return auth;
};

module.exports = {
	create: create,
	parseTokens: parseTokens
};
