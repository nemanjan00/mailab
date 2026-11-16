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
	}).then((res) => {
		const r = res.body.result;
		if (r.isError) {
			throw new Error(r.content[0].text);
		}
		return JSON.parse(r.content[0].text);
	});
};

// supertest: collect a binary body as a Buffer
const binary = (res, done) => {
	const chunks = [];
	res.on("data", (c) => chunks.push(c));
	res.on("end", () => done(null, Buffer.concat(chunks)));
};

describe("hex editor REST + MCP", () => {
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

	test("range reads bytes with the blob size in a header", () => {
		lab.setBlob("fw", Buffer.from("0123456789abcdef"));
		return request(app).get("/api/blobs/fw/range?offset=4&length=4").buffer(true).parse(binary).expect(200).then((res) => {
			expect(res.body.toString()).toBe("4567");
			expect(res.headers["x-blob-size"]).toBe("16");
			return request(app).get("/api/blobs/none/range").expect(404);
		});
	});

	test("PATCH applies ops and returns undo; search, checksum, change", () => {
		lab.setBlob("fw", Buffer.from("0123456789abcdef"));
		lab.setBlob("fw0", Buffer.from("0123456789abcdef"));
		return request(app).patch("/api/blobs/fw").send({ ops: [{ op: "poke", offset: 0, hex: "41" }, { op: "insert", offset: 1, hex: "42" }] }).expect(200)
			.then((res) => {
				expect(res.body.size).toBe(17);
				expect(lab.getBlob("fw").data.toString()).toBe("AB123456789abcdef");
				return request(app).get("/api/blobs/fw/search?text=789&dir=next&from=0").expect(200);
			})
			.then((res) => {
				expect(res.body.hits).toEqual([{ offset: 8, length: 3 }]);
				return request(app).get("/api/blobs/fw/checksum?offset=2&length=9&algorithms=crc32,sum8").expect(200);
			})
			.then((res) => {
				expect(res.body.results.crc32.hex).toBe("0xCBF43926");
				return request(app).get("/api/blobs/fw0/change/fw?from=0").expect(200);
			})
			.then((res) => {
				expect(res.body.change.start).toBe(0);
				return request(app).patch("/api/blobs/fw").send({ ops: [{ op: "bogus", offset: 0 }] }).expect(400);
			})
			.then(() => request(app).get("/api/checksums").expect(200))
			.then((res) => {
				expect(res.body.map((c) => c.name)).toContain("crc16-xmodem");
			});
	});

	test("MCP peek / poke / patch / search / replace / checksum / slice", () => {
		lab.setBlob("dump", Buffer.from("00112233445566778899aabbccddeeff", "hex"));
		return call(app, "blob_peek", { name: "dump", offset: 0, length: 4, as: "u16be" })
			.then((r) => {
				expect(r.value).toEqual([0x0011, 0x2233]);
				return call(app, "blob_poke", { name: "dump", offset: 0, value: "0xbeef", type: "u16le" });
			})
			.then((r) => {
				expect(r.written).toBe("efbe");
				return call(app, "blob_patch", { name: "dump", ops: [{ op: "fill", offset: 2, length: 2, hex: "ff" }] });
			})
			.then((r) => {
				expect(r.undo).toEqual([{ op: "poke", offset: 2, base64: Buffer.from([0x22, 0x33]).toString("base64") }]);
				return call(app, "blob_search", { name: "dump", hex: "ff ?? 44" });
			})
			.then((r) => {
				expect(r.hits).toEqual([{ offset: 2, length: 3 }]);
				return call(app, "blob_replace", { name: "dump", find: "ccdd", replace: { text: "CD!" }, all: true });
			})
			.then((r) => {
				expect(r.replaced).toBe(1);
				expect(lab.getBlob("dump").data.subarray(12, 15).toString()).toBe("CD!");
				return call(app, "blob_checksum", { name: "dump", algorithms: ["md5"] });
			})
			.then((r) => {
				expect(r.results.md5.hex).toMatch(/^[0-9a-f]{32}$/);
				return call(app, "blob_slice", { name: "dump", offset: 0, length: 2, to: "head" });
			})
			.then(() => {
				expect(lab.getBlob("head").data.toString("hex")).toBe("efbe");
				return call(app, "blob_read", { name: "head" });
			})
			.then((r) => {
				expect(r.hex).toBe("efbe");
				return call(app, "blob_diff", { a: "dump", b: "head" });
			})
			.then((r) => {
				expect(r.changedBytes).toBeGreaterThan(0);
			});
	});
});
