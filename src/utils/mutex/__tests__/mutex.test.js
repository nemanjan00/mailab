const serialize = require("..").serialize;

describe("serialize", () => {
	test("runs calls one at a time in order, even when some fail", () => {
		const log = [];
		const work = serialize((id, ms, fail) => new Promise((resolve, reject) => {
			log.push("start " + id);
			setTimeout(() => {
				log.push("end " + id);
				if (fail) {
					reject(new Error("x"));
				} else {
					resolve(id);
				}
			}, ms);
		}));
		return Promise.all([work(1, 20), work(2, 1, true).catch(() => "failed"), work(3, 1)]).then((results) => {
			expect(results).toEqual([1, "failed", 3]);
			expect(log).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
		});
	});

	test("generic lock form", () => {
		const lock = serialize();
		return lock(() => Promise.resolve(5)).then((v) => expect(v).toBe(5));
	});
});
