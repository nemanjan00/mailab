const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const labModule = require("../../lab");
const authModule = require("../../auth");
const web = require("..");

const MCP_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };

describe("collaboration: tokens, roles, sessions, chat", () => {
	let lab;
	let app;
	let server;

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-collab-")), channelCapacity: 100 });
		const auth = authModule.create(authModule.parseTokens("alice:a-token:rw,viewer:v-token:ro"));
		const created = web.create(lab, { pushIntervalMs: 50, auth: auth });
		app = created.app;
		server = created.server;
		return lab.restore();
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	test("rejects requests without a valid token", () => {
		return request(app).get("/api/state").expect(401)
			.then(() => {
				return request(app).get("/api/state").set("authorization", "Bearer nope").expect(401);
			})
			.then(() => {
				return request(app).get("/api/state").set("authorization", "Bearer a-token").expect(200);
			});
	});

	test("read-only tokens can read and chat, not change the lab", () => {
		const ro = { authorization: "Bearer v-token" };
		return request(app).post("/api/panes").set(ro).send({ type: "chat" }).expect(403)
			.then(() => {
				return request(app).post("/api/chat").set(ro).send({ text: "looks good" }).expect(200);
			})
			.then((res) => {
				// the server-side identity wins over a claimed name
				expect(res.body.from).toBe("viewer");
				return request(app).post("/mcp").set(ro).set(MCP_HEADERS).send({
					jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "device_add", arguments: { driver: "sim" } }
				});
			})
			.then((res) => {
				expect(res.body.result.isError).toBe(true);
				expect(res.body.result.content[0].text).toMatch(/read-only/);
			});
	});

	test("MCP sessions know the collaborator and client name", () => {
		const rw = Object.assign({ authorization: "Bearer a-token" }, MCP_HEADERS);
		let sessionId;
		return request(app).post("/mcp").set(rw).send({
			jsonrpc: "2.0", id: 1, method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } }
		}).then((res) => {
			sessionId = res.headers["mcp-session-id"];
			expect(sessionId).toBeTruthy();
			return request(app).post("/mcp").set(rw).set("mcp-session-id", sessionId).send({ jsonrpc: "2.0", method: "notifications/initialized" });
		}).then(() => {
			return request(app).post("/mcp").set(rw).set("mcp-session-id", sessionId).send({
				jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chat_send", arguments: { text: "hello from the AI" } }
			});
		}).then((res) => {
			expect(res.body.result.isError).toBeFalsy();
			const last = lab.getChat({}).slice(-1)[0];
			expect(last).toMatchObject({ from: "alice/test-client", kind: "ai", text: "hello from the AI" });
			const activity = lab.getActivity().slice(-1)[0];
			expect(activity.who).toBe("alice/test-client");
		});
	});
});
