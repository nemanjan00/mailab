const txpolicy = require("../index");

const EU_433 = 433920000;
const EU_868 = 868300000;

const fgInstance = (params) => {
	return {
		driver: "flowgraph",
		options: {
			graph: {
				blocks: [{ id: "s", type: "soapy_sink", params: params || { freq: "433.92M", gain: 30, rate: 2e6 } }],
				links: []
			}
		}
	};
};

describe("txpolicy.caps", () => {
	test("defaults", () => {
		expect(txpolicy.caps()).toEqual({ maxGainDb: 40, maxSeconds: 120 });
	});

	test("env overrides", () => {
		const keep = ["MAILAB_RF_TX_MAX_GAIN", "MAILAB_RF_TX_MAX_SECONDS"].map((key) => {
			return [key, process.env[key]];
		});
		process.env.MAILAB_RF_TX_MAX_GAIN = "12";
		process.env.MAILAB_RF_TX_MAX_SECONDS = "5";
		try {
			expect(txpolicy.caps()).toEqual({ maxGainDb: 12, maxSeconds: 5 });
		} finally {
			keep.forEach(([key, value]) => {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			});
		}
	});
});

describe("txpolicy.plan", () => {
	test("ignores non-TX commands", () => {
		expect(txpolicy.plan({ driver: "hackrf" }, "configure", {})).toBe(null);
		expect(txpolicy.plan(fgInstance(), "run", { on: false })).toBe(null);
		expect(txpolicy.plan({ driver: "flowgraph", options: { graph: { blocks: [], links: [] } } }, "run", { on: true })).toBe(null);
	});

	test("hackrf transmit", () => {
		const intent = txpolicy.plan({ driver: "hackrf" }, "transmit", { freqHz: EU_433, gain: 30, seconds: 10 });
		expect(intent.freqHz).toBe(EU_433);
		expect(intent.gainDb).toBe(30);
		expect(intent.seconds).toBe(10);
		expect(intent.what).toMatch(/hackrf\.transmit @ 433\.920 MHz/);
	});

	test("rfcat tx takes the frequency from device options and ms from timeoutMs", () => {
		const inst = { driver: "rfcat", options: { freq: EU_868 } };
		const intent = txpolicy.plan(inst, "tx", { timeoutMs: 500 });
		expect(intent.freqHz).toBe(EU_868);
		expect(intent.seconds).toBe(0.5);
		expect(intent.what).toMatch(/rfcat\.tx @ 868\.300 MHz/);
	});

	test("flowgraph run scans soapy_sink blocks, engineering-suffix freq parses", () => {
		const intent = txpolicy.plan(fgInstance(), "run", { on: true });
		expect(intent.kind).toBe("flowgraph");
		expect(intent.freqHz).toBe(EU_433);
		expect(intent.gainDb).toBe(30);
	});

	test("flowgraph set_param on a soapy_sink freq/gain is a TX intent", () => {
		const intent = txpolicy.plan(fgInstance(), "set_param", { block: "s", key: "freq", value: "434.5M" });
		expect(intent.freqHz).toBe(434500000);
		expect(txpolicy.plan(fgInstance(), "set_param", { block: "s", key: "amp", value: 1 })).toBe(null);
	});
});

describe("txpolicy.checkBand", () => {
	const keep = ["MAILAB_RF_REGION", "MAILAB_RF_TX_EXTRA", "MAILAB_UNSAFE", "MAILAB_RF_CHAMBER"].map((key) => {
		return [key, process.env[key]];
	});
	afterEach(() => {
		keep.forEach(([key, value]) => {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		});
	});

	test("EU region accepts 433.92 MHz, refuses out-of-band", () => {
		process.env.MAILAB_RF_REGION = "eu";
		process.env.MAILAB_RF_TX_EXTRA = "";
		expect(txpolicy.checkBand({ freqHz: EU_433 }).ok).toBe(true);
		const bad = txpolicy.checkBand({ freqHz: 915e6 });
		expect(bad.ok).toBe(false);
		expect(bad.reason).toMatch(/915 MHz is outside/);
	});

	test("MAILAB_RF_TX_EXTRA opens person-configured bands", () => {
		process.env.MAILAB_RF_REGION = "eu";
		process.env.MAILAB_RF_TX_EXTRA = "144M-146M";
		expect(txpolicy.checkBand({ freqHz: 145e6 }).ok).toBe(true);
		expect(txpolicy.checkBand({ freqHz: 147e6 }).ok).toBe(false);
	});

	test("chamber / unsafe bypass allows everything", () => {
		process.env.MAILAB_RF_REGION = "eu";
		process.env.MAILAB_UNSAFE = "1";
		expect(txpolicy.checkBand({ freqHz: 2.4e9 }).ok).toBe(true);
	});

	test("region none refuses everything except extras", () => {
		process.env.MAILAB_RF_REGION = "none";
		process.env.MAILAB_RF_TX_EXTRA = "144M-146M";
		expect(txpolicy.checkBand({ freqHz: EU_433 }).ok).toBe(false);
		expect(txpolicy.checkBand({ freqHz: 145e6 }).ok).toBe(true);
	});
});

describe("txpolicy.clampSeconds", () => {
	test("0 (until stopped) clamps to the full cap", () => {
		expect(txpolicy.clampSeconds(0).seconds).toBe(120);
		expect(txpolicy.clampSeconds(10000).seconds).toBe(120);
		expect(txpolicy.clampSeconds(30).seconds).toBe(30);
		expect(txpolicy.clampSeconds(undefined).seconds).toBe(120);
	});
});
