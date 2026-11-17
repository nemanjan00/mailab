const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const labModule = require("../../lab");
const web = require("../../web");

// jest's node environment copies process.env at setup, so PATH mutations in
// tests are invisible to spawned children. Wrap spawn/spawnSync to pass the
// mutated env explicitly; the fake hackrf_* scripts below rely on PATH order.
jest.mock("child_process", () => {
	const real = jest.requireActual("child_process");
	const wrap = (fn) => (...a) => {
		if (!a[2] || !a[2].env) {
			a[2] = Object.assign({}, a[2], { env: Object.assign({}, process.env) });
		}
		return fn(...a);
	};
	return Object.assign({}, real, { spawn: wrap(real.spawn), spawnSync: wrap(real.spawnSync) });
});

const MCP = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shared RF TX policy: one gate for hackrf transmit / rfcat tx / soapy_sink
// flowgraphs. Uses the real hackrf driver against fake hackrf_sweep /
// hackrf_transfer executables dropped first in PATH.
describe("RF TX policy gate", () => {
	let lab;
	let app;
	let server;
	let binDir;
	let iqFile;
	const keepPath = process.env.PATH;
	const ENV = ["MAILAB_RF_REGION", "MAILAB_RF_TX_EXTRA", "MAILAB_RF_CHAMBER", "MAILAB_UNSAFE", "MAILAB_RF_TX_MAX_GAIN", "MAILAB_RF_TX_MAX_SECONDS"];

	const call = (name, args) => request(app).post("/mcp").set(MCP).send({
		jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} }
	});

	beforeAll(() => {
		ENV.forEach((key) => delete process.env[key]);
		process.env.MAILAB_RF_REGION = "eu";
		binDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-hackrf-bin-"));
		// hackrf_sweep: one sweep band, then idle until killed
		fs.writeFileSync(path.join(binDir, "hackrf_sweep"), "#!/bin/sh\nprintf '2024-01-01, 00:00:00.000000, 100000000, 200000000, 1000000, 20, -50.0\\n'\nwhile :; do sleep 1; done\n");
		// hackrf_transfer: touch the -t file so the TX is observable, then idle
		fs.writeFileSync(path.join(binDir, "hackrf_transfer"), "#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = \"-t\" ]; then touch \"$2\"; fi; shift 2 2>/dev/null || shift; done\nwhile :; do sleep 1; done\n");
		fs.chmodSync(path.join(binDir, "hackrf_sweep"), 0o755);
		fs.chmodSync(path.join(binDir, "hackrf_transfer"), 0o755);
		process.env.PATH = binDir + ":" + keepPath;
		iqFile = path.join(os.tmpdir(), "mailab-test-tx-" + Date.now() + ".cf32");
		fs.writeFileSync(iqFile, Buffer.alloc(4096));

		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-txgate-")), channelCapacity: 200 });
		const created = web.create(lab, { pushIntervalMs: 50 });
		app = created.app;
		server = created.server;
		return lab.restore()
			.then(() => lab.addDevice("hack", "hackrf", { startMhz: 100, stopMhz: 200 }))
			.then(() => lab.startDevice("hack"));
	});

	afterAll(() => {
		process.env.PATH = keepPath;
		fs.rmSync(binDir, { recursive: true, force: true });
		fs.rmSync(iqFile, { force: true });
		ENV.forEach((key) => delete process.env[key]);
		server.close();
		return lab.shutdown();
	});

	test("a TX outside the region bands is refused without spawning anything", () => {
		return lab.commandDevice("hack", "transmit", { path: iqFile, freqHz: 915e6, gain: 20, seconds: 10 }).then(() => {
			throw new Error("should have been refused");
		}, (err) => {
			expect(String(err.message)).toMatch(/TX refused: 915 MHz is outside/);
			expect(lab.txSessions().length).toBe(0);
		});
	});

	test("MAILAB_RF_TX_EXTRA opens a person-configured band", () => {
		process.env.MAILAB_RF_TX_EXTRA = "900M-930M";
		return lab.commandDevice("hack", "transmit", { path: iqFile, freqHz: 915e6, gain: 20, seconds: 10 }, { approved: true, who: "test" })
			.then(() => {
				expect(lab.txSessions().length).toBe(1);
				return lab.stopTxSession(lab.txSessions()[0].id, "test cleanup");
			})
			.finally(() => {
				delete process.env.MAILAB_RF_TX_EXTRA;
			});
	});

	test("gain above the MAILAB_RF_TX_MAX_GAIN cap is rejected", () => {
		return lab.commandDevice("hack", "transmit", { path: iqFile, freqHz: 433920000, gain: 50, seconds: 10 }, { approved: true }).then(() => {
			throw new Error("should have been rejected");
		}, (err) => {
			expect(String(err.message)).toMatch(/above the MAILAB_RF_TX_MAX_GAIN cap/);
		});
	});

	test("a gated TX asks for approval, opens a session, and the kill switch stops it", () => {
		const pendingCall = lab.commandDevice("hack", "transmit", { path: iqFile, freqHz: 433920000, gain: 20, seconds: 60 }, { who: "test" });
		const decided = wait(200).then(() => {
			const pending = lab.safety.listPending();
			expect(pending.length).toBe(1);
			expect(pending[0].command).toBe("tx");
			expect(pending[0].args.freqHz).toBe(433920000);
			return request(app).post("/api/approvals/" + pending[0].id).send({ approve: true }).expect(200);
		});
		return Promise.all([pendingCall, decided]).then(() => {
			const sessions = lab.txSessions();
			expect(sessions.length).toBe(1);
			expect(sessions[0].device).toBe("hack");
			expect(sessions[0].freqHz).toBe(433920000);
			expect(sessions[0].startedBy).toBe("test");
			expect(fs.existsSync(path.join(binDir, "..", "hackrf-transfer-ran"))).toBe(false);
			// the shared state carries the session for the UI banner
			expect(lab.state().tx.length).toBe(1);
			return lab.stopTxSession(sessions[0].id, "kill switch");
		}).then(() => {
			expect(lab.txSessions().length).toBe(0);
			expect(lab.state().tx.length).toBe(0);
		});
	});

	test("seconds are clamped to the cap and the session auto-stops", () => {
		process.env.MAILAB_RF_TX_MAX_SECONDS = "1";
		return lab.commandDevice("hack", "transmit", { path: iqFile, freqHz: 433920000, gain: 20, seconds: 60 }, { approved: true, who: "test" })
			.then((result) => {
				expect(result.seconds).toBe(60); // the driver runs what the gate clamped
				const session = lab.txSessions()[0];
				expect(session.endsAt - session.t).toBeLessThanOrEqual(1100);
				return wait(1500);
			})
			.then(() => {
				expect(lab.txSessions().length).toBe(0);
			})
			.finally(() => {
				delete process.env.MAILAB_RF_TX_MAX_SECONDS;
			});
	});

	test("MCP tx_status / tx_kill expose and stop the session", () => {
		return lab.commandDevice("hack", "transmit", { path: iqFile, freqHz: 433920000, gain: 20, seconds: 0 }, { approved: true, who: "test" })
			.then(() => call("tx_status"))
			.then((res) => {
				expect(res.body.result.isError).toBeFalsy();
				const sessions = JSON.parse(res.body.result.content[0].text).tx;
				expect(sessions.length).toBe(1);
				return call("tx_kill", {});
			})
			.then((res) => {
				expect(res.body.result.isError).toBeFalsy();
				expect(lab.txSessions().length).toBe(0);
			});
	});

	test("non-TX commands pass through the gate untouched", () => {
		return lab.commandDevice("hack", "configure", { startMhz: 100 }).then((settings) => {
			expect(settings.startMhz).toBe(100);
			expect(lab.txSessions().length).toBe(0);
		});
	});
});
