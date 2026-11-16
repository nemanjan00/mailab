const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const labModule = require("../../lab");
const web = require("..");

const MCP_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };

const call = (app, name, args) => {
	return request(app).post("/mcp").set(MCP_HEADERS).send({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: name, arguments: args || {} }
	});
};

describe("web + mcp", () => {
	let lab;
	let app;
	let server;

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-")), channelCapacity: 1000 });
		const created = web.create(lab, { pushIntervalMs: 50 });
		app = created.app;
		server = created.server;
		return lab.restore();
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	test("state lists default panes", () => {
		return request(app).get("/api/state").expect(200).then((res) => {
			expect(res.body.panes.length).toBeGreaterThan(0);
			expect(Object.keys(res.body.paneTypes)).toContain("chart");
		});
	});

	test("mcp lists tools", () => {
		return request(app).post("/mcp").set(MCP_HEADERS).send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).then((res) => {
			const names = res.body.result.tools.map((t) => t.name);
			expect(names).toEqual(expect.arrayContaining(["device_add", "math_eval", "pane_add", "note"]));
		});
	});

	test("ai writes a channel, evaluates math and the activity is recorded", () => {
		return call(app, "channel_write", { name: "test_v", values: [1, 2, 3], unit: "V" })
			.then(() => {
				return call(app, "math_eval", { expression: "mean(test_v)" });
			})
			.then((res) => {
				expect(JSON.parse(res.body.result.content[0].text).value).toBe(2);
				return request(app).get("/api/activity");
			})
			.then((res) => {
				expect(res.body.map((a) => a.tool)).toEqual(["channel_write", "math_eval"]);
			});
	});

	test("tool errors come back as isError", () => {
		return call(app, "device_add", { id: "x", driver: "nope" }).then((res) => {
			expect(res.body.result.isError).toBe(true);
			expect(res.body.result.content[0].text).toMatch(/unknown driver/);
		});
	});

	test("several instances of one driver get their own ids and channels", () => {
		return request(app).post("/api/devices").send({ driver: "sim", options: { rateHz: 100 } }).expect(200)
			.then((res) => {
				expect(res.body.id).toBe("sim");
				return request(app).post("/api/devices").send({ driver: "sim", options: { rateHz: 100 } }).expect(200);
			})
			.then((res) => {
				expect(res.body.id).toBe("sim2");
				return new Promise((resolve) => {
					setTimeout(resolve, 100);
				});
			})
			.then(() => {
				const names = lab.channels.list().map((c) => c.name);
				expect(names).toEqual(expect.arrayContaining(["sim_sine", "sim2_sine"]));
				return Promise.all([lab.removeDevice("sim"), lab.removeDevice("sim2")]);
			});
	});

	test("sim device feeds channels; derived channel follows", () => {
		return request(app).post("/api/devices").send({ id: "sim", driver: "sim", options: { rateHz: 200 } }).expect(200)
			.then(() => {
				return request(app).post("/api/derived").send({ name: "sq", expression: "sim_sine ^ 2" }).expect(200);
			})
			.then(() => {
				return new Promise((resolve) => {
					setTimeout(resolve, 200);
				});
			})
			.then(() => {
				return request(app).get("/api/channels/sq");
			})
			.then((res) => {
				expect(res.body.v.length).toBeGreaterThan(5);
				res.body.v.forEach((v) => {
					expect(v).toBeGreaterThanOrEqual(0);
				});
			});
	});
});
