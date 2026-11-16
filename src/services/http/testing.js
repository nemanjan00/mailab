// Test double for the http client's transport: canned responses per URL,
// no network. Used by the http, fccid and datasheets tests.

const Readable = require("stream").Readable;

/**
 * @param {Object} routes url -> {status, body (string|Buffer), headers, timeout}
 *   or a function (url, init) returning such a route
 * @returns {function} transport with .calls (every request made)
 */
const fakeTransport = (routes) => {
	const calls = [];
	const send = (url, init) => {
		calls.push({ url: url, init: init });
		const route = typeof routes === "function" ? routes(url, init) : routes[url];
		if (!route) {
			return Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
		}
		if (route.timeout) {
			return Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
		}
		const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body || "");
		const half = Math.ceil(body.length / 2);
		return Promise.resolve({
			status: route.status || 200,
			url: url,
			headers: Object.assign({ "content-type": "text/html" }, route.headers || {}),
			// two chunks, so readers handle chunked bodies
			stream: Readable.from([body.slice(0, half), body.slice(half)].filter((b) => b.length))
		});
	};
	send.calls = calls;
	return send;
};

module.exports = {
	fakeTransport: fakeTransport
};
