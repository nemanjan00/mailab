const batch = require("..");

const recorder = () => {
	const calls = [];
	const invoke = (tool, args) => {
		calls.push({ tool: tool, args: args });
		if (tool === "fail") {
			return Promise.reject(new Error("boom"));
		}
		return Promise.resolve({ echo: args, n: calls.length });
	};
	return { calls: calls, invoke: invoke };
};

describe("batch", () => {
	test("runs steps in order and passes named results", () => {
		const r = recorder();
		return batch.run([
			{ tool: "a", args: { x: 1 }, name: "first" },
			{ tool: "b", args: { prev: "$first.echo.x", whole: "$first.n", literal: "$nope" } }
		], {}, r.invoke).then((out) => {
			expect(out.ok).toBe(true);
			expect(r.calls[1].args).toEqual({ prev: 1, whole: 1, literal: "$nope" });
			expect(out.calls.map((c) => c.tool)).toEqual(["a", "b"]);
		});
	});

	test("loop substitutes the loop variable", () => {
		const r = recorder();
		return batch.run([{ tool: "set", args: { volts: "$v" } }], { loop: { var: "v", values: [1, 2, 3] } }, r.invoke).then(() => {
			expect(r.calls.map((c) => c.args.volts)).toEqual([1, 2, 3]);
		});
	});

	test("timing: at, delayMs and repeat/intervalMs", () => {
		const r = recorder();
		return batch.run([
			{ tool: "a", at: 30 },
			{ tool: "b", delayMs: 20 },
			{ tool: "c", repeat: 3, intervalMs: 15 }
		], {}, r.invoke).then((out) => {
			const t = out.calls.map((c) => c.t);
			expect(t[0]).toBeGreaterThanOrEqual(30);
			expect(t[0]).toBeLessThan(40);
			expect(t[1] - t[0]).toBeGreaterThanOrEqual(20);
			expect(t[3] - t[2]).toBeGreaterThanOrEqual(15);
			expect(t[3] - t[2]).toBeLessThan(25);
			expect(t[4] - t[3]).toBeGreaterThanOrEqual(15);
		});
	});

	test("stops on error by default, continues when asked", () => {
		const r1 = recorder();
		return batch.run([{ tool: "fail" }, { tool: "after" }], {}, r1.invoke).then((out) => {
			expect(out.ok).toBe(false);
			expect(r1.calls.map((c) => c.tool)).toEqual(["fail"]);
			const r2 = recorder();
			return batch.run([{ tool: "fail" }, { tool: "after" }], { stopOnError: false }, r2.invoke);
		}).then((out) => {
			expect(out.calls.map((c) => c.ok)).toEqual([false, true]);
		});
	});
});
