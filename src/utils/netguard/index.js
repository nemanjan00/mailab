// Outbound-request guard against SSRF: fetches on the AI's behalf (datasheet
// links, FCC exhibits: URLs that come from scraped, untrusted pages) may only
// reach public addresses. Checked on the resolved address in the socket's DNS
// lookup, so redirects and DNS rebinding can't sneak in a LAN address; IP
// literals (which skip the lookup) are checked before connecting.
// Local mirrors: MAILAB_HTTP_ALLOW="mirror.lan,10.0.5.0/24".

const dns = require("dns");
const net = require("net");

// not reachable "on the internet": loopback, private, link-local, CGNAT,
// documentation/benchmark, multicast, reserved; IPv6 equivalents
const BLOCKED_V4 = [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
	["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
	["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
];
const BLOCKED_V6 = [
	["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64], ["2001::", 23]
];

const blocked = new net.BlockList();
BLOCKED_V4.forEach((b) => blocked.addSubnet(b[0], b[1], "ipv4"));
BLOCKED_V6.forEach((b) => blocked.addSubnet(b[0], b[1], "ipv6"));

// IPv4 hidden in IPv6: ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::/96 (NAT64)
const embeddedV4 = (ip) => {
	const lower = ip.toLowerCase();
	const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
	if (dotted) {
		return dotted[1];
	}
	const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
	if (hex) {
		const hi = parseInt(hex[1], 16);
		const lo = parseInt(hex[2], 16);
		return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
	}
	return null;
};

/**
 * @param {string} ip
 * @returns {boolean} true when the address is publicly routable
 */
const isPublic = (ip) => {
	const family = net.isIP(ip);
	if (family === 4) {
		return !blocked.check(ip, "ipv4");
	}
	if (family === 6) {
		const v4 = embeddedV4(ip);
		if (v4) {
			return isPublic(v4);
		}
		return !blocked.check(ip, "ipv6");
	}
	return false;
};

/**
 * Parse an allow-list: hostnames and CIDRs / addresses.
 * @param {string} text "mirror.lan,10.0.5.0/24,192.168.1.10"
 */
const parseAllow = (text) => {
	const hosts = new Set();
	const list = new net.BlockList();
	String(text || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((entry) => {
		const cidr = /^(.+)\/(\d+)$/.exec(entry);
		const ip = cidr ? cidr[1] : entry;
		const family = net.isIP(ip);
		if (family) {
			list.addSubnet(ip, cidr ? Number(cidr[2]) : family === 4 ? 32 : 128, family === 4 ? "ipv4" : "ipv6");
		} else {
			hosts.add(entry.toLowerCase());
		}
	});
	return {
		host: (name) => hosts.has(String(name).toLowerCase()),
		address: (ip) => {
			const family = net.isIP(ip);
			return Boolean(family) && list.check(ip, family === 4 ? "ipv4" : "ipv6");
		}
	};
};

const refusal = (host, ip) => Object.assign(new Error("refusing to connect to " + host + (ip && ip !== host ? " (" + ip + ")" : "")
	+ ": not a public address (allow local mirrors with MAILAB_HTTP_ALLOW)"), { code: "EADDRBLOCKED", status: 403 });

/**
 * @param {{allow: string, resolve: function}} [options] resolve(hostname, cb(err, [{address, family}])) for tests
 * @returns {{check: function(string), lookup: function}} check(hostname) throws for a blocked IP literal;
 *   lookup is a dns.lookup replacement for http(s).request
 */
const create = (options) => {
	const o = options || {};
	const allow = parseAllow(o.allow);
	const resolve = o.resolve || ((host, cb) => dns.lookup(host, { all: true, verbatim: true }, cb));
	const ok = (host, ip) => isPublic(ip) || allow.host(host) || allow.address(ip);

	return {
		check: (hostname) => {
			const host = String(hostname).replace(/^\[|\]$/g, "");
			if (net.isIP(host) && !ok(host, host)) {
				throw refusal(host, host);
			}
		},

		lookup: (hostname, lookupOptions, callback) => {
			const cb = typeof lookupOptions === "function" ? lookupOptions : callback;
			const opts = typeof lookupOptions === "object" && lookupOptions ? lookupOptions : {};
			resolve(hostname, (err, addresses) => {
				if (err) {
					cb(err);
					return;
				}
				const wanted = addresses.filter((a) => !opts.family || a.family === opts.family);
				// every address must pass: a name that also resolves inside is refused
				const bad = wanted.find((a) => !ok(hostname, a.address));
				if (bad) {
					cb(refusal(hostname, bad.address));
					return;
				}
				if (!wanted.length) {
					cb(Object.assign(new Error("no address for " + hostname), { code: "ENOTFOUND" }));
					return;
				}
				if (opts.all) {
					cb(null, wanted);
				} else {
					cb(null, wanted[0].address, wanted[0].family);
				}
			});
		}
	};
};

module.exports = {
	create: create,
	isPublic: isPublic,
	parseAllow: parseAllow
};
