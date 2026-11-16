// USB inventory, ported from proxyslave's (~/projects/proxy/slave
// src/inventory): PCI USB controllers → buses → ports (sysfs paths like
// "1-2.3") → interfaces ("subsystems") with their bound drivers, network
// interfaces, hub port counts from the `-port` entries, names from
// usb.ids/pci.ids. Added for mailab: /dev nodes per device (tty, video,
// hidraw) and per-port power via uhubctl on switchable hubs.

const fs = require("fs");
const os = require("os");
const path = require("path");
const execFile = require("child_process").execFile;

const USB_DEVICES = "/sys/bus/usb/devices";
const PCI_DEVICES = "/sys/bus/pci/devices";
const USB_IDS = "/usr/share/hwdata/usb.ids";
const PCI_IDS = "/usr/share/hwdata/pci.ids";

// PCI_CLASS_SERIAL_USB_{UHCI,OHCI,EHCI,XHCI}
const USB_CONTROLLER_CLASSES = [0x0c0300, 0x0c0310, 0x0c0320, 0x0c0330];
const NODE_DIRS = ["tty", "video4linux", "hidraw"];

// ---- helpers (proxyslave src/inventory/helpers) --------------------------------

const parseUevent = (data) => {
	const properties = {};
	String(data).trim().split("\r").join("").split("\n").forEach((property) => {
		const segments = property.split("=");
		properties[segments[0]] = segments.slice(1).join("=");
	});
	return properties;
};

const parseIdsData = (data) => {
	const vendors = {};
	let currentVendor;
	String(data).trim().split("\r").join("").split("\n")
		.filter((line) => line.trim() !== "")
		.forEach((line) => {
			if (line.charAt(0) === "#") {
				return;
			}
			if (line.charAt(0) !== "\t") {
				const segments = line.trim().split(" ");
				currentVendor = segments[0];
				vendors[currentVendor] = { id: currentVendor, name: segments.slice(1).join(" ").trim(), products: {} };
				return;
			}
			if (line.charAt(1) !== "\t" && vendors[currentVendor]) {
				const segments = line.trim().split(" ");
				vendors[currentVendor].products[segments[0]] = { id: segments[0], name: segments.slice(1).join(" ").trim() };
			}
		});
	if (vendors["12d1"]) {
		vendors["12d1"].name = "Huawei";
	}
	// usb.ids appends device-class tables after the vendors
	delete vendors.C;
	return vendors;
};

const idsCache = {};
const idsFor = (file) => {
	if (idsCache[file] === undefined) {
		try {
			idsCache[file] = parseIdsData(fs.readFileSync(file, "utf8"));
		} catch (_err) {
			idsCache[file] = {};
		}
	}
	return idsCache[file];
};

const lookupName = (ids, vid, pid) => {
	const vendor = ids[vid];
	if (!vendor) {
		return null;
	}
	const product = vendor.products[pid];
	return vendor.name + (product ? " " + product.name : "");
};

const read = (dir, file) => {
	try {
		return fs.readFileSync(path.join(dir, file), "utf8").trim();
	} catch (_err) {
		return null;
	}
};

const list = (dir) => {
	try {
		return fs.readdirSync(dir);
	} catch (_err) {
		return [];
	}
};

// IPv4 addresses per interface (proxyslave network inventory, all interfaces)
const networks = () => {
	const out = {};
	const interfaces = os.networkInterfaces();
	Object.keys(interfaces).forEach((name) => {
		out[name] = interfaces[name].filter((a) => a.family === "IPv4" || a.family === 4).map((a) => a.address);
	});
	return out;
};

// ---- controllers (proxyslave src/inventory/pci + usb.getUSBControllers) ------------------

const controllers = (pciRoot) => {
	const ids = idsFor(PCI_IDS);
	return list(pciRoot).map((id) => {
		const uevent = parseUevent(read(path.join(pciRoot, id), "uevent") || "");
		const cls = parseInt(uevent.PCI_CLASS, 16);
		if (USB_CONTROLLER_CLASSES.indexOf(cls) === -1) {
			return null;
		}
		const pciId = (uevent.PCI_ID || ":").toLowerCase().split(":");
		return {
			id: id,
			driver: uevent.DRIVER,
			name: lookupName(ids, pciId[0].padStart(4, "0"), pciId[1].padStart(4, "0")) || "USB controller",
			buses: list(path.join(pciRoot, id)).filter((f) => f.indexOf("usb") === 0).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
		};
	}).filter(Boolean);
};

// ---- devices ---------------------------------------------------------------------------------

// interfaces ("subsystems") of a device: driver + /dev nodes + network interfaces
const subsystemsOf = (root, name, nets) => {
	return list(root).filter((e) => e.indexOf(name + ":") === 0).sort().map((iface) => {
		const dir = path.join(root, iface);
		const uevent = parseUevent(read(dir, "uevent") || "");
		const nodes = [];
		list(dir).forEach((child) => {
			if (/^tty(USB|ACM)\d+$/.test(child)) {
				nodes.push("/dev/" + child);
			}
			if (NODE_DIRS.indexOf(child) !== -1) {
				list(path.join(dir, child)).forEach((n) => nodes.push("/dev/" + n));
			}
		});
		const netNames = list(path.join(dir, "net"));
		return {
			name: iface,
			driver: uevent.DRIVER || null,
			class: uevent.INTERFACE || null,
			nodes: nodes,
			networks: netNames.map((n) => ({ name: n, address: nets[n] || [] }))
		};
	});
};

// "1-2.3" -> parent "1-2", port 3; "1-2" -> root "usb1", port 2
const parentOf = (name) => {
	const dash = name.indexOf("-");
	const tail = name.slice(dash + 1);
	const dot = tail.lastIndexOf(".");
	if (dot === -1) {
		return { parent: "usb" + name.slice(0, dash), port: Number(tail) };
	}
	return { parent: name.slice(0, dash + 1 + dot), port: Number(tail.slice(dot + 1)) };
};

/**
 * @param {{usbRoot: string, pciRoot: string}} [roots] sysfs roots (tests pass fixtures)
 * @returns {{controllers: Object[], buses: Object[]}} buses = root hubs with nested ports
 */
const inventory = (roots) => {
	const usbRoot = (roots && roots.usbRoot) || USB_DEVICES;
	const pciRoot = (roots && roots.pciRoot) || PCI_DEVICES;
	const ids = idsFor(USB_IDS);
	const nets = networks();
	const nodes = {};
	list(usbRoot).filter((n) => n.indexOf(":") === -1).forEach((name) => {
		const dir = path.join(usbRoot, name);
		const uevent = parseUevent(read(dir, "uevent") || "");
		const product = (uevent.PRODUCT || "").split("/");
		const vid = read(dir, "idVendor") || (product[0] || "").padStart(4, "0");
		const pid = read(dir, "idProduct") || (product[1] || "").padStart(4, "0");
		const subsystems = subsystemsOf(usbRoot, name, nets);
		// hub port count from the -port entries of its interface (proxyslave), else maxchild
		const portEntries = subsystems.reduce((n, s) => n + list(path.join(usbRoot, s.name)).filter((f) => f.indexOf("-port") !== -1).length, 0);
		const hub = read(dir, "bDeviceClass") === "09";
		nodes[name] = {
			name: name,
			vid: vid,
			pid: pid,
			manufacturer: read(dir, "manufacturer"),
			product: read(dir, "product"),
			// usb.ids name when the device has no strings of its own
			idName: lookupName(ids, vid, pid),
			serial: read(dir, "serial"),
			speed: read(dir, "speed"),
			hub: hub,
			portCount: hub ? portEntries || Number(read(dir, "maxchild")) || 0 : 0,
			drivers: Array.from(new Set(subsystems.map((s) => s.driver).filter(Boolean))),
			nodes: [].concat(...subsystems.map((s) => s.nodes)),
			networks: [].concat(...subsystems.map((s) => s.networks)),
			subsystems: subsystems,
			children: {}
		};
	});
	const buses = [];
	Object.keys(nodes).forEach((name) => {
		if (name.indexOf("usb") === 0) {
			buses.push(nodes[name]);
			return;
		}
		const link = parentOf(name);
		if (nodes[link.parent]) {
			nodes[link.parent].children[link.port] = nodes[name];
		}
	});
	const shape = (n) => {
		const out = Object.assign({}, n);
		delete out.children;
		if (n.hub) {
			const count = Math.max(n.portCount, ...Object.keys(n.children).map(Number), 0);
			out.ports = Array.from({ length: count }, (_, i) => ({ port: i + 1, device: n.children[i + 1] ? shape(n.children[i + 1]) : null }));
		}
		return out;
	};
	return {
		controllers: controllers(pciRoot),
		buses: buses.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(shape)
	};
};

// ---- serial ports (USB-UART adapters) ------------------------------------------------------

const BY_ID = "/dev/serial/by-id";

/**
 * Every ttyUSB / ttyACM node with the USB device and interface it belongs to.
 * @param {Object[]} buses from inventory()
 * @param {string} [byIdDir]
 */
const serialPorts = (buses, byIdDir) => {
	const dir = byIdDir || BY_ID;
	const links = {};
	list(dir).forEach((name) => {
		try {
			links["/dev/" + path.basename(fs.readlinkSync(path.join(dir, name)))] = path.join(dir, name);
		} catch (_err) {
			// not a link
		}
	});
	const out = [];
	const walk = (n) => {
		(n.subsystems || []).forEach((s) => {
			s.nodes.filter((node) => /^\/dev\/tty(USB|ACM)\d+$/.test(node)).forEach((node) => {
				out.push({
					node: node, byId: links[node] || null, usbPath: n.name, interface: Number(s.name.split(".").pop()),
					vid: n.vid, pid: n.pid, serial: n.serial, product: n.product || n.idName, manufacturer: n.manufacturer, driver: s.driver
				});
			});
		});
		(n.ports || []).forEach((p) => p.device && walk(p.device));
	};
	buses.forEach(walk);
	return out.sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }));
};

/**
 * Find the port matching a stable identity, so a device survives re-enumeration
 * (ttyUSB0 becoming ttyUSB1 after a replug).
 * @param {Object[]} ports from serialPorts()
 * @param {{vid, pid, serial, product, usbPath, interface, byId}} match all optional; interface defaults to the first
 * @returns {Object|null}
 */
const findPort = (ports, match) => {
	const m = match || {};
	const eq = (a, b) => b === undefined || b === null || b === "" || String(a || "").toLowerCase() === String(b).toLowerCase();
	const hits = ports.filter((p) => eq(p.vid, m.vid) && eq(p.pid, m.pid) && eq(p.serial, m.serial) && eq(p.usbPath, m.usbPath) && eq(p.byId, m.byId)
		&& (!m.product || String(p.product || "").toLowerCase().indexOf(String(m.product).toLowerCase()) !== -1)
		&& (m.interface === undefined || m.interface === null || p.interface === Number(m.interface)));
	return hits.sort((a, b) => a.interface - b.interface)[0] || null;
};

// ---- port power (uhubctl) ---------------------------------------------------------------------

/**
 * Parse `uhubctl` status output into {hubLocation: {ppps, ports: {n: {power, connect}}}}.
 */
const parseUhubctl = (text) => {
	const hubs = {};
	let current = null;
	String(text).split("\n").forEach((line) => {
		const hub = /^Current status for hub (\S+) \[(.*)\]/.exec(line);
		if (hub) {
			current = hubs[hub[1]] = { location: hub[1], description: hub[2], ppps: /\bppps\b/.test(hub[2]), ports: {} };
			return;
		}
		const port = /^\s+Port (\d+): (\S+)\s*(.*)$/.exec(line);
		if (port && current) {
			current.ports[port[1]] = { power: /\bpower\b/.test(port[3]), connect: /\bconnect\b/.test(port[3]), status: port[2] };
		}
	});
	return hubs;
};

const run = (cmd, args) => new Promise((resolve, reject) => {
	execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
		if (err) {
			reject(new Error((stderr || err.message).trim().split("\n").slice(-2).join(" ")));
			return;
		}
		resolve(stdout);
	});
});

const usb = {
	inventory: inventory,
	parseUevent: parseUevent,
	parseIdsData: parseIdsData,
	parseUhubctl: parseUhubctl,
	parentOf: parentOf,
	serialPorts: serialPorts,
	findPort: findPort,

	/**
	 * Power status of switchable hubs; {_error} when uhubctl is missing or not permitted.
	 */
	power: () => run("uhubctl", []).then(parseUhubctl, (err) => ({ _error: err.message })),

	/**
	 * @param {string} hub hub location as uhubctl names it (e.g. "1-2")
	 * @param {number} port
	 * @param {string} action on | off | cycle
	 */
	setPower: (hub, port, action) => {
		if (["on", "off", "cycle"].indexOf(action) === -1) {
			return Promise.reject(new Error("action must be on, off or cycle"));
		}
		if (!/^[0-9][0-9.-]*$/.test(String(hub)) || !Number.isInteger(Number(port))) {
			return Promise.reject(new Error("bad hub/port"));
		}
		return run("uhubctl", ["-l", String(hub), "-p", String(port), "-a", action])
			.then((out) => ({ hub: hub, port: Number(port), action: action, output: out.trim().split("\n").slice(-3) }));
	}
};

module.exports = usb;
