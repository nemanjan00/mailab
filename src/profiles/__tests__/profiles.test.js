const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const labModule = require("../../lab");
const authModule = require("../../auth");
const web = require("../../web");

const MCP = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const AI = { authorization: "Bearer ai" };
const ME = { authorization: "Bearer me" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("lab profiles", () => {
	let lab;
	let app;
	let server;

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-prof-")), channelCapacity: 100 });
		const created = web.create(lab, { pushIntervalMs: 50, auth: authModule.create(authModule.parseTokens("claude:ai:rw,me:me:human")) });
		app = created.app;
		server = created.server;
		return lab.restore();
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	test("save, change everything, load: the setup comes back", () => {
		return lab.addDevice("bench", "sim", { rateHz: 10 })
			.then(() => {
				lab.defineDerived("p", "bench_sine * 2", "W");
				lab.panes.add({ id: "keep", type: "markdown", config: { content: "hello" } });
				lab.safety.addRule({ id: "g", name: "guard", when: "bench_sine > 10", locked: true });
				lab.classifier.addTemplate({ name: "temp", pattern: "temp=<num>C" });
				lab.trends.setPatterns(["bench_*"]);
				return request(app).post("/api/profiles").set(AI).send({ name: "bench-a" }).expect(200);
			})
			.then(() => lab.removeDevice("bench"))
			.then(() => {
				lab.removeDerived("p");
				lab.panes.remove("keep");
				lab.safety.removeRule("g", true);
				lab.classifier.removeTemplate("temp");
				lab.trends.setPatterns([]);
				return request(app).post("/api/profiles/bench-a/load").set(ME).expect(200);
			})
			.then(() => {
				expect(lab.listDevices().map((d) => d.id)).toEqual(["bench"]);
				expect(lab.listDerived().map((d) => d.name)).toEqual(["p"]);
				expect(lab.panes.list().some((p) => p.id === "keep")).toBe(true);
				expect(lab.safety.listRules().find((r) => r.id === "g")).toMatchObject({ locked: true });
				expect(lab.classifier.status().templates.map((t) => t.name)).toEqual(["temp"]);
				expect(lab.trends.getPatterns()).toEqual(["bench_*"]);
				return request(app).get("/api/profiles").set(AI).expect(200);
			})
			.then((res) => {
				expect(res.body[0]).toMatchObject({ name: "bench-a", devices: ["bench:sim"] });
			});
	});

	test("loading, importing and deleting are for people only", () => {
		return request(app).post("/api/profiles/bench-a/load").set(AI).expect(403)
			.then(() => request(app).post("/api/lab/import").set(AI).send(lab.exportState()).expect(403))
			.then(() => request(app).delete("/api/profiles/bench-a").set(AI).expect(403))
			.then(() => request(app).get("/api/profiles/bench-a").set(AI).expect(200));
	});

	test("the AI's lab_load waits for a person's approval", () => {
		const loading = request(app).post("/mcp").set(MCP).set(AI).send({
			jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lab_load", arguments: { name: "bench-a" } }
		}).then((res) => res);
		return wait(150).then(() => {
			const pending = lab.safety.listPending();
			expect(pending.length).toBe(1);
			expect(pending[0].reason).toMatch(/replaces the whole lab/);
			return request(app).post("/api/approvals/" + pending[0].id).set(ME).send({ approve: false });
		}).then(() => loading).then((res) => {
			expect(res.body.result.isError).toBe(true);
		});
	});

	test("profile names can't escape the profiles directory", () => {
		expect(() => lab.profiles.save("../evil")).toThrow(/profile names/);
		expect(() => lab.profiles.save(".hidden")).toThrow(/profile names/);
	});
});
