const fs = require("fs");
const os = require("os");
const path = require("path");
const usb = require("..");

const write = (root, rel, content) => {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
};

// fixture sysfs: usb1 root hub → 1-1 hub (4 ports) → 1-1.2 cdc_acm serial with ttyACM0
const fixture = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-usb-"));
	const usbRoot = path.join(root, "usb");
	const pciRoot = path.join(root, "pci");
	write(usbRoot, "usb1/bDeviceClass", "09\n");
	write(usbRoot, "usb1/maxchild", "2\n");
	write(usbRoot, "usb1/product", "xHCI Host Controller\n");
	write(usbRoot, "1-1/bDeviceClass", "09\n");
	write(usbRoot, "1-1/product", "USB2.1 Hub\n");
	write(usbRoot, "1-1/uevent", "PRODUCT=5e3/610/9226\n");
	write(usbRoot, "1-1:1.0/uevent", "DRIVER=hub\nINTERFACE=9/0/1\n");
	[1, 2, 3, 4].forEach((n) => fs.mkdirSync(path.join(usbRoot, "1-1:1.0", "1-1-port" + n), { recursive: true }));
	write(usbRoot, "1-1.2/bDeviceClass", "02\n");
	write(usbRoot, "1-1.2/idVendor", "9ac4\n");
	write(usbRoot, "1-1.2/idProduct", "4b8f\n");
	write(usbRoot, "1-1.2/product", "proxmark3\n");
	write(usbRoot, "1-1.2/speed", "12\n");
	write(usbRoot, "1-1.2:1.0/uevent", "DRIVER=cdc_acm\n");
	fs.mkdirSync(path.join(usbRoot, "1-1.2:1.0", "tty", "ttyACM0"), { recursive: true });
	write(usbRoot, "1-1.2:1.1/uevent", "DRIVER=cdc_ether\n");
	fs.mkdirSync(path.join(usbRoot, "1-1.2:1.1", "net", "usb0"), { recursive: true });
	write(pciRoot, "0000:00:14.0/uevent", "DRIVER=xhci_hcd\nPCI_CLASS=C0330\nPCI_ID=8086:A36D\n");
	fs.mkdirSync(path.join(pciRoot, "0000:00:14.0", "usb1"), { recursive: true });
	write(pciRoot, "0000:00:02.0/uevent", "PCI_CLASS=30000\n");
	return { root: root, usbRoot: usbRoot, pciRoot: pciRoot };
};

describe("usb inventory", () => {
	test("helpers ported from proxyslave", () => {
		expect(usb.parseUevent("DRIVER=hub\nPRODUCT=1/2/3\nX=a=b")).toEqual({ DRIVER: "hub", PRODUCT: "1/2/3", X: "a=b" });
		const ids = usb.parseIdsData("# c\n12d1  Huawei Technologies\n\t1001  Modem\n\t\t01  iface\n1d50  OpenMoko\nC 00  class\n");
		expect(ids["12d1"].name).toBe("Huawei");
		expect(ids["12d1"].products["1001"].name).toBe("Modem");
		expect(ids["1d50"].name).toBe("OpenMoko");
		expect(ids.C).toBeUndefined();
		expect(usb.parentOf("1-2")).toEqual({ parent: "usb1", port: 2 });
		expect(usb.parentOf("8-1.3.2")).toEqual({ parent: "8-1.3", port: 2 });
	});

	test("tree from a sysfs fixture", () => {
		const f = fixture();
		const inv = usb.inventory({ usbRoot: f.usbRoot, pciRoot: f.pciRoot });
		expect(inv.controllers.map((c) => [c.id, c.driver, c.buses])).toEqual([["0000:00:14.0", "xhci_hcd", ["usb1"]]]);
		expect(inv.buses.length).toBe(1);
		const hub = inv.buses[0].ports[0].device;
		expect(hub.name).toBe("1-1");
		expect(hub.vid).toBe("05e3");
		expect(hub.portCount).toBe(4);
		expect(hub.ports.length).toBe(4);
		const pm3 = hub.ports[1].device;
		expect(pm3).toMatchObject({ name: "1-1.2", product: "proxmark3", speed: "12", drivers: ["cdc_acm", "cdc_ether"], nodes: ["/dev/ttyACM0"] });
		expect(pm3.networks.map((n) => n.name)).toEqual(["usb0"]);
		expect(hub.ports[0].device).toBeNull();
		fs.rmSync(f.root, { recursive: true, force: true });
	});

	test("uhubctl status parsing and power validation", () => {
		const hubs = usb.parseUhubctl([
			"Current status for hub 1-1 [05e3:0610 GenesysLogic USB2.1 Hub, USB 2.10, 4 ports, ppps]",
			"  Port 1: 0100 power",
			"  Port 2: 0103 power enable connect [9ac4:4b8f proxmark.org proxmark3]",
			"  Port 3: 0000 off",
			"Current status for hub 2 [1d6b:0003 xHCI, USB 3.00, 2 ports, nops]",
			"  Port 1: 02a0 power 5gbps Rx.Detect"
		].join("\n"));
		expect(hubs["1-1"].ppps).toBe(true);
		expect(hubs["1-1"].ports["2"]).toMatchObject({ power: true, connect: true });
		expect(hubs["1-1"].ports["3"].power).toBe(false);
		expect(hubs["2"].ppps).toBe(false);
		return Promise.all([
			expect(usb.setPower("1-1", 2, "explode")).rejects.toThrow(/action/),
			expect(usb.setPower("1-1; rm -rf /", 2, "on")).rejects.toThrow(/bad/)
		]);
	});
});
