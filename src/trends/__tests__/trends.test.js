const fs = require("fs");
const os = require("os");
const path = require("path");
const trendsModule = require("..");

const H = 3600000;

describe("trends", () => {
	const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mailab-trends-"));

	test("aggregates min/max/mean and picks the tier that fits the range", () => {
		const tr = trendsModule.create(dir());
		const now = Date.now();
		// 10 hours of a charging curve, one sample per 10 s
		for (let t = now - 10 * H; t <= now; t += 10000) {
			tr.sample("bat_v", t, 3.0 + 1.2 * (1 - Math.exp(-(t - (now - 10 * H)) / (3 * H))));
		}
		// finest tier covering the range, merged down to the point budget
		const hour = tr.read("bat_v", { from: now - H, to: now, points: 1000 });
		expect(hour.tier).toBe("1s");
		expect(hour.t.length).toBeGreaterThan(355);
		const day = tr.read("bat_v", { from: now - 10 * H, to: now, points: 1000 });
		expect(day.tier).toBe("10s ×4");
		expect(day.t.length).toBeGreaterThan(890);
		expect(day.mean[0]).toBeLessThan(day.mean[day.mean.length - 1]);
		day.t.forEach((_, i) => {
			expect(day.min[i]).toBeLessThanOrEqual(day.mean[i]);
			expect(day.max[i]).toBeGreaterThanOrEqual(day.mean[i]);
		});
	});

	test("only recorded channels are kept", () => {
		const tr = trendsModule.create(dir(), { patterns: ["psu_*"] });
		tr.sample("psu_v", Date.now(), 5);
		tr.sample("scope_ch1", Date.now(), 1);
		expect(tr.channels()).toEqual(["psu_v"]);
	});

	test("late samples merge into their bucket", () => {
		const tr = trendsModule.create(dir());
		const t0 = Math.floor(Date.now() / 60000) * 60000 - 5 * 60000;
		tr.sample("x_v", t0, 1);
		tr.sample("x_v", t0 + 120000, 2);
		tr.sample("x_v", t0 + 1000, 9);
		const r = tr.read("x_v", { from: t0 - 1, to: t0 + 200000, points: 10, tier: "1m" });
		expect(r.tier).toBe("1m");
		expect(r.max[0]).toBe(9);
	});

	test("history survives a restart", () => {
		const d = dir();
		const a = trendsModule.create(d);
		const now = Date.now();
		for (let t = now - 2 * H; t <= now - 3 * 60000; t += 30000) {
			a.sample("psu_i", t, 0.5);
		}
		a.flush();
		const b = trendsModule.create(d);
		const r = b.read("psu_i", { from: now - 2 * H, to: now, points: 500 });
		expect(r.t.length).toBeGreaterThan(100);
		expect(r.mean.every((v) => Math.abs(v - 0.5) < 1e-9)).toBe(true);
	});
});
