const udevModule = require("..");

const dev = (name, extra) => Object.assign({ name: name, vid: "9ac4", pid: "4b8f", product: "proxmark3", drivers: ["cdc_acm"], nodes: ["/dev/ttyACM0"] }, extra || {});
const bus = (devices) => [{ name: "usb8", hub: true, ports: devices.map((d, i) => ({ port: i + 1, device: d })) }];

describe("udev rules", () => {
	test("glob match on fields, drivers and nodes", () => {
		const ev = { action: "add", device: udevModule.flatten(bus([dev("8-1")]))["8-1"] };
		expect(udevModule.matchRule({ match: { vid: "9AC4", node: "/dev/ttyACM*" } }, ev)).toBe(true);
		expect(udevModule.matchRule({ match: { product: "proxmark*", driver: "cdc_*" } }, ev)).toBe(true);
		expect(udevModule.matchRule({ action: "remove", match: { vid: "9ac4" } }, ev)).toBe(false);
		expect(udevModule.matchRule({ match: { serial: "x" } }, ev)).toBe(false);
		expect(udevModule.matchRule({ match: { path: "8-*" } }, ev)).toBe(true);
	});

	test("polls raise notifications for add, change and remove", () => {
		let devices = [];
		const notes = [];
		const changes = [];
		const u = udevModule.create({ scan: () => bus(devices), notify: (ev) => notes.push(ev), onChange: () => changes.push(1) });
		const r = u.add({ name: "pm3", match: { vid: "9ac4" } });
		u.add({ action: "remove", match: { product: "other" } });
		expect(changes.length).toBe(2);
		u.poll();
		expect(notes).toEqual([]);
		devices = [dev("8-1", { nodes: [] }), dev("8-2", { vid: "1234", product: "other" })];
		u.poll();
		expect(notes.map((n) => [n.rule, n.action, n.usb.path])).toEqual([[r.id, "add", "8-1"]]);
		devices = [dev("8-1")];
		u.poll();
		expect(notes.slice(1).map((n) => [n.action, n.usb.path])).toEqual([["change", "8-1"], ["remove", "8-2"]]);
		expect(notes.length).toBe(3);
		expect(notes[2].action).toBe("remove");
		expect(notes[2].usb.product).toBe("other");
		devices = [];
		u.poll();
		expect(notes[3]).toMatchObject({ type: "udev", rule: r.id, action: "remove" });
		u.remove(r.id);
		expect(u.list().length).toBe(1);
		expect(() => u.remove(r.id)).toThrow();
		expect(() => u.add({ action: "bogus" })).toThrow();
	});
});
