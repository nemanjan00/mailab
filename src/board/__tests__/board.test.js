const fs = require("fs");
const os = require("os");
const path = require("path");
const execFileSync = require("child_process").execFileSync;
const request = require("supertest");
const boardModule = require("..");
const fixtures = require("../__fixtures__");
const labModule = require("../../lab");
const authModule = require("../../auth");
const web = require("../../web");

const has = (cmd, arg) => {
	try {
		execFileSync(cmd, [arg || "-v"], { stdio: "ignore" });
		return true;
	} catch (err) {
		return err.code !== "ENOENT";
	}
};
const POPPLER = has("pdftotext") && has("pdftoppm") && has("pdfinfo");
const MAGICK = has("magick", "-version");
const withPoppler = POPPLER ? test : test.skip;
const withBoth = POPPLER && MAGICK ? test : test.skip;

const MCP = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const AI = { authorization: "Bearer ai" };
const ME = { authorization: "Bearer me" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mailab-board-"));

const SCHEMATIC = fixtures.makePdf({
	width: 400, height: 200,
	words: [{ text: "R101", x: 50, y: 60 }, { text: "C7", x: 200, y: 60 }, { text: "VBAT", x: 300, y: 150 }],
	lines: [[60, 70, 210, 70], [210, 70, 300, 140]]
});

describe("boards", () => {
	test("names are validated like profiles", () => {
		const boards = boardModule.create(tmp());
		expect(() => boards.create("../evil")).toThrow(/board names/);
		expect(() => boards.create(".hidden")).toThrow(/board names/);
		expect(() => boards.create("a/b")).toThrow(/board names/);
		boards.create("ok-1.x");
		expect(() => boards.create("ok-1.x")).toThrow(/exists/);
	});

	test("page lists", () => {
		expect(boardModule.parsePages("1-3,5,2", 9)).toEqual([1, 2, 3, 5]);
		expect(boardModule.parsePages("", 3)).toEqual([1, 2, 3]);
		expect(() => boardModule.parsePages("4", 3)).toThrow(/out of range/);
		expect(() => boardModule.parsePages("x", 3)).toThrow(/pages/);
	});

	test("draw ops are atomic and persist across instances", () => {
		const dir = tmp();
		const changed = [];
		const boards = boardModule.create(dir, { onChange: (n) => changed.push(n) });
		boards.create("amp");
		boards.draw("amp", [
			{ op: "add", kind: "component", id: "R1", value: "1k", box: [0, 0, 10, 4], pins: [{ name: "1", x: 0, y: 2 }, { name: "2", x: 10, y: 2 }] },
			{ op: "add", kind: "component", id: "Q1", side: "top" },
			{ op: "add", kind: "pin", component: "Q1", name: "B", x: 30, y: 2 },
			{ op: "add", kind: "wire", points: [[10, 2], [30, 2]], side: "top" },
			{ op: "add", kind: "testpoint", id: "TPB", x: 20, y: 2, channel: "dmm_v" }
		]);
		expect(changed).toContain("amp");
		// one bad op rolls the whole batch back
		expect(() => boards.draw("amp", [
			{ op: "add", kind: "via", x: 1, y: 1 },
			{ op: "add", kind: "wire", points: [[0, 0]] }
		])).toThrow(/op 1 \(add wire\): points/);
		expect(boards.get("amp").vias).toEqual([]);
		expect(() => boards.draw("amp", [{ op: "add", kind: "component", id: "R1" }])).toThrow(/exists/);
		expect(() => boards.draw("amp", [{ op: "add", kind: "pin", component: "R1", name: "1", x: 0, y: 0 }])).toThrow(/pin exists/);

		const again = boardModule.create(dir);
		expect(again.query("amp", { what: "pin", pin: "R1.2" })).toMatchObject({ net: "Net-(Q1.B)", connected: ["Q1.B"], testpoints: ["TPB"] });
		again.draw("amp", [{ op: "update", kind: "component", id: "Q1", rename: "Q2", value: "BC547" }, { op: "remove", kind: "testpoint", id: "TPB" }]);
		expect(again.query("amp", { what: "neighbors", ref: "R1" }).neighbors).toEqual(["Q2"]);
		expect(again.netlist("amp", "csv")).toBe("net,ref,pin\nNet-(Q2.B),Q2,B\nNet-(Q2.B),R1,2\n");
		expect(() => again.netlist("amp", "xml")).toThrow(/format/);
		expect(again.list()[0]).toMatchObject({ name: "amp", components: 2, wires: 1 });
		again.remove("amp");
		expect(fs.existsSync(path.join(dir, "amp.json"))).toBe(false);
		expect(() => again.get("amp")).toThrow(/unknown board/);
	});

	test("image layers: alignment from point pairs and layer updates", () => {
		const boards = boardModule.create(tmp());
		return boards.importData("photo", fixtures.makePng(40, 20), { label: "top", side: "top" }).then((layers) => {
			expect(layers[0]).toMatchObject({ kind: "image", width: 40, height: 20, side: "top", matrix: [1, 0, 0, 1, 0, 0] });
			const id = layers[0].id;
			const aligned = boards.alignLayer("photo", id, [{ from: [0, 0], to: [100, 100] }, { from: [40, 0], to: [100, 180] }]);
			// 90° rotation, scale 2
			expect(aligned.matrix.map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 2, -2, 0, 100, 100]);
			const moved = boards.updateLayer("photo", id, { opacity: 3, visible: false, params: { x: 5 } });
			expect(moved).toMatchObject({ opacity: 1, visible: false });
			expect(moved.matrix[4]).toBe(5);
			expect(() => boards.updateLayer("photo", id, { matrix: [0, 0, 0, 0, 0, 0] })).toThrow(/invertible/);
			expect(() => boards.importData("photo", Buffer.from("nope"))).toThrow(/not a PDF/);
			boards.removeLayer("photo", id);
			expect(boards.get("photo").layers).toEqual([]);
		});
	});

	withPoppler("PDF import: pages become layers, text is searchable in board units", () => {
		const boards = boardModule.create(tmp());
		return boards.importData("sch", SCHEMATIC, { dpi: 72, label: "synthetic" }).then((layers) => {
			expect(layers).toHaveLength(1);
			expect(layers[0]).toMatchObject({ kind: "pdf", width: 400, height: 200, dpi: 72, name: "synthetic p1", source: { page: 1 } });
			const hit = boards.search("sch", "r10");
			expect(hit.text.map((t) => t.text)).toEqual(["R101"]);
			expect(hit.text[0].x).toBeCloseTo(50, 0);
			expect(boards.search("sch", "C7", { exact: true }).text).toHaveLength(1);
			expect(boards.search("sch", "^V.A", { regex: true }).text.map((t) => t.text)).toEqual(["VBAT"]);
			// a second page imported at another dpi starts at the same scale as the first
			return boards.importData("sch", SCHEMATIC, { dpi: 144 }).then((more) => {
				expect(more[0].matrix).toEqual([0.5, 0, 0, 0.5, 0, 0]);
				const words = boards.text("sch", { layer: more[0].id, region: { x: 190, y: 40, w: 40, h: 30 } });
				expect(words.map((w) => w.text)).toEqual(["C7"]);
				return expect(boards.importData("sch", SCHEMATIC, { pages: "2" })).rejects.toThrow(/out of range/);
			});
		});
	});

	withBoth("view: a sharp crop of a PDF region with the tracing drawn on top", () => {
		const boards = boardModule.create(tmp());
		return boards.importData("v", SCHEMATIC, { dpi: 72 }).then(() => {
			boards.draw("v", [{ op: "add", kind: "wire", points: [[60, 70], [210, 70]] }]);
			return boards.view("v", { x: 40, y: 40, w: 200, h: 50, maxPx: 800 });
		}).then((v) => {
			expect(v.png.readUInt32BE(0)).toBe(0x89504e47);
			expect(v.width).toBe(800);
			expect(v.height).toBe(200);
			// image px → board units
			expect(v.toBoard[0]).toBeCloseTo(0.25);
			expect(v.toBoard[4]).toBeCloseTo(40);
		});
	});
});

describe("boards over REST and MCP", () => {
	let lab;
	let app;
	let server;
	const dataDir = tmp();

	beforeAll(() => {
		lab = labModule.create({ dataDir: dataDir, channelCapacity: 100 });
		const created = web.create(lab, { pushIntervalMs: 50, auth: authModule.create(authModule.parseTokens("claude:ai:rw,me:me:human")) });
		app = created.app;
		server = created.server;
		return lab.restore();
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	const call = (name, args) => request(app).post("/mcp").set(MCP).set(AI).send({
		jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args }
	}).then((res) => res.body.result);
	const parsed = (result) => JSON.parse(result.content[result.content.length - 1].text);

	test("the AI traces, queries the graph and exports a netlist; boards live outside lab.json", () => {
		return request(app).post("/api/boards").set(AI).send({ name: "ai" }).expect(200)
			.then(() => call("board_draw", { name: "ai", ops: [
				{ op: "add", kind: "component", id: "U1", pins: [{ name: "1", x: 0, y: 0 }, { name: "2", x: 0, y: 10 }] },
				{ op: "add", kind: "component", id: "R5", pins: [{ name: "1", x: 50, y: 0 }] },
				{ op: "add", kind: "wire", points: [[0, 0], [25, 0], [50, 0]] },
				{ op: "add", kind: "label", x: 25, y: 0, name: "SDA" }
			] }))
			.then((r) => {
				expect(r.isError).toBeFalsy();
				return call("board_graph", { name: "ai", what: "net", net: "SDA" });
			})
			.then((r) => {
				expect(parsed(r).pins).toEqual(["R5.1", "U1.1"]);
				return call("board_netlist", { name: "ai", format: "kicad" });
			})
			.then((r) => {
				expect(parsed(r).text).toContain("(node (ref \"U1\") (pin \"1\"))");
				return call("board_search", { name: "ai", query: "sda" });
			})
			.then((r) => {
				expect(parsed(r).nets).toEqual(["SDA"]);
				expect(fs.existsSync(path.join(dataDir, "boards", "ai.json"))).toBe(true);
				return request(app).get("/api/boards/ai/netlist?format=csv").set(AI).expect(200);
			})
			.then((res) => {
				expect(res.text).toBe("net,ref,pin\nSDA,R5,1\nSDA,U1,1\n");
			});
	});

	test("uploading a layer over REST", () => {
		return request(app).put("/api/boards/up/upload?label=photo&side=bottom").set(AI).set("content-type", "application/octet-stream")
			.send(fixtures.makePng(8, 6)).expect(200)
			.then((res) => {
				expect(res.body.layers).toHaveLength(1);
				return request(app).get("/api/boards/up/layers/" + res.body.layers[0] + "/image").set(AI).expect(200);
			})
			.then((res) => {
				expect(res.headers["content-type"]).toMatch(/image\/png/);
			});
	});

	test("deleting a board is for people on REST and needs approval over MCP", () => {
		return request(app).delete("/api/boards/ai").set(AI).expect(403)
			.then(() => {
				const deleting = call("board_delete", { name: "ai" });
				return wait(150).then(() => {
					const pending = lab.safety.listPending();
					expect(pending.length).toBe(1);
					expect(pending[0].reason).toMatch(/deletes board "ai"/);
					return request(app).post("/api/approvals/" + pending[0].id).set(ME).send({ approve: false });
				}).then(() => deleting);
			})
			.then((r) => {
				expect(r.isError).toBe(true);
				expect(lab.boards.exists("ai")).toBe(true);
				return request(app).delete("/api/boards/ai").set(ME).expect(200);
			})
			.then(() => {
				expect(lab.boards.exists("ai")).toBe(false);
			});
	});
});
