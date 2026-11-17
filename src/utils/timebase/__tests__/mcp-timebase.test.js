// timebase_align MCP tool against a live lab: fake "instruments" are two sim
// devices whose sync_mark values are written as lab values; the tool must
// return the sample-grid offset between them.

const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const labModule = require("../../../lab");
const web = require("../../../web");

const MCP = { accept: "application/json, text/event-stream", "content-type": "application/json" };

describe("timebase_align tool", () => {
	let lab;
	let app;
	let server;

	const call = (name, args) => request(app).post("/mcp").set(MCP).send({
		jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} }
	});

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-timebase-")), channelCapacity: 200 });
		const created = web.create(lab, { pushIntervalMs: 50 });
		app = created.app;
		server = created.server;
		return lab.restore();
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	test("aligns two instruments from their sync-pulse marks", () => {
		// the same 1 MHz pulse: instrument a stamps sample 1000 @ t=1000.0,
		// instrument b (10 MHz) stamps sample 7000 @ t=1000.0
		lab.setValue("scope_a_mark", { index: 1000, t: 1000.0, rate: 1e6 }, "ai");
		lab.setValue("logic_b_mark", { index: 7000, t: 1000.0, rate: 1e7 }, "ai");
		return call("timebase_align", { a: "scope_a_mark", b: "logic_b_mark" }).then((res) => {
			expect(res.body.result.isError).toBeFalsy();
			const got = JSON.parse(res.body.result.content[0].text);
			expect(got.offsetSeconds).toBeCloseTo(0.999 - 0.9993, 12);
			expect(got.toleranceSeconds).toBe(0.02);
			expect(got.a.rate).toBe(1e6);
		});
	});

	test("refuses marks that do not exist", () => {
		return call("timebase_align", { a: "nope_mark", b: "logic_b_mark" }).then((res) => {
			expect(res.body.result.isError).toBe(true);
			expect(res.body.result.content[0].text).toMatch(/unknown value: nope_mark/);
		});
	});

	test("refuses malformed marks", () => {
		lab.setValue("bad_mark", { index: "lots", t: 1, rate: 1e6 }, "ai");
		return call("timebase_align", { a: "bad_mark", b: "logic_b_mark" }).then((res) => {
			expect(res.body.result.isError).toBe(true);
			expect(res.body.result.content[0].text).toMatch(/finite number/);
		});
	});
});
