const channelsModule = require("..");

describe("channels", () => {
	test("ring buffer keeps the newest samples in order", () => {
		const store = channelsModule.create(3);
		store.ensure("v", { unit: "V" });
		[1, 2, 3, 4, 5].forEach((v) => {
			store.push("v", v * 1000, v);
		});
		expect(store.read("v")).toEqual({ t: [3000, 4000, 5000], v: [3, 4, 5] });
		expect(store.latest("v")).toEqual({ t: 5000, v: 5 });
		expect(store.describe("v").unit).toBe("V");
	});

	test("read filters by since and last", () => {
		const store = channelsModule.create(10);
		store.ensure("x");
		[1, 2, 3, 4].forEach((v) => {
			store.push("x", v, v);
		});
		expect(store.read("x", { since: 2 }).v).toEqual([3, 4]);
		expect(store.read("x", { last: 1 }).v).toEqual([4]);
	});

	test("rejects invalid names and sanitizes labels", () => {
		const store = channelsModule.create(10);
		expect(() => {
			store.ensure("a b");
		}).toThrow(/invalid channel name/);
		expect(channelsModule.sanitizeName("A0 V")).toBe("A0_V");
		expect(channelsModule.sanitizeName("1x")).toBe("_1x");
	});
});
