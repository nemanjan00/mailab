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

describe("tabs and collapse", () => {
	const panesModule = require("..");

	test("panes live on tabs; free spots are per tab; old panes get the default tab", () => {
		let changes = 0;
		const layout = panesModule.create([{ id: "old", type: "log", title: "log", config: {}, x: 0, y: 0, w: 6, h: 4 }], () => changes++, undefined);
		expect(layout.get("old").tab).toBe("main");
		const a = layout.add({ type: "log", tab: "rf" });
		// an empty tab starts at the top, not below main's panes
		expect([a.x, a.y, a.tab]).toEqual([0, 0, "rf"]);
		const b = layout.add({ type: "log" });
		expect(b.tab).toBe("main");
		expect(layout.tabs()).toEqual(["main", "rf"]);
		expect(changes).toBe(2);
	});

	test("add, rename, order, remove (panes move), collapse, move between tabs", () => {
		const layout = panesModule.create([], () => null, ["main"]);
		layout.add({ id: "p1", type: "log", tab: "main", w: 12, h: 3 });
		layout.add({ id: "p2", type: "log", tab: "power" });
		expect(layout.addTab("glitch")).toEqual(["main", "power", "glitch"]);
		expect(layout.renameTab("power", "psu")).toEqual(["main", "psu", "glitch"]);
		expect(layout.get("p2").tab).toBe("psu");
		expect(() => layout.renameTab("psu", "main")).toThrow(/exists/);
		expect(() => layout.addTab("")).toThrow(/tab names/);
		expect(() => layout.addTab("bad\u0007")).toThrow(/tab names/);
		expect(layout.orderTabs(["glitch", "main"])).toEqual(["glitch", "main", "psu"]);
		const removed = layout.removeTab("psu", "main");
		expect(removed.moved).toEqual(["p2"]);
		// moved below what's on the target tab
		expect(layout.get("p2")).toMatchObject({ tab: "main", y: 3 });
		expect(layout.update("p1", { collapsed: true }).collapsed).toBe(true);
		const moved = layout.update("p1", { tab: "glitch" });
		expect([moved.tab, moved.x, moved.y]).toEqual(["glitch", 0, 0]);
		expect(() => layout.removeTab("nope")).toThrow(/unknown tab/);
		layout.replaceAll([{ type: "log", tab: "x" }], ["x", "y"]);
		expect(layout.tabs()).toEqual(["x", "y"]);
	});
});
