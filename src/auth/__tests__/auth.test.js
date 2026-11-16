const authModule = require("..");

const req = (headers) => {
	return { headers: Object.assign({ host: "127.0.0.1:3000" }, headers), url: "/api/state", method: "GET" };
};

const run = (auth, request, isRead) => {
	const res = { code: 200, status: (c) => { res.code = c; return res; }, json: () => res };
	let passed = false;
	auth.middleware(isRead)(request, res, () => {
		passed = true;
	});
	return passed ? 200 : res.code;
};

describe("auth with tokens", () => {
	const auth = authModule.create(authModule.parseTokens("alice:a-token:rw,viewer:v-token:ro"));

	test("inherited object keys are not tokens", () => {
		["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"].forEach((name) => {
			expect(auth.identify(req({ authorization: "Bearer " + name }))).toBeNull();
			expect(auth.identify(req({ cookie: "mailab_token=" + name }))).toBeNull();
			expect(run(auth, Object.assign(req({ authorization: "Bearer " + name }), { method: "POST" }))).toBe(401);
		});
	});

	test("empty or missing tokens are rejected", () => {
		expect(auth.identify(req({}))).toBeNull();
		expect(auth.identify(req({ authorization: "Bearer " }))).toBeNull();
	});

	test("writes need role rw exactly", () => {
		const write = (headers) => run(auth, Object.assign(req(headers), { method: "POST" }));
		expect(write({ authorization: "Bearer a-token" })).toBe(200);
		expect(write({ authorization: "Bearer v-token" })).toBe(403);
		expect(run(auth, req({ authorization: "Bearer v-token" }))).toBe(200);
	});

	test("bad token specs are refused", () => {
		expect(() => authModule.parseTokens("alice:x:admin")).toThrow(/bad MAILAB_TOKENS/);
		expect(() => authModule.parseTokens(":x:rw")).toThrow(/bad MAILAB_TOKENS/);
	});
});

describe("open mode (no tokens)", () => {
	const auth = authModule.create(new Map(), { allowedHosts: ["lab.local"] });

	test("only loopback / allowed Host headers", () => {
		expect(auth.identify(req({}))).toMatchObject({ role: "human" });
		expect(auth.identify(req({ host: "localhost:3000" }))).toBeTruthy();
		expect(auth.identify(req({ host: "lab.local:3000" }))).toBeTruthy();
		// DNS rebinding: attacker's name pointed at 127.0.0.1
		expect(auth.identify(req({ host: "evil.example:3000" }))).toBeNull();
	});

	test("cross-origin requests are refused", () => {
		expect(auth.identify(req({ origin: "http://127.0.0.1:3000" }))).toBeTruthy();
		expect(auth.identify(req({ origin: "http://evil.example" }))).toBeNull();
		expect(auth.identify(req({ origin: "null" }))).toBeNull();
	});
});

describe("exposure check", () => {
	test("non-loopback HOST without tokens is refused", () => {
		expect(() => authModule.checkExposure({ host: "0.0.0.0", tokens: new Map() })).toThrow(/without auth/);
		expect(() => authModule.checkExposure({ host: "0.0.0.0", tokens: new Map(), allowOpen: true })).not.toThrow();
		expect(() => authModule.checkExposure({ host: "0.0.0.0", tokens: authModule.parseTokens("a:b:rw") })).not.toThrow();
		expect(() => authModule.checkExposure({ host: "127.0.0.1", tokens: new Map() })).not.toThrow();
	});
});

describe("tokens in URLs", () => {
	const auth = authModule.create(authModule.parseTokens("alice:a-token:rw"));

	test("are not accepted on API requests", () => {
		expect(auth.identify({ headers: { host: "127.0.0.1:3000" }, url: "/api/state?token=a-token" })).toBeNull();
	});

	test("the login link becomes an HttpOnly cookie and a clean redirect", () => {
		const res = { cookies: [], cookie: (n, v, o) => res.cookies.push([n, v, o]), redirect: (code, to) => {
			res.redirected = [code, to];
		} };
		auth.login({ query: { token: "a-token" }, path: "/" }, res, () => {});
		expect(res.cookies[0][2]).toMatchObject({ httpOnly: true, sameSite: "strict" });
		expect(res.redirected).toEqual([302, "/"]);
	});
});
