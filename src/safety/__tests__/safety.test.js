const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const labModule = require("../../lab");
const web = require("../../web");

const MCP = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("safety rules and approvals", () => {
	let lab;
	let app;
	let server;

	const call = (name, args) => request(app).post("/mcp").set(MCP).send({
		jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} }
	});

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-safety-")), channelCapacity: 200 });
		const created = web.create(lab, { pushIntervalMs: 50 });
		app = created.app;
		server = created.server;
		return lab.restore().then(() => lab.addDevice("sim", "sim", {
			rateHz: 100,
			signals: [{ name: "v", shape: "sine", freq: 3, amp: 1, offset: 0 }]
		}));
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	test("a rule fires its action when the condition holds", () => {
		lab.safety.addRule({ id: "hi", name: "too high", when: "sim_v > 0.9", action: { device: "sim", command: "set", args: { signal: "v", key: "amp", value: 0.1 } } });
		return wait(400).then(() => {
			const fired = lab.safety.firedLog().filter((f) => f.rule === "too high");
			expect(fired.length).toBeGreaterThan(0);
			// the action ran: amplitude is now 0.1, so the ramp stays below 0.9
			return lab.commandDevice("sim", "signals").then((signals) => {
				expect(signals[0].amp).toBe(0.1);
				expect(lab.getChat({}).some((m) => m.kind === "safety")).toBe(true);
				lab.safety.removeRule("hi", true);
			});
		});
	});

	test("for_ms keeps short spikes from firing", () => {
		lab.safety.addRule({ id: "slow", when: "sim_v > -10", for_ms: 100000, action: { device: "sim", command: "signals" } });
		return wait(300).then(() => {
			expect(lab.safety.firedLog().some((f) => f.rule === "slow")).toBe(false);
			lab.safety.removeRule("slow", true);
		});
	});

	test("silence rules use <channel>_age", () => {
		lab.pushSample("target_rx", 1);
		lab.safety.addRule({ id: "silent", name: "target silent", when: "target_rx_age > 0.2" });
		return wait(600).then(() => {
			expect(lab.safety.firedLog().some((f) => f.rule === "target silent")).toBe(true);
			lab.safety.removeRule("silent", true);
		});
	});

	test("the AI cannot remove locked rules; a person can", () => {
		lab.safety.addRule({ id: "lock", when: "sim_v > 100", locked: true });
		return call("rule_remove", { id: "lock" }).then((res) => {
			expect(res.body.result.isError).toBe(true);
			expect(res.body.result.content[0].text).toMatch(/locked/);
			return request(app).delete("/api/safety/rules/lock").expect(200);
		}).then(() => {
			expect(lab.safety.listRules().some((r) => r.id === "lock")).toBe(false);
		});
	});

	test("risky AI commands wait for approval; approve runs them, deny refuses", () => {
		lab.safety.setPolicy([{ command: "set", when: "value > 5", reason: "big amplitude" }]);
		const pendingCall = call("device_command", { id: "sim", command: "set", args: { signal: "v", key: "amp", value: 7 } });
		const decided = wait(150).then(() => {
			const pending = lab.safety.listPending();
			expect(pending.length).toBe(1);
			return request(app).post("/api/approvals/" + pending[0].id).send({ approve: true }).expect(200);
		});
		return Promise.all([pendingCall, decided]).then((results) => {
			expect(results[0].body.result.isError).toBeFalsy();
			return lab.commandDevice("sim", "signals");
		}).then((signals) => {
			expect(signals[0].amp).toBe(7);
			const denied = call("device_command", { id: "sim", command: "set", args: { signal: "v", key: "amp", value: 9 } });
			const deny = wait(150).then(() => request(app).post("/api/approvals/" + lab.safety.listPending()[0].id).send({ approve: false }));
			return Promise.all([denied, deny]);
		}).then((results) => {
			expect(results[0].body.result.isError).toBe(true);
			expect(results[0].body.result.content[0].text).toMatch(/not approved \(denied/);
			// small values don't need approval
			return call("device_command", { id: "sim", command: "set", args: { signal: "v", key: "amp", value: 1 } });
		}).then((res) => {
			expect(res.body.result.isError).toBeFalsy();
			expect(lab.safety.listPending().length).toBe(0);
		});
	});
});

describe("safety bypasses (review round 5)", () => {
	const authModule = require("../../auth");
	let lab;
	let app;
	let server;
	let dataDir;
	const AI = { authorization: "Bearer ai-token" };
	const PERSON = { authorization: "Bearer me-token" };

	const call = (name, args) => request(app).post("/mcp").set(MCP).set(AI).send({
		jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} }
	});

	const boot = () => {
		lab = labModule.create({ dataDir: dataDir, channelCapacity: 100 });
		const auth = authModule.create(authModule.parseTokens("claude:ai-token:rw,me:me-token:human"));
		const created = web.create(lab, { pushIntervalMs: 50, auth: auth });
		app = created.app;
		server = created.server;
		return lab.restore().then(() => {
			if (!lab.listDevices().length) {
				return lab.addDevice("sim", "sim", { rateHz: 20 });
			}
			return null;
		});
	};

	beforeAll(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-safety2-"));
		return boot();
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	test("an AI rule whose action needs approval waits for a person; deny = no rule", () => {
		lab.safety.setPolicy([{ command: "set", reason: "changes the signal" }]);
		const adding = call("rule_add", { name: "sneaky", when: "1", action: { device: "sim", command: "set", args: { signal: "sine", key: "amp", value: 9 } } });
		const deny = wait(150).then(() => {
			const pending = lab.safety.listPending();
			expect(pending.length).toBe(1);
			expect(pending[0].reason).toMatch(/safety rule "sneaky"/);
			return request(app).post("/api/approvals/" + pending[0].id).set(PERSON).send({ approve: false }).expect(200);
		});
		return Promise.all([adding, deny]).then((results) => {
			expect(results[0].body.result.isError).toBe(true);
			expect(lab.safety.listRules().some((r) => r.name === "sneaky")).toBe(false);
			lab.safety.setPolicy([]);
		});
	});

	test("only humans approve, edit the policy or remove locked rules", () => {
		lab.safety.setPolicy([{ command: "set", reason: "x" }]);
		// supertest requests are lazy: .then() sends it now
		const pendingCall = call("device_command", { id: "sim", command: "set", args: { signal: "sine", key: "amp", value: 2 } }).then((res) => res);
		return wait(150).then(() => {
			const id = lab.safety.listPending()[0].id;
			// the AI's own rw token can't approve its request over REST
			return request(app).post("/api/approvals/" + id).set(AI).send({ approve: true }).expect(403)
				.then(() => request(app).put("/api/safety/policy").set(AI).send({ policy: [] }).expect(403))
				.then(() => request(app).post("/api/approvals/" + id).set(PERSON).send({ approve: true }).expect(200));
		}).then(() => pendingCall).then((res) => {
			expect(res.body.result.isError).toBeFalsy();
			lab.safety.setPolicy([]);
			lab.safety.addRule({ id: "guard", when: "sim_sine > 100", locked: true });
			return request(app).delete("/api/safety/rules/guard").set(AI).expect(403);
		}).then(() => {
			expect(lab.safety.listRules().some((r) => r.id === "guard")).toBe(true);
		});
	});

	test("rule ids stay unique across restarts and locked rules can't be replaced", () => {
		return lab.shutdown().then(() => {
			server.close();
			return boot();
		}).then(() => {
			// the locked rule came back
			expect(lab.safety.listRules().find((r) => r.id === "guard")).toMatchObject({ locked: true });
			return call("rule_add", { name: "harmless", when: "sim_sine > 1000" });
		}).then((res) => {
			const added = JSON.parse(res.body.result.content[0].text);
			expect(added.id).not.toBe("guard");
			expect(() => lab.safety.addRule({ id: "guard", when: "0" })).toThrow(/locked/);
			expect(lab.safety.listRules().find((r) => r.id === "guard")).toMatchObject({ locked: true, when: "sim_sine > 100" });
		});
	});

	test("a rule that can't be evaluated alarms instead of staying silent", () => {
		lab.safety.addRule({ id: "broken", name: "broken", when: "sim_sine + [1, 2] > \"x\"" });
		return wait(400).then(() => {
			expect(lab.getChat({}).some((m) => m.kind === "safety" && /can't be evaluated/.test(m.text))).toBe(true);
			lab.safety.removeRule("broken", true);
		});
	});
});

describe("policy upgrades", () => {
	const safetyModule = require("..");
	const keyOf = (p) => [p.driver || "", p.command].join(":");

	test("new default entries reach a saved policy, removed ones stay removed", () => {
		const old = [{ command: "output", when: "on", reason: "x" }];
		const upgraded = safetyModule.withNewDefaults(old);
		expect(upgraded.map(keyOf)).toEqual(expect.arrayContaining(["flashrom:write", "minipro:erase", ":usb_power"]));
		expect(upgraded.filter((p) => p.command === "output").length).toBe(1);
		const seen = safetyModule.DEFAULT_POLICY.map((p) => [p.driver || "", p.device || "", p.command, p.when || ""].join("|"));
		const kept = safetyModule.withNewDefaults(old, seen);
		expect(kept).toEqual(old);
		expect(safetyModule.withNewDefaults(undefined).length).toBe(safetyModule.DEFAULT_POLICY.length);
	});
});
