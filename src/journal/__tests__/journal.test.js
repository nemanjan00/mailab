// Experiment journal: evidence-tagged notes (the mdp-p906 convention,
// enforced), run records (device options + setpoints + data), markdown
// export, persistence across lab restarts, and the MCP tools.

const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const labModule = require("../../lab");
const web = require("../../web");

const MCP = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("experiment journal", () => {
	let lab;
	let app;
	let server;
	let dataDir;

	const call = (name, args) => request(app).post("/mcp").set(MCP).send({
		jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} }
	});

	beforeAll(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-journal-"));
		lab = labModule.create({ dataDir: dataDir, channelCapacity: 200 });
		const created = web.create(lab, { pushIntervalMs: 50 });
		app = created.app;
		server = created.server;
		return lab.restore().then(() => lab.addDevice("sim", "sim", {
			rateHz: 100,
			signals: [{ name: "v", shape: "sine", freq: 3, amp: 1, offset: 0 }]
		})).then(() => wait(400)); // let the sim publish its first sample (sim_v channel)
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	test("a note linking real data is tagged [HW]; the tag is computed, not chosen", () => {
		const note = lab.journal.addNote({ text: "output follows input", links: ["sim_v"], who: "ai" });
		expect(note.tags).toEqual(["HW"]);
		expect(note.links).toEqual(["sim_v"]);
		expect(note.linkKinds.sim_v).toBe("channel");
	});

	test("a note with nothing behind it is tagged [INF]", () => {
		const note = lab.journal.addNote({ text: "the cause is probably the flux capacitor" });
		expect(note.tags).toEqual(["INF"]);
		expect(note.links).toEqual([]);
	});

	test("unresolvable links are reported and do not count as evidence", () => {
		const note = lab.journal.addNote({ text: "claims without data", links: ["nope_nothing_here"] });
		expect(note.tags).toEqual(["INF"]);
		expect(note.unresolved).toEqual(["nope_nothing_here"]);
	});

	test("a note with one real and one fake link is still [HW] and reports the fake", () => {
		const note = lab.journal.addNote({ text: "mostly backed", links: ["sim_v", "missing"] });
		expect(note.tags).toEqual(["HW"]);
		expect(note.unresolved).toEqual(["missing"]);
	});

	test("recordRun stores devices, setpoints and the data created during the run", () => {
		const snap = lab.journal.snapshot();
		return wait(50).then(() => {
			lab.recordActivity({ who: "ai", tool: "device_command", args: "sim.set {amp: 1}", ok: true });
			lab.pushSample("run_out", 1.5, { source: "test" });
			return lab.journal.recordRun("cap-test", snap, () => Promise.resolve({ ok: true }));
		}).then((run) => {
			expect(run.ok).toBe(true);
			expect(run.devices.some((d) => d.id === "sim" && d.driver === "sim")).toBe(true);
			expect(run.setpoints.some((s) => /device_command/.test(s.tool))).toBe(true);
			expect(run.data.some((d) => d.name === "run_out" && d.kind === "channel")).toBe(true);
			expect(run.data.some((d) => d.name === "sim_v")).toBe(false); // existed before
		});
	});

	test("run markdown export includes devices, setpoints, data and linked notes", () => {
		lab.journal.addNote({ text: "run_out looks clean", links: ["run_out", "cap-test"] });
		const md = lab.journal.exportRun("cap-test");
		expect(md).toMatch(/# Run "cap-test"/);
		expect(md).toMatch(/\| sim \| sim \|/);
		expect(md).toMatch(/run_out \(channel\)/);
		expect(md).toMatch(/\[HW\] run_out looks clean/);
	});

	test("journal MCP tools: note, list, export", () => {
		return call("journal_note", { text: "MCP-added conclusion", links: ["sim_v"] }).then((res) => {
			expect(res.body.result.isError).toBeFalsy();
			const note = JSON.parse(res.body.result.content[0].text);
			expect(note.tags).toEqual(["HW"]);
			return call("journal_list", {});
		}).then((res) => {
			const got = JSON.parse(res.body.result.content[0].text);
			expect(got.notes.some((n) => n.text === "MCP-added conclusion")).toBe(true);
			expect(got.runs.some((r) => r.name === "cap-test")).toBe(true);
			return call("journal_export", { name: "cap-test" });
		}).then((res) => {
			const got = JSON.parse(res.body.result.content[0].text);
			expect(got.markdown).toMatch(/# Run "cap-test"/);
		});
	});

	test("a batch run is recorded as a journal run with its setpoints", () => {
		return call("batch", { steps: [
			{ tool: "device_command", args: { id: "sim", command: "signals" }, name: "sig" },
			{ tool: "value_write", args: { name: "batch_result", value: "$sig" }, delayMs: 20 }
		] }).then((res) => {
			expect(res.body.result.isError).toBeFalsy();
			return wait(300); // recordRun resolves alongside; give it a beat
		}).then(() => {
			const run = lab.journal.runs().find((r) => /^batch-/.test(r.name));
			expect(run).toBeTruthy();
			expect(run.ok).toBe(true);
			expect(run.setpoints.length).toBeGreaterThan(0);
			expect(run.data.some((d) => d.name === "batch_result" && d.kind === "value")).toBe(true);
			expect(run.devices.some((d) => d.id === "sim")).toBe(true);
		});
	});

	test("notes and runs persist across lab restarts (DATA_DIR/journal.json)", () => {
		const lab2 = labModule.create({ dataDir: dataDir, channelCapacity: 200 });
		return lab2.restore().then(() => {
			expect(lab2.journal.notes().some((n) => n.text === "output follows input")).toBe(true);
			expect(lab2.journal.runs().some((r) => r.name === "cap-test")).toBe(true);
			return lab2.shutdown();
		});
	});
});
