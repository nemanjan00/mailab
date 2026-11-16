// Access control. Tokens come from MAILAB_TOKENS:
//   "alice:s3cret:rw,claude-bob:t0ken:rw,viewer:abc:ro"
// A token is accepted as "Authorization: Bearer <token>" or the mailab_token
// cookie. `/?token=` is only a login link: the page handler swaps it for an
// HttpOnly cookie and redirects, so tokens don't linger in URLs (history,
// proxy logs) and aren't accepted there anywhere else.
//
// Without tokens the lab is open, which is only safe on loopback: the server
// refuses a non-loopback HOST without tokens (see checkExposure), and open
// mode only accepts loopback Host headers and same-origin requests, which
// blocks DNS rebinding from web pages.

const config = require("../config");

const ROLES = ["rw", "ro"];
const OPEN = { name: "local", role: "rw" };
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/**
 * @returns {Map<string, {name: string, role: string}>} token -> identity
 */
const parseTokens = (text) => {
	const tokens = new Map();
	String(text || "").split(",").map((entry) => {
		return entry.trim();
	}).filter(Boolean).forEach((entry) => {
		const parts = entry.split(":");
		const role = parts[2] || "rw";
		if (parts.length < 2 || !parts[0] || !parts[1] || ROLES.indexOf(role) === -1) {
			throw new Error("bad MAILAB_TOKENS entry (name:token[:rw|ro]): " + entry);
		}
		tokens.set(parts[1], { name: parts[0], role: role });
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

const hostname = (hostHeader) => {
	const host = String(hostHeader || "").toLowerCase();
	if (host.startsWith("[")) {
		return host.slice(0, host.indexOf("]") + 1);
	}
	return host.split(":")[0];
};

const isLoopbackHost = (host) => {
	return LOOPBACK_HOSTS.indexOf(host) !== -1;
};

/**
 * Refuse to serve an open (tokenless) lab beyond loopback.
 * @param {{host: string, tokens: Map, allowOpen: boolean}} options
 */
const checkExposure = (options) => {
	if (options.tokens.size || options.allowOpen || isLoopbackHost(hostname(options.host))) {
		return;
	}
	throw new Error("HOST=" + options.host + " exposes the lab without auth: set MAILAB_TOKENS "
		+ "(or MAILAB_ALLOW_OPEN=1 if the network is trusted)");
};

/**
 * @param {Map} [tokens] token -> {name, role}; default from MAILAB_TOKENS
 * @param {{allowedHosts: string[]}} [options] extra Host names accepted in open mode
 */
const create = (tokens, options) => {
	const table = tokens || parseTokens(config.get("MAILAB_TOKENS"));
	const enabled = table.size > 0;
	const allowedHosts = LOOPBACK_HOSTS.concat(((options && options.allowedHosts) || String(config.get("MAILAB_ALLOWED_HOSTS") || "").split(","))
		.map((h) => h.trim().toLowerCase())
		.filter(Boolean));

	// open mode: only requests addressed to an allowed host, and same-origin
	// when the browser says where it comes from (DNS rebinding)
	const openRequestAllowed = (req) => {
		const host = hostname(req.headers.host);
		if (allowedHosts.indexOf(host) === -1) {
			return false;
		}
		const origin = req.headers.origin;
		if (!origin) {
			return true;
		}
		try {
			return new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase();
		} catch (_err) {
			return false;
		}
	};

	const auth = {
		enabled: enabled,

		/**
		 * Express handler for login links (`/?token=…`): valid token -> HttpOnly
		 * cookie + redirect to the clean URL; anything else falls through.
		 */
		login: (req, res, next) => {
			const token = req.query && req.query.token;
			if (!enabled || typeof token !== "string") {
				next();
				return;
			}
			if (!table.has(token)) {
				res.status(401).send("invalid token");
				return;
			}
			res.cookie("mailab_token", token, { httpOnly: true, sameSite: "strict", path: "/" });
			res.redirect(302, req.path);
		},

		/**
		 * Identity for a request (express req or a ws upgrade request), or null.
		 */
		identify: (req) => {
			if (!enabled) {
				return openRequestAllowed(req) ? OPEN : null;
			}
			const header = req.headers.authorization || "";
			let token;
			if (header.startsWith("Bearer ")) {
				token = header.slice(7).trim();
			} else {
				token = cookieToken(req.headers.cookie);
			}
			// Map lookup: inherited names (constructor, __proto__, toString) are not tokens
			if (typeof token !== "string" || !table.has(token)) {
				return null;
			}
			return table.get(token);
		},

		/**
		 * Express middleware: 401 without a valid identity; writes need role "rw" exactly.
		 * @param {function(Object): boolean} [isRead] decides whether a request only reads
		 */
		middleware: (isRead) => {
			return (req, res, next) => {
				const who = auth.identify(req);
				if (!who || ROLES.indexOf(who.role) === -1) {
					res.status(401).json({ error: enabled ? "token required" : "host/origin not allowed" });
					return;
				}
				const reading = isRead ? isRead(req) : req.method === "GET";
				if (!reading && who.role !== "rw") {
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
	parseTokens: parseTokens,
	checkExposure: checkExposure,
	isLoopbackHost: isLoopbackHost,
	hostname: hostname
};
