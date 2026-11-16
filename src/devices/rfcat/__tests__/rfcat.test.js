// RfCat driver: python helper checks (python/test_rfcat.py), then the bridge
// end to end through the lab with the fake dongle (MAILAB_RFCAT_FAKE=1):
// config, rx, specan, tx / replay behind the approval policy, band refusal.
// No rflib and no radio needed; hardware itself is untested.

const fs = require("fs");
const os = require("os");
const path = require("path");
const spawnSync = require("child_process").spawnSync;
const request = require("supertest");
const config = require("../../../config");
const labModule = require("../../../lab");
const web = require("../../../web");
const rfcat = require("..");
const safety = require("../../../safety");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");
const MCP = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const python = () => spawnSync(config.get("PYTHON"), ["-c", "import sys"]).status === 0;
const maybe = python() ? describe : describe.skip;

describe("rfcat driver args", () => {
	const io = {
		getBlob: (name) => {
			if (name !== "rf_packets") {
				throw new Error("unknown blob: " + name);
			}
			return Buffer.from([0xaa, 0x55]);
		}
	};

	test("rx stretches the command timeout past its window", () => {
		expect(rfcat._bridgeArgs(io, "rx", { timeoutMs: 5000, count: 2 })).toEqual({ windowMs: 5000, timeoutMs: 20000, count: 2 });
		expect(rfcat._bridgeArgs(io, "rx", {}).windowMs).toBe(2000);
	});

	test("tx / replay resolve a lab blob to base64 data", () => {
		const out = rfcat._bridgeArgs(io, "replay", { blob: "rf_packets", offset: 0, length: 1 });
		expect(out.data).toBe("qlU=");
		expect(out.blob).toBeUndefined();
		expect(() => rfcat._bridgeArgs(io, "tx", { blob: "nope" })).toThrow(/unknown blob/);
		// other commands pass blob through untouched
		expect(rfcat._bridgeArgs(io, "config", { blob: "x" }).blob).toBe("x");
	});

	test("default policy gates rfcat tx, replay and power, not rx", () => {
		const lab = { getDevice: () => ({ driver: "rfcat" }) };
		const s = safety.create(Object.assign({ events: { emit: () => {} } }, lab), {});
		expect(s.needsApproval("rf", "rfcat", "tx", { hex: "00" })).toBeTruthy();
		expect(s.needsApproval("rf", "rfcat", "replay", { index: 1 })).toBeTruthy();
		expect(s.needsApproval("rf", "rfcat", "power", { max: true })).toBeTruthy();
		expect(s.needsApproval("rf", "rfcat", "rx", {})).toBeNull();
		expect(s.needsApproval("rf", "rfcat", "specan", { center: 433.92e6 })).toBeNull();
		// a saved policy from before rfcat existed gets the new entries
		const older = safety.DEFAULT_POLICY.filter((p) => p.driver !== "rfcat");
		expect(safety.withNewDefaults(older, []).filter((p) => p.driver === "rfcat").length).toBe(3);
	});
});

maybe("rfcat bridge (python)", () => {
	test("band checks, parsing, packet formatting, fake device", () => {
		const run = spawnSync(config.get("PYTHON"), ["test_rfcat.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 60000 });
		if (run.status !== 0) {
			throw new Error(run.stdout + run.stderr);
		}
		["bands", "parsing", "format", "device"].forEach((name) => {
			expect(run.stdout).toMatch(new RegExp("ok " + name));
		});
	}, 70000);
});

maybe("rfcat through the lab (fake dongle)", () => {
	let lab;
	let app;
	let server;
	let managed;

	const call = (name, args) => request(app).post("/mcp").set(MCP).send({
		jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} }
	});
	const command = (cmd, args) => lab.commandDevice("rf", cmd, args || {});
	const decideNext = (approve) => wait(300).then(() => {
		const pending = lab.safety.listPending();
		expect(pending.length).toBe(1);
		expect(pending[0].command).toBeDefined();
		return request(app).post("/api/approvals/" + pending[0].id).send({ approve: approve }).expect(200).then(() => pending[0]);
	});

	beforeAll(() => {
		// run the bridge with the system python, no venv / pip
		managed = process.env.MAILAB_MANAGE_PYTHON;
		process.env.MAILAB_MANAGE_PYTHON = "0";
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-rfcat-")), channelCapacity: 200 });
		const created = web.create(lab, { pushIntervalMs: 50 });
		app = created.app;
		server = created.server;
		return lab.restore().then(() => lab.addDevice("rf", "rfcat", {
			freq: 433.92e6, modulation: "ASK_OOK", drate: 4800,
			env: { MAILAB_RFCAT_FAKE: "1" }
		}));
	});

	afterAll(() => {
		if (managed === undefined) {
			delete process.env.MAILAB_MANAGE_PYTHON;
		} else {
			process.env.MAILAB_MANAGE_PYTHON = managed;
		}
		server.close();
		return lab.shutdown();
	});

	test("info and config read back the effective settings", () => {
		return command("info").then((info) => {
			expect(info.fake).toBe(true);
			expect(info.chip).toBe("CC1111");
			expect(info.txBands).toMatch(/433\.050-434\.790 MHz/);
			return command("config", { syncWord: "0xd391", pktLen: 12, variable: "off", crc: false, preamble: 4 });
		}).then((cfg) => {
			expect(cfg.freq).toBe(433.92e6);
			expect(cfg.modulation).toBe("ASK_OOK");
			expect(cfg.syncWord).toBe("0xd391");
			expect(cfg.pktLen).toBe(12);
			expect(cfg.crc).toBe(false);
			expect(cfg.registers.sync1).toBe("0xd3");
			// applied settings persist as device options
			expect(lab.getDevice("rf").options.syncWord).toBe("0xd391");
			return expect(command("config", { power: 192 })).rejects.toThrow(/power command/);
		}).then(() => {
			return expect(command("config", { crc: "maybe" })).rejects.toThrow(/crc must be/);
		});
	}, 20000);

	test("rx returns packets as table, blob, events and rssi", () => {
		return command("rx", { timeoutMs: 300, count: 5 }).then((res) => {
			expect(res.count).toBe(2);
			expect(res.packets[0].hex).toBe("aa5501020304");
			expect(res.packets[1].bytes).toEqual(Array.from(Buffer.from("hello rfcat")));
			expect(typeof res.packets[0].rssi).toBe("number");
			return wait(200);
		}).then(() => {
			const table = lab.getValue("rf_packets").value;
			expect(table.map((r) => r.offset)).toEqual([0, 6]);
			expect(lab.getBlob("rf_packets").data.toString("hex")).toBe("aa5501020304" + Buffer.from("hello rfcat").toString("hex"));
			expect(lab.getNotifications({}).filter((n) => n.name === "rf_packet").length).toBe(2);
		});
	}, 20000);

	test("specan publishes a dBm spectrum trace", () => {
		return command("specan", { center: 433.92e6, span: 2.5e6, count: 100, seconds: 0.3, rate: 50 }).then((res) => {
			expect(res.frames).toBeGreaterThan(0);
			expect(res.peakDbm).toBe(-40);
			expect(res.peakFreq).toBeCloseTo(433.92e6, -3);
			const trace = lab.getTrace("rf_spectrum");
			expect(trace.x.length).toBe(100);
			expect(trace.yUnit).toBe("dBm");
		});
	}, 20000);

	test("AI tx waits for a person; approved it transmits and loops back", () => {
		const tx = call("device_command", { id: "rf", command: "tx", args: { hex: "c0ffee", repeat: 2 } });
		return Promise.all([tx, decideNext(true)]).then((results) => {
			expect(results[1].command).toBe("tx");
			expect(results[0].body.result.isError).toBeFalsy();
			expect(results[0].body.result.content[0].text).toMatch(/c0ffee/);
			return command("rx", { timeoutMs: 300, count: 5 });
		}).then((res) => {
			expect(res.packets.map((p) => p.hex)).toEqual(["c0ffee", "c0ffee"]);
		});
	}, 20000);

	test("denied replay never transmits; approved replay sends the captured packet", () => {
		const denied = call("device_command", { id: "rf", command: "replay", args: { index: 1 } });
		return Promise.all([denied, decideNext(false)]).then((results) => {
			expect(results[0].body.result.isError).toBe(true);
			expect(results[0].body.result.content[0].text).toMatch(/not approved/);
			return command("packets", { last: 50 });
		}).then((rows) => {
			// nothing new on air: rx is empty
			expect(rows.length).toBe(4);
			return command("rx", { timeoutMs: 200 });
		}).then((res) => {
			expect(res.count).toBe(0);
			const replay = call("device_command", { id: "rf", command: "replay", args: { blob: "rf_packets", offset: 0, length: 6 } });
			return Promise.all([replay, decideNext(true)]);
		}).then((results) => {
			expect(results[0].body.result.isError).toBeFalsy();
			return command("rx", { timeoutMs: 300 });
		}).then((res) => {
			expect(res.packets.map((p) => p.hex)).toEqual(["aa5501020304"]);
		});
	}, 30000);

	test("the TX region comes from the lab, not from device options", () => {
		const old = process.env.MAILAB_RF_REGION;
		process.env.MAILAB_RF_REGION = "eu";
		try {
			const args = rfcat._startArgs({ region: "us", freq: 915e6, txBands: "433.9M-433.95M" });
			expect(args.filter((a) => a === "--region").length).toBe(1);
			expect(args[args.indexOf("--region") + 1]).toBe("eu");
			expect(args).toContain("--tx-bands");
		} finally {
			if (old === undefined) {
				delete process.env.MAILAB_RF_REGION;
			} else {
				process.env.MAILAB_RF_REGION = old;
			}
		}
	});

	test("TX outside the region's bands is refused by the bridge", () => {
		return command("config", { freq: 915e6 }).then(() => {
			return expect(command("tx", { hex: "00" })).rejects.toThrow(/TX refused: 915\.000000 MHz/);
		}).then(() => command("config", { freq: 433.92e6 }));
	}, 20000);

	test("listen streams packets and rssi; idle stops it", () => {
		return command("listen", { on: "on" }).then(() => {
			return command("tx", { text: "ping" });
		}).then(() => wait(800)).then(() => {
			const scope = lab.scopeFor(["rf_rssi"], { latest: true });
			expect(typeof scope.rf_rssi).toBe("number");
			expect(lab.getValue("rf_packets").value.slice(-1)[0].ascii).toBe("ping");
			return expect(command("listen", { on: "yes" })).rejects.toThrow(/on must be/);
		}).then(() => command("idle")).then((res) => {
			expect(res.mode).toBe("idle");
		});
	}, 20000);
});
