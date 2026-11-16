const http = require("http");
const netguard = require("..");
const httpClient = require("../../../services/http");

describe("netguard", () => {
	test("address classes", () => {
		["127.0.0.1", "10.69.1.1", "192.168.1.1", "172.16.5.4", "172.31.255.255", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
			"::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "::ffff:10.0.0.1", "2001:db8::1", "198.18.0.1", "255.255.255.255"]
			.forEach((ip) => expect([ip, netguard.isPublic(ip)]).toEqual([ip, false]));
		["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]
			.forEach((ip) => expect([ip, netguard.isPublic(ip)]).toEqual([ip, true]));
		expect(netguard.isPublic("not-an-ip")).toBe(false);
	});

	test("lookup refuses names resolving inside (any address), allows public and allow-listed", (done) => {
		const fake = { "evil.example": [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }], "ok.example": [{ address: "93.184.216.34", family: 4 }], "mirror.lan": [{ address: "192.168.1.9", family: 4 }], "rebind.example": [{ address: "127.0.0.1", family: 4 }] };
		const g = netguard.create({ allow: "mirror.lan,10.0.5.0/24", resolve: (h, cb) => cb(null, fake[h]) });
		g.lookup("evil.example", {}, (err) => {
			expect(err.code).toBe("EADDRBLOCKED");
			g.lookup("rebind.example", { all: true }, (err2) => {
				expect(err2.message).toMatch(/127\.0\.0\.1/);
				g.lookup("ok.example", {}, (err3, address, family) => {
					expect([err3, address, family]).toEqual([null, "93.184.216.34", 4]);
					g.lookup("mirror.lan", { all: true }, (err4, list) => {
						expect(err4).toBeNull();
						expect(list[0].address).toBe("192.168.1.9");
						expect(() => g.check("10.0.5.7")).not.toThrow();
						expect(() => g.check("10.0.6.7")).toThrow(/not a public address/);
						expect(() => g.check("[::1]")).toThrow();
						done();
					});
				});
			});
		});
	});

	test("the real http transport never reaches a local server, directly or via redirect", () => {
		let hits = 0;
		const server = http.createServer((req, res) => {
			hits++;
			res.end("router-admin-password");
		});
		return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)).then(() => {
			const port = server.address().port;
			const init = { method: "GET", headers: {}, timeoutMs: 3000 };
			const tries = [
				"http://127.0.0.1:" + port + "/admin/config",
				"http://localhost:" + port + "/admin/config",
				"http://[::ffff:127.0.0.1]:" + port + "/",
				"http://2130706433:" + port + "/",
				"http://0x7f.1:" + port + "/"
			].map((url) => httpClient.transport(url, init).then(() => "reached " + url, (err) => err.code || err.message));
			return Promise.all(tries).then((results) => {
				results.forEach((r) => expect(r).toBe("EADDRBLOCKED"));
				expect(hits).toBe(0);
				server.close();
			});
		});
	});

	test("a redirect from an allowed host into the LAN is refused at the hop", () => {
		let internalHits = 0;
		const internal = http.createServer((req, res) => {
			internalHits++;
			res.end("secret");
		});
		const outside = http.createServer((req, res) => {
			res.writeHead(302, { location: "http://127.0.0.1:" + internal.address().port + "/admin/config" });
			res.end();
		});
		const old = process.env.MAILAB_HTTP_ALLOW;
		// 127.0.0.2 plays a public host here
		process.env.MAILAB_HTTP_ALLOW = "127.0.0.2";
		return new Promise((resolve) => internal.listen(0, "127.0.0.1", resolve))
			.then(() => new Promise((resolve) => outside.listen(0, "127.0.0.2", resolve)))
			.then(() => httpClient.transport("http://127.0.0.2:" + outside.address().port + "/datasheet.pdf", { method: "GET", headers: {}, timeoutMs: 3000 }))
			.then(() => "followed", (err) => err.code)
			.then((result) => {
				expect(result).toBe("EADDRBLOCKED");
				expect(internalHits).toBe(0);
			})
			.finally(() => {
				if (old === undefined) {
					delete process.env.MAILAB_HTTP_ALLOW;
				} else {
					process.env.MAILAB_HTTP_ALLOW = old;
				}
				internal.close();
				outside.close();
			});
	});
});
