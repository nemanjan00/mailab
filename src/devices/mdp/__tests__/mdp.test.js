// mdp driver against a fake mdp-p906 host: validation must happen before
// anything is sent over the radio.

const fs = require("fs");
const os = require("os");
const path = require("path");
const mdp = require("..");

const FAKE_BRIDGE = "module.exports = { open: () => Promise.resolve({ close: () => Promise.resolve() }) };\n";
const FAKE_PSU = [
	"const sent = [];",
	"module.exports = {",
	"	sent: sent,",
	"	DEFAULT_CHANNEL: 78,",
	"	DEFAULT_ADDRESS: [0xe0, 0xd3, 0xc2, 0xb1, 0xa0],",
	"	create: () => ({",
	"		useLink: () => Promise.resolve(),",
	"		handshake: () => Promise.resolve({ ok: true }),",
	"		status: () => Promise.resolve(null),",
	"		setVoltage: (mv) => { sent.push(['setVoltage', mv]); return Promise.resolve({}); },",
	"		setCurrent: (ma) => { sent.push(['setCurrent', ma]); return Promise.resolve({}); },",
	"		setOutput: (on) => { sent.push(['setOutput', on]); return Promise.resolve({}); }",
	"	})",
	"};"
].join("\n");

const makeHost = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdp-host-"));
	fs.mkdirSync(path.join(dir, "src", "services", "bridge"), { recursive: true });
	fs.mkdirSync(path.join(dir, "src", "psu"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src", "services", "bridge", "index.js"), FAKE_BRIDGE);
	fs.writeFileSync(path.join(dir, "src", "psu", "index.js"), FAKE_PSU);
	return dir;
};

const io = () => {
	return { id: "psu" + Math.random().toString(16).slice(2, 6), sample: jest.fn(), log: jest.fn(), status: jest.fn() };
};

describe("mdp driver safety", () => {
	let hostPath;
	let sent;

	beforeAll(() => {
		hostPath = makeHost();
		sent = require(path.join(hostPath, "src", "psu")).sent;
	});

	beforeEach(() => {
		sent.length = 0;
	});

	const started = (options) => {
		const dev = mdp.create(Object.assign({ hostPath: hostPath, id: "1a2b3c4d", pollMs: 60000 }, options), io());
		return dev.start().then(() => {
			return dev;
		});
	};

	test("requires the module ID", () => {
		const dev = mdp.create({ hostPath: hostPath }, io());
		return expect(dev.start()).rejects.toThrow(/option id is required/);
	});

	test("warns about an explicit all-zero ID", () => {
		const sink = io();
		const dev = mdp.create({ hostPath: hostPath, id: "00000000", pollMs: 60000 }, sink);
		return dev.start().then(() => {
			expect(sink.log).toHaveBeenCalledWith(expect.stringMatching(/all-zero module ID/), "warn");
			return dev.stop();
		});
	});

	test("output only accepts real switches; \"false\" turns it off", () => {
		return started().then((dev) => {
			return expect(dev.command("output", { on: "yes" })).rejects.toThrow(/on must be/)
				.then(() => {
					return dev.command("output", { on: "false" });
				})
				.then(() => {
					expect(sent).toEqual([["setOutput", false]]);
					return dev.stop();
				});
		});
	});

	test("voltage is limited to the P906 rating and to maxVolts", () => {
		return started({ maxVolts: 12 }).then((dev) => {
			return expect(dev.command("set_voltage", { volts: 45 })).rejects.toThrow(/above the limit 12 V/)
				.then(() => {
					return expect(dev.command("set_voltage", { volts: -1 })).rejects.toThrow(/below the minimum/);
				})
				.then(() => {
					return dev.command("set_voltage", { volts: 3.3 });
				})
				.then(() => {
					expect(sent).toEqual([["setVoltage", 3300]]);
					return dev.stop();
				});
		});
	});

	test("maxVolts above the hardware rating is refused", () => {
		expect(() => {
			mdp.create({ hostPath: hostPath, id: "1a2b3c4d", maxVolts: 45 }, io());
		}).toThrow(/above the limit 30/);
	});

	test("set_current stays disabled until allowed", () => {
		return started().then((dev) => {
			return expect(dev.command("set_current", { amps: 1 })).rejects.toThrow(/disabled until its unit is confirmed/)
				.then(() => {
					expect(sent).toEqual([]);
					return dev.stop();
				});
		});
	});
});
