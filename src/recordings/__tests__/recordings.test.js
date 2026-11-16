const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const labModule = require("../../lab");
const authModule = require("../../auth");
const web = require("../../web");
const recordings = require("..");

const MCP = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const AI = { authorization: "Bearer ai" };
const ME = { authorization: "Bearer me" };
const VIEWER = { authorization: "Bearer view" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const call = (app, who, name, args) => request(app).post("/mcp").set(MCP).set(who).send({
	jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} }
}).then((res) => res.body.result);

const until = (check, timeoutMs) => {
	const deadline = Date.now() + timeoutMs;
	const poll = () => {
		if (check()) {
			return Promise.resolve();
		}
		if (Date.now() > deadline) {
			return Promise.reject(new Error("timed out"));
		}
		return wait(10).then(poll);
	};
	return poll();
};

describe("record & replay", () => {
	let lab;
	let app;
	let server;
	let dataDir;

	beforeAll(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-rec-"));
		lab = labModule.create({ dataDir: dataDir, channelCapacity: 10000, watchUsb: false });
		const created = web.create(lab, { pushIntervalMs: 50, auth: authModule.create(authModule.parseTokens("claude:ai:rw,me:me:human,viewer:view:ro")) });
		app = created.app;
		server = created.server;
		return lab.restore();
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	test("records channels, traces, values, events and logs, then replays them under a prefix", () => {
		return lab.addDevice("bench", "sim", { rateHz: 100, signals: [{ name: "ramp", shape: "ramp", freq: 1, amp: 1, unit: "V" }] })
			.then(() => call(app, VIEWER, "recording_start", { name: "r1", channels: ["bench_*"] }))
			.then((result) => {
				expect(result.isError).toBe(true);
				return call(app, AI, "recording_start", { name: "r1", channels: ["bench_*"], note: "ramp test" });
			})
			.then((result) => {
				expect(result.isError).toBeFalsy();
				return wait(100);
			})
			.then(() => {
				lab.setTrace("bench_spec", { x: [1, 2, 3], series: [{ label: "dB", y: [-1, -2, -3] }] }, "test");
				lab.setValue("bench_info", { serial: "X1" }, "test");
				lab.setValue("other_info", { skip: true }, "test");
				lab.notify({ type: "trigger", device: "bench", name: "bench_edge" });
				lab.log("bench", "temp=21C", "rx");
				return wait(250);
			})
			.then(() => call(app, VIEWER, "recordings"))
			.then((result) => {
				const list = JSON.parse(result.content[0].text);
				expect(list[0]).toMatchObject({ name: "r1", active: true, note: "ramp test" });
				return request(app).post("/api/recordings/r1/stop").set(AI).expect(200);
			})
			.then((res) => {
				expect(res.body).toMatchObject({ name: "r1", active: false, reason: "stopped" });
				expect(res.body.counts.samples).toBeGreaterThan(20);
				expect(res.body.counts).toMatchObject({ channels: 1, traces: 1, values: 1, logs: 1 });
				// the trigger, plus the classifier's new-cluster event for the log line
				expect(res.body.counts.events).toBeGreaterThanOrEqual(1);
				return lab.removeDevice("bench");
			})
			.then(() => {
				const rec = recordings.load(path.join(dataDir, "recordings"), "r1");
				const original = rec.records.filter((r) => r.type === "s").map((r) => r.v);
				const span = rec.t1 - rec.t0;
				return lab.addDevice("rp", "replay", { recording: "r1", prefix: "rp_", speed: 4 })
					.then(() => until(() => lab.listDevices().find((d) => d.id === "rp").detail === "finished", 3000))
					.then(() => {
						const replayed = lab.channels.read("rp_bench_ramp");
						expect(replayed.v).toEqual(original);
						expect(lab.channels.describe("rp_bench_ramp").unit).toBe("V");
						// original timing, 4x faster
						expect(replayed.t[replayed.t.length - 1] - replayed.t[0]).toBeCloseTo(span / 4, 0);
						expect(lab.getTrace("rp_bench_spec").series[0].y).toEqual([-1, -2, -3]);
						expect(lab.getValue("rp_bench_info").value).toEqual({ serial: "X1" });
						expect(() => lab.getValue("rp_other_info")).toThrow();
						expect(lab.getNotifications().some((n) => n.replay === "r1" && n.name === "bench_edge" && n.device === "rp")).toBe(true);
						expect(lab.getLogs({ device: "rp" }).some((l) => l.text === "temp=21C")).toBe(true);
						return lab.commandDevice("rp", "status");
					})
					.then((status) => {
						expect(status).toMatchObject({ finished: true, recording: "r1", records: rec.records.length });
					});
			});
	});

	test("loop, pause and seek", () => {
		return lab.addDevice("lp", "replay", { recording: "r1", prefix: "lp_", speed: 20, loop: true })
			.then(() => wait(150))
			.then(() => lab.commandDevice("lp", "status"))
			.then((status) => {
				expect(status.loops).toBeGreaterThanOrEqual(1);
				return lab.commandDevice("lp", "pause");
			})
			.then(() => {
				const count = lab.channels.read("lp_bench_ramp").v.length;
				return wait(60).then(() => {
					expect(lab.channels.read("lp_bench_ramp").v.length).toBe(count);
					return lab.commandDevice("lp", "seek", { seconds: 0.1 });
				});
			})
			.then((status) => {
				expect(status.position).toBeCloseTo(0.1, 2);
				return lab.removeDevice("lp");
			});
	});

	test("replay refuses unknown recordings; names and globs are validated", () => {
		return lab.addDevice("bad", "replay", { recording: "nope" })
			.then((d) => {
				expect(d.state).toBe("error");
				expect(d.detail).toMatch(/no recording nope/);
				expect(() => lab.recordings.start({ name: "../x", channels: ["*"] })).toThrow(/recording names/);
				expect(() => lab.recordings.start({ name: "r2", channels: [] })).toThrow(/channel globs/);
				expect(() => lab.recordings.start({ name: "r1", channels: ["*"] })).toThrow(/exists/);
				return lab.removeDevice("bad");
			});
	});

	test("recordings stop at maxSeconds; deleting is for people only", () => {
		return request(app).post("/api/recordings").set(AI).send({ name: "short", channels: ["*"], maxSeconds: 0.1 }).expect(200)
			.then(() => wait(200))
			.then(() => request(app).get("/api/recordings").set(VIEWER).expect(200))
			.then((res) => {
				expect(res.body.find((r) => r.name === "short")).toMatchObject({ active: false, complete: true });
				return request(app).get("/api/recordings/short").set(VIEWER).expect(200);
			})
			.then((res) => {
				expect(String(res.text || res.body).split("\n")[0]).toMatch(/"mailab_recording":1/);
				return request(app).delete("/api/recordings/short").set(AI).expect(403);
			})
			.then(() => request(app).delete("/api/recordings/short").set(ME).expect(200))
			.then(() => {
				expect(lab.recordings.list().map((r) => r.name)).toEqual(["r1"]);
			});
	});
});
