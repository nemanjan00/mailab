// Cynthion driver against the bridge's fake board (MAILAB_CYNTHION_FAKE=1):
// python decode suite, command plumbing, pcap blobs, approvals. No hardware.

const fs = require("fs");
const os = require("os");
const path = require("path");
const spawnSync = require("child_process").spawnSync;
const request = require("supertest");
const config = require("../../../config");
const cynthion = require("..");
const safety = require("../../../safety");
const labModule = require("../../../lab");
const web = require("../../../web");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");
const MCP = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const available = () => spawnSync(config.get("PYTHON"), ["--version"]).status === 0;
const maybe = available() ? describe : describe.skip;

/**
 * Wait until `check()` returns something truthy.
 */
const until = (check, timeoutMs) => {
	const end = Date.now() + (timeoutMs || 5000);
	const poll = () => {
		const value = check();
		if (value) {
			return Promise.resolve(value);
		}
		if (Date.now() > end) {
			return Promise.reject(new Error("timed out waiting"));
		}
		return wait(50).then(poll);
	};
	return poll();
};

const fakeIo = () => {
	const io = { id: "cy", logs: [], values: {}, blobs: {}, samples: [], events: [], state: null };
	io.log = (text, level) => io.logs.push({ text: text, level: level });
	io.status = (state, detail) => {
		io.state = state;
		io.detail = detail;
	};
	io.value = (name, value) => {
		io.values[name] = value;
	};
	io.blob = (name, data) => {
		io.blobs[name] = data;
	};
	io.getBlob = (name) => {
		const short = name.replace(/^cy_/, "");
		if (!io.blobs[short]) {
			throw new Error("unknown blob: " + name);
		}
		return io.blobs[short];
	};
	io.sample = (field, value) => io.samples.push({ field: field, value: value });
	io.event = (name, data) => io.events.push({ name: name, data: data });
	io.setOptions = () => {};
	return io;
};

let savedEnv;

beforeAll(() => {
	savedEnv = { manage: process.env.MAILAB_MANAGE_PYTHON, fake: process.env.MAILAB_CYNTHION_FAKE };
	// no venv / pip in tests: the fake board needs only the stdlib
	process.env.MAILAB_MANAGE_PYTHON = "0";
	process.env.MAILAB_CYNTHION_FAKE = "1";
});

afterAll(() => {
	["MAILAB_MANAGE_PYTHON", "MAILAB_CYNTHION_FAKE"].forEach((key, i) => {
		const old = [savedEnv.manage, savedEnv.fake][i];
		if (old === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = old;
		}
	});
});

maybe("usb decoding (python)", () => {
	test("PIDs, CRC5/CRC16, stream framing, transactions, descriptors, pcap", () => {
		const run = spawnSync(config.get("PYTHON"), ["test_cynthion.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 60000 });
		if (run.status !== 0) {
			throw new Error(run.stdout + run.stderr);
		}
		expect(run.stdout).toMatch(/ok cynthion/);
	}, 70000);
});

maybe("cynthion driver with the fake board", () => {
	let io;
	let dev;

	beforeAll(() => {
		io = fakeIo();
		dev = cynthion.create({}, io);
		return dev.start();
	});

	afterAll(() => dev.stop());

	test("info reports the fake board and the LUNA toolchain", () => {
		return dev.command("info").then((info) => {
			expect(info.fake).toBe(true);
			expect(info.boards[0].mode).toBe("analyzer");
			expect(info.toolchain.note).toMatch(/yosys/);
			expect(Array.isArray(info.toolchain.missing)).toBe(true);
		});
	});

	test("capture: live values, pcap blob (LINKTYPE 288), descriptors", () => {
		return dev.command("capture_start", { speed: "auto" }).then((res) => {
			expect(res.capturing).toBe(true);
			return until(() => io.values.devices && io.values.devices["5"]);
		}).then(() => {
			expect(io.logs.some((l) => /SET_ADDRESS 5/.test(l.text))).toBe(true);
			expect(io.values.transfers.length).toBeGreaterThan(5);
			return dev.command("capture_stop", { name: "enum" });
		}).then((res) => {
			expect(res.blob).toBe("cy_enum");
			expect(res.speed).toBe("full");
			expect(res.errors).toBe(0);
			const pcap = io.blobs.enum;
			expect(pcap.readUInt32LE(0)).toBe(0xa1b23c4d);
			expect(pcap.readUInt32LE(20)).toBe(288);
			return dev.command("descriptors", { addr: 5 });
		}).then((d) => {
			expect(d.summary).toBe("1209:0001 Mailab Fake Keyboard serial 0001 USB 2.00 (HID)");
			expect(d.configurations["0"].interfaces[0].endpoints[0].address).toBe("0x81");
		});
	});

	test("a saved pcap loads back (as a Packetry file would) and decodes the same", () => {
		const pcap = io.blobs.enum;
		return dev.command("load", { data: pcap.toString("base64") }).then((res) => {
			expect(res.source).toBe("pcap");
			expect(res.devices["5"]).toMatch(/Fake Keyboard/);
			return dev.command("load", { blob: "cy_enum" });
		}).then(() => {
			return dev.command("decode", { view: "transactions", hideNak: true, limit: 3 });
		}).then((res) => {
			expect(res.rows[0]).toMatchObject({ token: "SETUP", addr: 0, ep: 0, handshake: "ACK", data: "8006000100004000" });
			return dev.command("decode", { view: "packets", errorsOnly: true });
		}).then((res) => {
			expect(res.rows).toEqual([]);
		});
	});

	test("bad arguments are refused", () => {
		return expect(dev.command("capture_start", { speed: "ludicrous" })).rejects.toThrow(/speed/)
			.then(() => expect(dev.command("load", { path: "/etc/passwd" })).rejects.toThrow(/not \{path\}/))
			.then(() => expect(dev.command("gateware", { name: "doom" })).rejects.toThrow(/analyzer/))
			.then(() => expect(dev.command("gateware", { data: Buffer.from("not a bitstream").toString("base64") })).rejects.toThrow(/ECP5/))
			.then(() => expect(dev.command("emulate", { mode: "mass_storage" })).rejects.toThrow(/disk image/));
	});

	test("emulation: keyboard, mass storage from a blob, fuzz", () => {
		return dev.command("emulate", { mode: "keyboard", text: "hello" }).then((res) => {
			expect(res).toMatchObject({ started: "keyboard", fake: true, gatewareLoaded: true });
			return until(() => io.events.find((e) => e.name === "emulation"));
		}).then(() => {
			expect(io.logs.some((l) => /typed 'hello'/.test(l.text))).toBe(true);
			// the board now runs facedancer: capturing needs the analyzer back
			return expect(dev.command("capture_start", {})).rejects.toThrow(/facedancer/);
		}).then(() => {
			io.blobs.disk = Buffer.alloc(64 * 512);
			return dev.command("emulate", { mode: "mass_storage", blob: "cy_disk", duration: 0.1 });
		}).then(() => {
			return until(() => io.events.filter((e) => e.name === "emulation").length >= 2);
		}).then(() => {
			return dev.command("emulate_status");
		}).then((st) => {
			expect(st.state).toBe("done");
			expect(st.results[0]).toEqual({ bytes: 32768, blocks: 64 });
			return dev.command("emulate", { mode: "fuzz", count: 4, seed: 2 });
		}).then(() => {
			return until(() => io.values.fuzz);
		}).then(() => {
			expect(io.values.fuzz.map((r) => r.mutation)).toEqual(["device.bLength=0x00", "device.bLength=0x01", "device.bLength=0x7f", "device.bLength=0x80"]);
			expect(io.values.fuzz[0].device.slice(0, 2)).toBe("00");
			return dev.command("gateware", { name: "analyzer" });
		}).then((res) => {
			expect(res.gateware).toBe("analyzer");
			return dev.command("capture_start", { speed: "high" });
		}).then(() => dev.command("capture_stop", {}))
			.then((res) => {
				expect(res.blob).toBe("cy_capture");
				expect(res.speed).toBe("high");
			});
	});
});

describe("cynthion approvals", () => {
	test("emulate, gateware and flash need approval by default; capture does not", () => {
		const s = safety.create({}, {});
		expect(s.needsApproval("cy", "cynthion", "emulate", { mode: "keyboard" })).toBeTruthy();
		expect(s.needsApproval("cy", "cynthion", "gateware", { name: "analyzer" })).toBeTruthy();
		expect(s.needsApproval("cy", "cynthion", "flash", { name: "analyzer" })).toBeTruthy();
		expect(s.needsApproval("cy", "cynthion", "capture_start", {})).toBeNull();
		expect(s.needsApproval("cy", "cynthion", "info", {})).toBeNull();
	});
});

maybe("cynthion through MCP", () => {
	let lab;
	let app;
	let server;

	const call = (name, args) => request(app).post("/mcp").set(MCP).send({
		jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} }
	});

	beforeAll(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-cynthion-")), channelCapacity: 200 });
		const created = web.create(lab, { pushIntervalMs: 50 });
		app = created.app;
		server = created.server;
		return lab.restore().then(() => lab.addDevice("cy", "cynthion", { fake: true }));
	});

	afterAll(() => {
		server.close();
		return lab.shutdown();
	});

	test("an AI emulate waits for a person; denied means not run", () => {
		const pending = call("device_command", { id: "cy", command: "emulate", args: { mode: "keyboard", text: "x" } });
		const deny = until(() => lab.safety.listPending()[0]).then((p) => {
			expect(p.reason).toMatch(/Facedancer/);
			return request(app).post("/api/approvals/" + p.id).send({ approve: false }).expect(200);
		});
		return Promise.all([pending, deny]).then((results) => {
			expect(results[0].body.result.isError).toBe(true);
			expect(results[0].body.result.content[0].text).toMatch(/not approved/);
			return lab.commandDevice("cy", "emulate_status");
		}).then((st) => {
			expect(st.state).toBe("idle");
		});
	});

	test("capture needs no approval and its pcap lands in the lab's blobs", () => {
		return call("device_command", { id: "cy", command: "capture_start", args: { speed: "full" } }).then((res) => {
			expect(res.body.result.isError).toBeFalsy();
			return wait(700);
		}).then(() => call("device_command", { id: "cy", command: "capture_stop", args: {} })).then((res) => {
			expect(res.body.result.isError).toBeFalsy();
			return until(() => {
				try {
					return lab.getBlob("cy_capture");
				} catch (_err) {
					return null;
				}
			});
		}).then((blob) => {
			expect(blob.data.readUInt32LE(20)).toBe(288);
		});
	});
});
