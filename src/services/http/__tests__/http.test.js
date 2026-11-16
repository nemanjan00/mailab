const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("..");
const fakeTransport = require("../testing").fakeTransport;

describe("http client", () => {
	let dir;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-http-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("identifies itself and caches GETs on disk", () => {
		const transport = fakeTransport({ "https://example.org/a": { body: "hello" } });
		const client = http.create({ cacheDir: dir, minIntervalMs: 0, transport: transport });
		return client.text("https://example.org/a").then((r) => {
			expect(r.text).toBe("hello");
			expect(r.cached).toBe(false);
			expect(transport.calls[0].init.headers["user-agent"]).toMatch(/^mailab\//);
			// a fresh client on the same dir reads the cache
			const again = http.create({ cacheDir: dir, minIntervalMs: 0, transport: transport });
			return again.text("https://example.org/a");
		}).then((r) => {
			expect(r.text).toBe("hello");
			expect(r.cached).toBe(true);
			expect(transport.calls.length).toBe(1);
		});
	});

	test("expired cache entries are refetched", () => {
		const transport = fakeTransport({ "https://example.org/a": { body: "x" } });
		const client = http.create({ cacheDir: dir, minIntervalMs: 0, transport: transport });
		return client.get("https://example.org/a")
			.then(() => client.get("https://example.org/a", { cache: -1 }))
			.then((r) => {
				expect(r.cached).toBe(false);
				expect(transport.calls.length).toBe(2);
			});
	});

	test("HTTP errors are clear and not cached", () => {
		const transport = fakeTransport({ "https://example.org/x": { status: 403, body: "denied" } });
		const client = http.create({ name: "site", cacheDir: dir, minIntervalMs: 0, transport: transport });
		return client.get("https://example.org/x").then(() => {
			throw new Error("should fail");
		}, (err) => {
			expect(err.message).toMatch(/site: HTTP 403 from https:\/\/example.org\/x/);
			expect(err.message).toMatch(/refuses automated requests/);
			expect(err.status).toBe(502);
			expect(fs.readdirSync(dir)).toEqual([]);
		});
	});

	test("network failures and timeouts become upstream errors", () => {
		const transport = fakeTransport({ "https://slow.example.org/": { timeout: true } });
		const client = http.create({ name: "site", minIntervalMs: 0, transport: transport });
		return client.get("https://nowhere.example.org/").then(() => {
			throw new Error("should fail");
		}, (err) => {
			expect(err.message).toBe("site: cannot reach nowhere.example.org (ENOTFOUND)");
			expect(err.status).toBe(502);
			return client.get("https://slow.example.org/");
		}).then(() => {
			throw new Error("should fail");
		}, (err) => {
			expect(err.message).toMatch(/no answer from slow.example.org/);
			expect(err.status).toBe(504);
		});
	});

	test("responses over the cap are refused; peek reads only the head", () => {
		const big = "%PDF-1.4" + "x".repeat(5000);
		const transport = fakeTransport({
			"https://example.org/big": { body: big },
			"https://example.org/declared": { body: "small", headers: { "content-length": "999999" } }
		});
		const client = http.create({ minIntervalMs: 0, transport: transport });
		return client.get("https://example.org/big", { maxBytes: 1000, cache: false }).then(() => {
			throw new Error("should fail");
		}, (err) => {
			expect(err.status).toBe(413);
			return client.get("https://example.org/declared", { maxBytes: 1000, cache: false }).catch((e) => e);
		}).then((err) => {
			expect(err.status).toBe(413);
			return client.get("https://example.org/big", { peek: 8, maxBytes: 100, cache: false });
		}).then((r) => {
			expect(r.body.toString()).toBe("%PDF-1.4");
		});
	});

	test("requests to one host are spaced by minIntervalMs", () => {
		const transport = fakeTransport({ "https://example.org/1": { body: "1" }, "https://example.org/2": { body: "2" } });
		const client = http.create({ minIntervalMs: 120, transport: transport });
		const start = Date.now();
		return Promise.all([client.get("https://example.org/1", { cache: false }), client.get("https://example.org/2", { cache: false })]).then(() => {
			expect(Date.now() - start).toBeGreaterThanOrEqual(110);
		});
	});

	test("API keys are redacted from cache metadata and errors", () => {
		const url = "https://api.example.org/s?apiKey=SECRET123&q=1";
		const transport = fakeTransport({ [url]: { body: "{}" } });
		const client = http.create({ cacheDir: dir, minIntervalMs: 0, transport: transport });
		return client.get(url).then(() => {
			const metas = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
			expect(metas.join("")).not.toMatch(/SECRET123/);
			expect(metas.join("")).toMatch(/apiKey=REDACTED/);
		});
	});

	test("bad URLs are rejected", () => {
		const client = http.create({ minIntervalMs: 0, transport: fakeTransport({}) });
		return expect(client.get("not a url")).rejects.toThrow(/bad URL/);
	});
});
