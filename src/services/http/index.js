// Polite HTTP client for public web sources (FCC ID filings, datasheets):
// identifies itself, waits between requests to the same host, caps response
// sizes and keeps an on-disk cache with a TTL.
//
// Built on node:http(s) rather than fetch: Cloudflare-fronted sites (fccid.io)
// answer undici's fetch with 403 while accepting a plain request carrying the
// same honest User-Agent.

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const createHash = require("crypto").createHash;
const pkg = require("../../../package.json");
const config = require("../../config");
const netguard = require("../../utils/netguard");

const USER_AGENT = "mailab/" + pkg.version + " (hardware lab tool; low-volume lookups)";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const MAX_REDIRECTS = 5;

/**
 * Error for a failed upstream request; status 502 so REST callers see a
 * gateway problem, not a bad request.
 */
const upstreamError = (message, extra) => {
	return Object.assign(new Error(message), { status: 502 }, extra || {});
};

// API keys in query strings never reach the disk or error messages
const redact = (url) => String(url).replace(/([?&](?:api_?key|key|token|secret)=)[^&]*/gi, "$1REDACTED");

const hostOf = (url) => {
	try {
		return new URL(url).host;
	} catch (_err) {
		throw Object.assign(new Error("bad URL: " + url), { status: 400 });
	}
};

/**
 * One request with node:http(s), following redirects.
 * @param {string} url
 * @param {{method: string, headers: Object, body: (string|Buffer), timeoutMs: number}} init
 * @returns {Promise<{status: number, url: string, headers: Object, stream: Object}>}
 *   headers: lower-case names; stream: the response (a Readable)
 */
const transport = (url, init, hops) => {
	const redirects = hops || 0;
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		if (u.protocol !== "http:" && u.protocol !== "https:") {
			throw Object.assign(new Error("only http(s) URLs: " + redact(url)), { status: 400 });
		}
		// every hop (redirects included) may only reach public addresses
		const guard = netguard.create({ allow: config.get("MAILAB_HTTP_ALLOW") });
		guard.check(u.hostname);
		const lib = u.protocol === "http:" ? http : https;
		const req = lib.request(u, { method: init.method, headers: init.headers, timeout: init.timeoutMs, lookup: guard.lookup }, (res) => {
			const location = res.headers.location;
			if (res.statusCode >= 300 && res.statusCode < 400 && location && res.statusCode !== 300 && res.statusCode !== 304) {
				res.resume();
				if (redirects >= MAX_REDIRECTS) {
					reject(new Error("too many redirects"));
					return;
				}
				// 303 (and 301/302 after POST, like browsers) continue as GET
				const method = res.statusCode === 303 || (init.method === "POST" && res.statusCode !== 307 && res.statusCode !== 308) ? "GET" : init.method;
				const next = Object.assign({}, init, { method: method });
				if (method === "GET") {
					delete next.body;
				}
				resolve(transport(new URL(location, url).toString(), next, redirects + 1));
				return;
			}
			resolve({ status: res.statusCode, url: url, headers: res.headers, stream: res });
		});
		req.on("timeout", () => {
			req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
		});
		req.on("error", reject);
		if (init.body) {
			req.end(init.body);
		} else {
			req.end();
		}
	});
};

/**
 * Read a response stream, failing once it passes maxBytes. With peek, stop
 * quietly after that many bytes instead (sniffing a file's magic).
 */
const readCapped = (response, maxBytes, url, peek) => {
	const stream = response.stream;
	const declared = Number(response.headers["content-length"]);
	if (declared && declared > maxBytes && !peek) {
		stream.destroy();
		return Promise.reject(upstreamError(redact(url) + " is " + declared + " bytes, over the " + maxBytes + " byte cap", { status: 413 }));
	}
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		let done = false;
		const finish = (err, value) => {
			if (done) {
				return;
			}
			done = true;
			if (err) {
				reject(err);
			} else {
				resolve(value);
			}
		};
		stream.on("data", (chunk) => {
			if (done) {
				return;
			}
			chunks.push(chunk);
			total += chunk.length;
			if (peek && total >= peek) {
				finish(null, Buffer.concat(chunks, total).slice(0, peek));
				stream.destroy();
				return;
			}
			if (total > maxBytes) {
				finish(upstreamError(redact(url) + " is over the " + maxBytes + " byte cap", { status: 413 }));
				stream.destroy();
			}
		});
		stream.on("end", () => finish(null, Buffer.concat(chunks, total)));
		stream.on("error", (err) => finish(upstreamError("read failed: " + err.message)));
		// destroyed without end/error (e.g. aborted)
		stream.on("close", () => finish(null, Buffer.concat(chunks, total)));
	});
};

/**
 * @param {Object} [options]
 * @param {string} [options.name] label used in error messages (e.g. "fccid.io")
 * @param {string} [options.cacheDir] on-disk cache directory (no cache when empty)
 * @param {number} [options.ttlMs] default cache lifetime
 * @param {number} [options.minIntervalMs] gap between requests to one host
 * @param {number} [options.timeoutMs]
 * @param {function} [options.transport] (url, init) → Promise<{status, url, headers, stream}> (tests)
 */
const create = (options) => {
	const opts = options || {};
	const name = opts.name || "web";
	const minInterval = opts.minIntervalMs === undefined ? DEFAULT_MIN_INTERVAL_MS : opts.minIntervalMs;
	const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
	// host -> promise of the last request's finish time, so requests queue per host
	const slots = {};

	// wrapper: one request at a time per host, minInterval apart
	const throttled = (url, task) => {
		const host = hostOf(url);
		const previous = slots[host] || Promise.resolve(0);
		const run = previous.then((lastAt) => {
			const wait = Math.max(0, lastAt + minInterval - Date.now());
			return new Promise((resolve) => setTimeout(resolve, wait)).then(task);
		});
		slots[host] = run.then(() => Date.now(), () => Date.now());
		return run;
	};

	const cacheFile = (key) => {
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 40);
		return path.join(opts.cacheDir, hash);
	};

	const readCache = (key, ttlMs) => {
		if (!opts.cacheDir) {
			return null;
		}
		const file = cacheFile(key);
		try {
			const meta = JSON.parse(fs.readFileSync(file + ".json", "utf8"));
			if (Date.now() - meta.t > ttlMs) {
				return null;
			}
			return Object.assign({}, meta, { body: fs.readFileSync(file + ".bin"), cached: true });
		} catch (_err) {
			return null;
		}
	};

	const writeCache = (key, result) => {
		if (!opts.cacheDir) {
			return;
		}
		try {
			fs.mkdirSync(opts.cacheDir, { recursive: true });
			const file = cacheFile(key);
			fs.writeFileSync(file + ".bin", result.body);
			fs.writeFileSync(file + ".json", JSON.stringify({ url: redact(result.url), status: result.status, contentType: result.contentType, t: Date.now() }));
		} catch (err) {
			// a cache that can't be written only costs a refetch
			console.error("http cache: " + err.message);
		}
	};

	/**
	 * Fetch a URL.
	 * @param {string} url
	 * @param {Object} [request]
	 * @param {string} [request.method]
	 * @param {Object} [request.headers]
	 * @param {string|Buffer} [request.body]
	 * @param {number} [request.maxBytes]
	 * @param {boolean|number} [request.cache] false = bypass, number = TTL in ms
	 * @param {number[]} [request.accept] statuses treated as success (default 200-299)
	 * @param {string} [request.range] e.g. "bytes=0-1023"
	 * @param {number} [request.peek] read only the first N bytes
	 * @returns {Promise<{url: string, status: number, contentType: string, body: Buffer, cached: boolean}>}
	 */
	const request = (url, request) => {
		const req = request || {};
		const method = req.method || "GET";
		const maxBytes = req.maxBytes || DEFAULT_MAX_BYTES;
		// GETs are cached by default; other methods only when asked (search APIs)
		const useCache = req.cache !== false && (method === "GET" || req.cache !== undefined);
		const ttlMs = typeof req.cache === "number" ? req.cache : (opts.ttlMs || DEFAULT_TTL_MS);
		const key = [method, url, req.range || "", req.peek || "", req.body ? createHash("sha256").update(req.body).digest("hex") : ""].join(" ");
		const accepted = (status) => {
			if (req.accept) {
				return req.accept.indexOf(status) !== -1;
			}
			return status >= 200 && status < 300;
		};
		try {
			hostOf(url);
		} catch (err) {
			return Promise.reject(err);
		}
		const hit = useCache ? readCache(key, ttlMs) : null;
		if (hit) {
			return Promise.resolve(hit);
		}
		const headers = Object.assign({ "user-agent": USER_AGENT, accept: "*/*" }, req.headers || {});
		if (req.range) {
			headers.range = req.range;
		}
		if (req.body) {
			headers["content-length"] = Buffer.byteLength(req.body);
		}
		const send = opts.transport || transport;
		return throttled(url, () => {
			return send(url, { method: method, headers: headers, body: req.body, timeoutMs: timeoutMs })
				.catch((err) => {
					if (err.name === "TimeoutError") {
						throw upstreamError(name + ": no answer from " + hostOf(url) + " within " + Math.round(timeoutMs / 1000) + " s", { status: 504 });
					}
					throw upstreamError(name + ": cannot reach " + hostOf(url) + " (" + (err.code || err.message) + ")");
				})
				.then((response) => {
					if (!accepted(response.status)) {
						response.stream.resume();
						let hint = "";
						if (response.status === 403 || response.status === 429) {
							hint = " (the site refuses automated requests or rate-limited us; try again later or open it in a browser)";
						}
						throw upstreamError(name + ": HTTP " + response.status + " from " + redact(url) + hint, { upstreamStatus: response.status });
					}
					return readCapped(response, maxBytes, url, req.peek).then((body) => {
						return {
							url: response.url || url,
							status: response.status,
							contentType: response.headers["content-type"] || "",
							body: body,
							cached: false
						};
					});
				});
		}).then((result) => {
			if (useCache) {
				writeCache(key, result);
			}
			return result;
		});
	};

	return {
		request: request,
		get: (url, req) => request(url, Object.assign({}, req, { method: "GET" })),
		text: (url, req) => request(url, req).then((r) => Object.assign({}, r, { text: r.body.toString("utf8") }))
	};
};

module.exports = {
	create: create,
	transport: transport,
	USER_AGENT: USER_AGENT
};
