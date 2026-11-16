// Morfeus driver against a fake HID transport (no hardware attached). Covers
// the verified register protocol, freq/level/output round-trips, status
// parsing, the RF band gate (out-of-band refused, in-band allowed, chamber
// bypass), approval gating via the lab safety policy, and strict parsing.

const EventEmitter = require("events");
const morfeus = require("..");
const safety = require("../../../safety");

const CMD_SET = 0x77;
const REG_FREQ = 0x81;
const REG_FUNC = 0x82;
const REG_CURRENT = 0x83;

// A fake hidraw transport: stores register writes and answers reads with the
// last-addressed register's value (value at bytes [2:10], as tai/morfeus).
const makeFake = () => {
	const store = {};
	const writes = [];
	let lastReg = REG_FREQ;
	return {
		store: store,
		writes: writes,
		write: (buffer) => {
			const mode = buffer[1];
			const reg = buffer[2];
			const value = Number(buffer.readBigUInt64BE(3));
			lastReg = reg;
			if (mode === CMD_SET) {
				store[reg] = value;
			}
			writes.push({ mode: mode, reg: reg, value: value });
		},
		read: () => {
			const response = Buffer.alloc(16);
			response[1] = lastReg;
			response.writeBigUInt64BE(BigInt(store[lastReg] || 0), 2);
			return Promise.resolve(response);
		},
		close: () => {}
	};
};

const makeDriver = (options) => {
	const fake = makeFake();
	const samples = {};
	const values = {};
	// the real lab io prefixes channel/value names with the device id
	const io = {
		id: "mrf",
		sample: (name, value) => {
			samples["mrf_" + name] = value;
		},
		value: (name, value) => {
			values["mrf_" + name] = value;
		},
		log: () => {},
		status: () => {}
	};
	const driver = morfeus.create(Object.assign({ path: "fake0", _openTransport: () => fake }, options), io);
	return { driver: driver, fake: fake, samples: samples, values: values };
};

const setsFor = (fake, reg) => {
	return fake.writes.filter((w) => w.mode === CMD_SET && w.reg === reg);
};

describe("morfeus driver", () => {
	const savedEnv = {};
	const ENV = ["MAILAB_RF_REGION", "MAILAB_RF_CHAMBER", "MAILAB_UNSAFE"];

	beforeEach(() => {
		ENV.forEach((k) => {
			savedEnv[k] = process.env[k];
		});
		process.env.MAILAB_RF_REGION = "eu";
		delete process.env.MAILAB_RF_CHAMBER;
		delete process.env.MAILAB_UNSAFE;
	});

	afterEach(() => {
		ENV.forEach((k) => {
			if (savedEnv[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = savedEnv[k];
			}
		});
	});

	test("buildReport encodes the verified SET layout; parseValue round-trips", () => {
		const report = morfeus._buildReport(CMD_SET, REG_FREQ, 433920000);
		expect(report.length).toBe(17);
		expect(report[0]).toBe(0x00); // report id
		expect(report[1]).toBe(CMD_SET);
		expect(report[2]).toBe(REG_FREQ);
		expect(Number(report.readBigUInt64BE(3))).toBe(433920000);

		const response = Buffer.alloc(16);
		response.writeBigUInt64BE(BigInt(123456789), 2);
		expect(morfeus._parseValue(response)).toBe(123456789);
	});

	test("parseChannel accepts 0/1 and A/B, rejects the rest", () => {
		expect(morfeus._parseChannel(0, 2)).toBe(0);
		expect(morfeus._parseChannel("B", 2)).toBe(1);
		expect(morfeus._parseChannel("1", 2)).toBe(1);
		expect(() => morfeus._parseChannel("C", 2)).toThrow(/channel/);
		expect(() => morfeus._parseChannel(1, 1)).toThrow(/out of range/);
	});

	test("set_freq writes register 0x81 and reports the channel", () => {
		const h = makeDriver();
		return h.driver.start()
			.then(() => h.driver.command("set_freq", { channel: 0, hz: 433920000 }))
			.then((res) => {
				expect(res).toEqual({ channel: 0, hz: 433920000 });
				expect(h.fake.store[REG_FREQ]).toBe(433920000);
				expect(h.samples.mrf_ch0_freq).toBe(433920000);
			});
	});

	test("set_level writes register 0x83 and validates 0-7", () => {
		const h = makeDriver();
		return h.driver.start()
			.then(() => h.driver.command("set_level", { channel: 0, level: 3 }))
			.then((res) => {
				expect(res).toEqual({ channel: 0, level: 3 });
				expect(h.fake.store[REG_CURRENT]).toBe(3);
				return expect(h.driver.command("set_level", { channel: 0, level: 8 })).rejects.toThrow(/limit/);
			});
	});

	test("output on in band writes GENERATOR + level and marks the channel on", () => {
		const h = makeDriver();
		return h.driver.start()
			.then(() => h.driver.command("set_freq", { channel: 0, hz: 433920000 }))
			.then(() => h.driver.command("set_level", { channel: 0, level: 5 }))
			.then(() => h.driver.command("output", { channel: 0, on: true }))
			.then((res) => {
				expect(res).toEqual({ channel: 0, on: true });
				expect(h.fake.store[REG_FUNC]).toBe(1); // GENERATOR
				expect(h.fake.store[REG_CURRENT]).toBe(5);
				expect(h.values.mrf_ch0_on).toBe(true);
			});
	});

	test("output on out of band is refused and nothing keys the generator", () => {
		const h = makeDriver();
		return h.driver.start()
			.then(() => h.driver.command("set_freq", { channel: 0, hz: 100000000 })) // 100 MHz, out of EU bands
			.then(() => {
				return expect(h.driver.command("output", { channel: 0, on: true })).rejects.toThrow(/outside the allowed/);
			})
			.then(() => {
				expect(setsFor(h.fake, REG_FUNC)).toEqual([]); // GENERATOR never written
			});
	});

	test("chamber bypass allows any frequency on the air", () => {
		process.env.MAILAB_RF_CHAMBER = "1";
		const h = makeDriver();
		return h.driver.start()
			.then(() => h.driver.command("set_freq", { channel: 0, hz: 100000000 }))
			.then(() => h.driver.command("output", { channel: 0, on: true }))
			.then((res) => {
				expect(res.on).toBe(true);
				expect(h.fake.store[REG_FUNC]).toBe(1);
			});
	});

	test("output off selects MIXER + level 0 (no approval, no band check)", () => {
		const h = makeDriver();
		return h.driver.start()
			.then(() => h.driver.command("output", { channel: 0, on: false }))
			.then((res) => {
				expect(res).toEqual({ channel: 0, on: false });
				expect(h.fake.store[REG_FUNC]).toBe(0); // MIXER
				expect(h.fake.store[REG_CURRENT]).toBe(0);
			});
	});

	test("status reads freq/level back from the device", () => {
		const h = makeDriver();
		h.fake.store[REG_FREQ] = 868000000;
		h.fake.store[REG_CURRENT] = 4;
		return h.driver.start()
			.then(() => h.driver.command("status", {}))
			.then((res) => {
				expect(res.channels[0].freq).toBe(868000000);
				expect(res.channels[0].level).toBe(4);
				expect(h.samples.mrf_ch0_freq).toBe(868000000);
			});
	});

	test("sweep refused up front when a step is out of band (no RF emitted)", () => {
		const h = makeDriver();
		return h.driver.start()
			.then(() => {
				// 100-110 MHz is outside EU bands
				return expect(h.driver.command("sweep", { channel: 0, start: 100000000, stop: 110000000, points: 3 }))
					.rejects.toThrow(/outside the allowed/);
			})
			.then(() => {
				expect(setsFor(h.fake, REG_FREQ)).toEqual([]);
				expect(setsFor(h.fake, REG_FUNC)).toEqual([]);
			});
	});

	test("sweep in band steps the frequency and leaves output off", () => {
		const h = makeDriver();
		return h.driver.start()
			.then(() => h.driver.command("sweep", { channel: 0, start: 433100000, stop: 434700000, points: 3, dwell_ms: 0 }))
			.then((res) => {
				expect(res.count).toBe(3);
				// three frequency steps written
				expect(setsFor(h.fake, REG_FREQ).map((w) => w.value)).toEqual([433100000, 433900000, 434700000]);
				// ended with output off: last func write is MIXER
				expect(h.fake.store[REG_FUNC]).toBe(0);
				expect(h.values.mrf_ch0_on).toBe(false);
			});
	});

	test("strict parsing: bad numbers and switches are refused", () => {
		const h = makeDriver();
		return h.driver.start()
			.then(() => expect(h.driver.command("set_freq", { channel: 0, hz: "abc" })).rejects.toThrow(/must be a number/))
			.then(() => expect(h.driver.command("set_freq", { channel: 0, hz: 1000 })).rejects.toThrow(/below the minimum/))
			.then(() => expect(h.driver.command("output", { channel: 0, on: "maybe" })).rejects.toThrow(/true\/false/))
			.then(() => expect(h.driver.command("bogus", {})).rejects.toThrow(/unknown command/));
	});

	test("safety policy gates output-on, sweep and max level, not reads/low level", () => {
		const s = safety.create({}, {});
		const ask = (command, args) => s.needsApproval("mrf", "morfeus", command, args);
		expect(ask("output", { channel: 0, on: true })).not.toBeNull();
		expect(ask("output", { channel: 0, on: false })).toBeNull();
		expect(ask("sweep", { channel: 0, start: 1, stop: 2 })).not.toBeNull();
		expect(ask("set_level", { channel: 0, level: 7 })).not.toBeNull();
		expect(ask("set_level", { channel: 0, level: 3 })).toBeNull();
		expect(ask("set_freq", { channel: 0, hz: 433920000 })).toBeNull();
		expect(ask("status", {})).toBeNull();
	});

	test("a denied AI output-on sends nothing to the device", () => {
		const events = new EventEmitter();
		const lab = {
			events: events,
			recordActivity: () => {},
			postChat: () => {},
			notify: () => {}
		};
		const s = safety.create(lab, {});
		const h = makeDriver();

		// mimic the mcp gate: check policy, request approval, deny, never command
		const gated = (command, args) => {
			const rule = s.needsApproval("mrf", "morfeus", command, args);
			if (!rule) {
				return h.driver.command(command, args);
			}
			const approval = s.requestApproval({ who: "ai", device: "mrf", command: command, args: args, reason: rule.reason });
			// a person denies it
			s.decide(s.listPending()[0].id, "denied", "human");
			return approval.then(() => h.driver.command(command, args));
		};

		return h.driver.start()
			.then(() => h.driver.command("set_freq", { channel: 0, hz: 433920000 }))
			.then(() => {
				const before = h.fake.writes.length;
				return gated("output", { channel: 0, on: true })
					.then(() => Promise.reject(new Error("should have been denied")))
					.catch((err) => {
						expect(err.message).toMatch(/not approved/);
						expect(h.fake.writes.length).toBe(before); // nothing sent after the denial
						expect(setsFor(h.fake, REG_FUNC)).toEqual([]);
					});
			});
	});
});
