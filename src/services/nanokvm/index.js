// HTTP / WebSocket client for a Sipeed NanoKVM (Cube Lite/Full, PCIe; the
// NanoKVM-Pro speaks the same login, MJPEG, HID and GPIO API).
//
// API sources (read from the vendor's open source, not from a device):
//   sipeed/NanoKVM abb83f34c8107e47da8bb1167e329e22ee6f4267 (2.5.4, 2026-11-12)
//     server/router/*.go                 routes
//     server/service/auth/login.go       POST /api/auth/login {username, password}
//     server/utils/encrypt.go            password = urlencode(CryptoJS AES(pw, "nanokvm-sipeed-2024"))
//     server/middleware/jwt.go           JWT in cookie "nano-kvm-token"; 401 "unauthorized"
//     server/proto/response.go           {code: 0 ok | <0 error, msg, data}
//   sipeed/NanoKVM c77981cc0ceebd8f6705b6c5d8c3cf4edf4f6717 (2.2.9): the login
//     answers data.token and the web UI sets the cookie itself (2.5.1 moved to
//     an HttpOnly Set-Cookie); both are handled here
//   sipeed/NanoKVM-Pro 3b45b354118570fbf8257e13237ae1d793c78c39: login answers
//     data.token, same cookie name
//
// Only the configured host is contacted: a KVM on the LAN is a configured lab
// device, so this is plain http(s) without the web-lookup SSRF guard, and
// redirects are never followed (a 3xx is an error).

const http = require("http");
const https = require("https");
const WsClient = require("ws");
const cryptojs = require("../../utils/cryptojs");

const COOKIE = "nano-kvm-token";
// public, hard-coded in the NanoKVM firmware and web UI (transport obfuscation only)
const PASSWORD_KEY = "nanokvm-sipeed-2024";
const DEFAULT_USERNAME = "admin";
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const httpError = (message, status) => Object.assign(new Error(message), { status: status });

/**
 * Normalize the host option: "10.0.0.5", "kvm.lan:8080", "https://10.0.0.5".
 * @returns {URL} origin only (http: or https:)
 */
const parseHost = (host) => {
	const text = String(host || "").trim();
	if (!text) {
		throw new Error("host is required (e.g. 192.168.1.50 or https://nanokvm.lan)");
	}
	const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : "http://" + text);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("host must be http:// or https://");
	}
	if (url.username || url.password) {
		throw new Error("put credentials in username/password, not in host");
	}
	return new URL(url.origin);
};

/**
 * @param {{host: string, username: string, password: string, verifyTls: boolean, timeoutMs: number}} options
 */
const create = (options) => {
	const o = options || {};
	const base = parseHost(o.host);
	const secure = base.protocol === "https:";
	const transport = secure ? https : http;
	// self-signed certificates are the default on these boxes
	const agent = new transport.Agent({ keepAlive: true, rejectUnauthorized: Boolean(o.verifyTls) });
	const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
	const st = { cookie: "", login: null, logins: 0 };

	const headers = (extra) => Object.assign({ accept: "application/json" }, st.cookie ? { cookie: COOKIE + "=" + st.cookie } : {}, extra || {});

	const takeCookie = (res) => {
		[].concat(res.headers["set-cookie"] || []).forEach((line) => {
			const m = new RegExp("^\\s*" + COOKIE + "=([^;]*)").exec(line);
			if (m && m[1]) {
				st.cookie = m[1];
			}
		});
	};

	/**
	 * One request; resolves with the response stream once headers arrive.
	 */
	const open = (method, path, body, extra, waitMs) => new Promise((resolve, reject) => {
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const req = transport.request({
			protocol: base.protocol,
			hostname: base.hostname,
			port: base.port || undefined,
			method: method,
			path: path,
			agent: agent,
			headers: headers(Object.assign(payload ? { "content-type": "application/json", "content-length": payload.length } : {}, extra))
		}, (res) => {
			takeCookie(res);
			if (extra && extra.accept === "*/*") {
				// a stream may go quiet (the device skips unchanged frames): no idle timeout
				req.setTimeout(0);
			}
			if (res.statusCode >= 300 && res.statusCode < 400) {
				res.resume();
				reject(httpError("NanoKVM " + path + ": redirect to " + (res.headers.location || "?") + " refused (only the configured host is used)", 502));
				return;
			}
			resolve(res);
		});
		const limit = waitMs || timeoutMs;
		req.setTimeout(limit, () => req.destroy(new Error("NanoKVM " + path + ": timeout after " + limit + " ms")));
		req.on("error", reject);
		req.end(payload || undefined);
	});

	const readBody = (res) => new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		res.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				res.destroy(new Error("response too large"));
				return;
			}
			chunks.push(c);
		});
		res.on("end", () => resolve(Buffer.concat(chunks)));
		res.on("error", reject);
	});

	const parseJson = (path, buf) => {
		try {
			return JSON.parse(buf.toString("utf8"));
		} catch (_err) {
			throw httpError("NanoKVM " + path + ": not JSON", 502);
		}
	};

	const kvm = {
		base: base,

		hasSession: () => Boolean(st.cookie),

		logins: () => st.logins,

		/**
		 * Log in (shared by concurrent callers). Rejects with the device's message
		 * (wrong password, brute-force lockout).
		 */
		login: () => {
			if (st.login) {
				return st.login;
			}
			const password = encodeURIComponent(cryptojs.encrypt(o.password || "", PASSWORD_KEY));
			st.cookie = "";
			st.login = open("POST", "/api/auth/login", { username: o.username || DEFAULT_USERNAME, password: password })
				.then((res) => readBody(res).then((buf) => ({ res: res, buf: buf })))
				.then((r) => {
					if (r.res.statusCode !== 200) {
						throw httpError("NanoKVM login: HTTP " + r.res.statusCode, 502);
					}
					const reply = parseJson("/api/auth/login", r.buf);
					if (reply.code !== 0) {
						throw httpError("NanoKVM login failed: " + (reply.msg || "code " + reply.code), 401);
					}
					// pre-2.5.1 firmware and the Pro hand the JWT back instead of setting the cookie
					if (!st.cookie && reply.data && reply.data.token && reply.data.token !== "disabled") {
						st.cookie = String(reply.data.token);
					}
					st.logins++;
					return { session: Boolean(st.cookie) };
				})
				.finally(() => {
					st.login = null;
				});
			return st.login;
		},

		/**
		 * JSON API call; logs in again once on 401. Resolves with `data`.
		 * @param {string} method
		 * @param {string} path
		 * @param {Object} [body]
		 * @param {number} [waitMs] timeout for slow calls (a long power press answers after the press)
		 */
		api: (method, path, body, waitMs) => {
			const attempt = () => open(method, path, body, undefined, waitMs).then((res) => readBody(res).then((buf) => ({ res: res, buf: buf })));
			return attempt()
				.then((r) => {
					if (r.res.statusCode !== 401) {
						return r;
					}
					return kvm.login().then(attempt);
				})
				.then((r) => {
					if (r.res.statusCode !== 200) {
						throw httpError("NanoKVM " + method + " " + path + ": HTTP " + r.res.statusCode, r.res.statusCode === 404 ? 404 : 502);
					}
					const reply = parseJson(path, r.buf);
					if (reply.code !== 0) {
						throw httpError("NanoKVM " + path + ": " + (reply.msg || "code " + reply.code), 502);
					}
					return reply.data;
				});
		},

		/**
		 * Long-lived GET (the MJPEG stream); logs in again once on 401.
		 * @returns {Promise<Object>} the response (a Readable) with status 200
		 */
		stream: (path) => {
			const attempt = () => open("GET", path, undefined, { accept: "*/*" });
			return attempt()
				.then((res) => {
					if (res.statusCode !== 401) {
						return res;
					}
					res.resume();
					return kvm.login().then(attempt);
				})
				.then((res) => {
					if (res.statusCode !== 200) {
						res.resume();
						throw httpError("NanoKVM " + path + ": HTTP " + res.statusCode, 502);
					}
					return res;
				});
		},

		/**
		 * WebSocket (the HID channel, /api/ws) with the session cookie; logs in
		 * again once when the upgrade answers 401.
		 * @returns {Promise<WebSocket>} open socket
		 */
		socket: (path) => {
			const attempt = () => new Promise((resolve, reject) => {
				const url = (secure ? "wss://" : "ws://") + base.host + path;
				const sock = new WsClient(url, {
					headers: st.cookie ? { cookie: COOKIE + "=" + st.cookie } : {},
					rejectUnauthorized: Boolean(o.verifyTls),
					followRedirects: false,
					perMessageDeflate: false,
					handshakeTimeout: timeoutMs
				});
				sock.once("open", () => resolve(sock));
				sock.once("unexpected-response", (_req, res) => {
					res.resume();
					sock.terminate();
					reject(httpError("NanoKVM " + path + ": HTTP " + res.statusCode, res.statusCode));
				});
				// errors after the first (or after open) must not go unhandled
				sock.on("error", reject);
			});
			return attempt().catch((err) => {
				if (err.status !== 401) {
					throw err;
				}
				return kvm.login().then(attempt);
			});
		},

		close: () => {
			agent.destroy();
		}
	};

	return kvm;
};

module.exports = {
	create: create,
	parseHost: parseHost,
	COOKIE: COOKIE,
	PASSWORD_KEY: PASSWORD_KEY
};
