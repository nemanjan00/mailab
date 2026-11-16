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

// "2002::1" -> [0x2002, 0, 0, 0, 0, 0, 0, 1]; a trailing dotted quad becomes two groups
const groups = (ip) => {
	let text = ip.toLowerCase().replace(/%.*$/, "");
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
	if (dotted) {
		const b = dotted.slice(1).map(Number);
		text = text.slice(0, dotted.index) + ((b[0] << 8) | b[1]).toString(16) + ":" + ((b[2] << 8) | b[3]).toString(16);
	}
	const halves = text.split("::");
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length > 1 ? Array(8 - head.length - tail.length).fill("0") : [];
	return head.concat(fill, tail).map((g) => parseInt(g, 16));
};

const v4From = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");

// IPv4 hidden in IPv6: ::ffff:0:0/96 (mapped), ::/96 (compatible), 64:ff9b::/96 (NAT64),
// 2002::/16 (6to4: a relay would forward to the embedded IPv4 in groups 1-2)
const embeddedV4 = (ip) => {
	const g = groups(ip);
	if (g.length !== 8 || g.some((x) => Number.isNaN(x))) {
		return null;
	}
	if (g[0] === 0x2002) {
		return v4From(g[1], g[2]);
	}
	const prefix96 = g.slice(0, 6);
	const zeros = (list) => list.every((x) => x === 0);
	if ((zeros(prefix96.slice(0, 5)) && (prefix96[5] === 0xffff || prefix96[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && zeros(g.slice(2, 6)))) {
		// :: and ::1 themselves are handled by the IPv6 block list
		if (zeros(g.slice(0, 6)) && g[6] === 0) {
			return null;
		}
		return v4From(g[6], g[7]);
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
