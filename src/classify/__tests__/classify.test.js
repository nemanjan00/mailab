const fs = require("fs");
const os = require("os");
const path = require("path");
const classify = require("..");
const labModule = require("../../lab");
const web = require("../../web");
const Client = require("@modelcontextprotocol/sdk/client/index.js").Client;
const StreamableHTTPClientTransport = require("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
const LoggingMessageNotificationSchema = require("@modelcontextprotocol/sdk/types.js").LoggingMessageNotificationSchema;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("classifier", () => {
	test("normalize turns variable parts into placeholders", () => {
		expect(classify.normalize("client 3f2a1c9e-1111-4222-8333-123456789abc failed to connect to 10.0.0.7:8080 after 1.5s"))
			.toBe("client <uuid> failed to connect to <ip>:<num> after <num>s");
		expect(classify.normalize("crc mismatch at 0xdeadbeef")).toBe("crc mismatch at <hex>");
	});

	test("templates count, record numbers and absorb the backlog", () => {
		const lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-cls-")), channelCapacity: 100 });
		["temp=41C", "temp=43C", "boot ok", "temp=40C", "link down port 3"].forEach((line) => lab.log("dut", line, "uart"));
		let status = lab.classifier.status();
		expect(status.clusterCount).toBe(3);
		expect(status.unclassified[0]).toMatchObject({ signature: "temp=<num>C", count: 3 });
		lab.classifier.addTemplate({ name: "temp", pattern: "temp=<num>C" });
		// backlog absorbed
		status = lab.classifier.status();
		expect(status.templates[0]).toMatchObject({ name: "temp", count: 3 });
		expect(status.clusterCount).toBe(2);
		lab.log("dut", "temp=45C", "uart");
		expect(lab.channels.latest("cls_temp_1").v).toBe(45);
		expect(lab.channels.latest("cls_temp").v).toBe(4);
	});
});

describe("subscriptions (end to end over MCP sessions)", () => {
	let lab;
	let server;
	let client;

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-sub-")), channelCapacity: 100 });
		const created = web.create(lab, { pushIntervalMs: 50 });
		server = created.server;
		return lab.restore().then(() => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))).then(() => {
			client = new Client({ name: "test-ai", version: "1" });
			const url = new URL("http://127.0.0.1:" + server.address().port + "/mcp");
			return client.connect(new StreamableHTTPClientTransport(url));
		});
	});

	afterAll(() => {
		return client.close().then(() => {
			server.close();
			return lab.shutdown();
		});
	});

	test("subscribed events arrive as notifications; unsubscribed ones don't", () => {
		const got = [];
		client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
			got.push(n.params.data);
		});
		return client.callTool({ name: "subscribe", arguments: { types: ["match", "rule"], template: "boot" } })
			.then(() => client.callTool({ name: "classifier_add", arguments: { name: "boot", pattern: "boot <word>" } }))
			.then(() => {
				lab.log("dut", "boot ok", "uart");
				lab.log("dut", "temp=41C", "uart");
				return wait(300);
			})
			.then(() => {
				expect(got.filter((e) => e.type === "match").map((e) => e.line)).toEqual(["boot ok"]);
				return client.callTool({ name: "unsubscribe", arguments: { id: "*" } });
			})
			.then(() => {
				lab.log("dut", "boot again", "uart");
				return wait(200);
			})
			.then(() => {
				expect(got.filter((e) => e.line === "boot again")).toEqual([]);
			});
	});
});
