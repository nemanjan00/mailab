const panesModule = require("..");

describe("panes", () => {
	test("packs new panes into free space", () => {
		const layout = panesModule.create([], () => {});
		const a = layout.add({ type: "chart", w: 6, h: 4 });
		const b = layout.add({ type: "chart", w: 6, h: 4 });
		const c = layout.add({ type: "chart", w: 12, h: 2 });
		expect([a.x, a.y]).toEqual([0, 0]);
		expect([b.x, b.y]).toEqual([6, 0]);
		expect([c.x, c.y]).toEqual([0, 4]);
	});

	test("update merges config, arrange moves panes", () => {
		const changes = jest.fn();
		const layout = panesModule.create([], changes);
		const pane = layout.add({ type: "chart", config: { channels: ["a"], seconds: 10 } });
		const updated = layout.update(pane.id, { config: { seconds: 60 } });
		expect(updated.config).toEqual({ channels: ["a"], seconds: 60 });
		layout.arrange([{ id: pane.id, x: 3, y: 2, w: 4, h: 4 }]);
		expect(layout.get(pane.id)).toMatchObject({ x: 3, y: 2, w: 4, h: 4 });
		expect(changes).toHaveBeenCalledTimes(3);
	});

	test("rejects unknown types", () => {
		const layout = panesModule.create([], () => {});
		expect(() => {
			layout.add({ type: "nope" });
		}).toThrow(/unknown pane type/);
	});
});
