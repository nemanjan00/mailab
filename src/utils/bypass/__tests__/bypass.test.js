const bypass = require("..");

const ENV = ["MAILAB_RF_CHAMBER", "MAILAB_UNSAFE", "MAILAB_UNSAFE_PSU"];

describe("safety bypass (env-only)", () => {
	let saved;

	beforeEach(() => {
		saved = {};
		ENV.forEach((key) => {
			saved[key] = process.env[key];
			delete process.env[key];
		});
	});

	afterEach(() => {
		ENV.forEach((key) => {
			if (saved[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = saved[key];
			}
		});
	});

	test("off by default", () => {
		expect(bypass.active()).toBe(false);
		expect(bypass.psuUnsafe()).toBe(false);
		expect(bypass.describe()).toBe(null);
		expect(bypass.info()).toEqual({ active: false, psuUnsafe: false, text: null });
	});

	test("MAILAB_RF_CHAMBER and MAILAB_UNSAFE both activate it (truthy values)", () => {
		process.env.MAILAB_RF_CHAMBER = "1";
		expect(bypass.active()).toBe(true);
		expect(bypass.describe()).toMatch(/SAFETY BYPASSED/);
		delete process.env.MAILAB_RF_CHAMBER;

		process.env.MAILAB_UNSAFE = "yes";
		expect(bypass.active()).toBe(true);
		expect(bypass.info().text).toMatch(/MAILAB_UNSAFE/);
	});

	test("garbage values do not activate it", () => {
		process.env.MAILAB_RF_CHAMBER = "0";
		expect(bypass.active()).toBe(false);
		process.env.MAILAB_UNSAFE = "off";
		expect(bypass.active()).toBe(false);
	});

	test("MAILAB_UNSAFE_PSU is an independent opt-out: inert alone, lifts PSU caps on top of the bypass", () => {
		process.env.MAILAB_UNSAFE_PSU = "1";
		expect(bypass.active()).toBe(false);
		expect(bypass.psuUnsafe()).toBe(false);

		process.env.MAILAB_RF_CHAMBER = "1";
		expect(bypass.active()).toBe(true);
		expect(bypass.psuUnsafe()).toBe(true);
		expect(bypass.info().psuUnsafe).toBe(true);
	});

	test("isTruthy matches the config/env reading used everywhere", () => {
		expect(bypass.isTruthy("1")).toBe(true);
		expect(bypass.isTruthy("TRUE")).toBe(true);
		expect(bypass.isTruthy("on")).toBe(true);
		expect(bypass.isTruthy("0")).toBe(false);
		expect(bypass.isTruthy("")).toBe(false);
		expect(bypass.isTruthy(undefined)).toBe(false);
	});
});
