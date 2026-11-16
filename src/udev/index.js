// udev-like rules inside mailab (not real udev rules): the USB inventory is
// watched for devices appearing / disappearing, and every rule matching such
// an event raises a lab notification ({type: "udev", rule, action, device}),
// which MCP sessions get pushed (subscribe) and the UI shows.
//
// rule: {id, name?, action?: add|remove|change, match: {vid, pid, product,
//        manufacturer, serial, driver, node, path}}; string fields take globs.

const randomBytes = require("crypto").randomBytes;

const POLL_MS = 2000;
const FIELDS = ["vid", "pid", "product", "manufacturer", "serial", "driver", "node", "path"];

const globToRegex = (glob) => new RegExp("^" + String(glob).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");

// flatten an inventory into path -> device summary
const flatten = (buses) => {
	const out = {};
	const walk = (n) => {
		if (n.name.indexOf("usb") !== 0) {
			out[n.name] = {
				path: n.name, vid: n.vid, pid: n.pid, product: n.product || n.idName, manufacturer: n.manufacturer,
				serial: n.serial, speed: n.speed, drivers: n.drivers, nodes: n.nodes
			};
		}
		(n.ports || []).forEach((p) => p.device && walk(p.device));
	};
	buses.forEach(walk);
	return out;
};

// what to compare for "change": bound drivers and /dev nodes settle after "add"
const signature = (d) => JSON.stringify([d.vid, d.pid, d.serial, d.drivers, d.nodes]);

const matchRule = (rule, ev) => {
	if (rule.action && rule.action !== ev.action) {
		return false;
	}
	const m = rule.match || {};
	const d = ev.device;
	return FIELDS.every((f) => {
		if (m[f] === undefined || m[f] === null || m[f] === "") {
			return true;
		}
		const re = globToRegex(m[f]);
		if (f === "driver") {
			return (d.drivers || []).some((x) => re.test(x));
		}
		if (f === "node") {
			return (d.nodes || []).some((x) => re.test(x));
		}
		return d[f] !== undefined && d[f] !== null && re.test(String(d[f]));
	});
};

/**
 * Diff two flattened inventories into add / remove / change events.
 */
const diff = (before, after) => {
	const events = [];
	Object.keys(after).forEach((p) => {
		if (!before[p]) {
			events.push({ action: "add", device: after[p] });
		} else if (signature(before[p]) !== signature(after[p])) {
			events.push({ action: "change", device: after[p] });
		}
	});
	Object.keys(before).forEach((p) => {
		if (!after[p]) {
			events.push({ action: "remove", device: before[p] });
		}
	});
	return events;
};

/**
 * @param {{scan: function(): Object[], notify: function(Object), onChange: function()}} deps scan returns inventory buses
 * @param {Object[]} [saved] rules
 */
const create = (deps, saved) => {
	let rules = (saved || []).slice();
	let known = null;

	const udev = {
		list: () => rules.slice(),

		add: (rule) => {
			if (rule.action && ["add", "remove", "change"].indexOf(rule.action) === -1) {
				throw new Error("action must be add, remove or change");
			}
			const match = {};
			FIELDS.forEach((f) => {
				if (rule.match && rule.match[f] !== undefined && rule.match[f] !== null && rule.match[f] !== "") {
					match[f] = String(rule.match[f]);
				}
			});
			const full = { id: rule.id || "u" + randomBytes(3).toString("hex"), name: rule.name || "", action: rule.action || null, match: match };
			rules = rules.filter((r) => r.id !== full.id).concat([full]);
			deps.onChange();
			return full;
		},

		remove: (id) => {
			const before = rules.length;
			rules = rules.filter((r) => r.id !== id);
			if (rules.length === before) {
				throw new Error("no udev rule " + id);
			}
			deps.onChange();
			return rules.slice();
		},

		load: (list) => {
			rules = (list || []).slice();
		},

		/**
		 * One scan: diff against the last, notify matching rules; returns the raw events.
		 */
		poll: () => {
			const now = flatten(deps.scan());
			const events = known ? diff(known, now) : [];
			known = now;
			events.forEach((ev) => {
				rules.filter((r) => matchRule(r, ev)).forEach((r) => {
					deps.notify({ type: "udev", rule: r.id, ruleName: r.name, action: ev.action, usb: ev.device, line: ev.action + " " + ev.device.path + " " + (ev.device.product || "") });
				});
			});
			return events;
		},

		start: () => {
			let stopped = false;
			let timer = null;
			const tick = () => {
				try {
					udev.poll();
				} catch (_err) {
					// sysfs unavailable (e.g. container without /sys): try again later
				}
				if (!stopped) {
					timer = setTimeout(tick, POLL_MS);
					timer.unref();
				}
			};
			tick();
			return () => {
				stopped = true;
				clearTimeout(timer);
			};
		},

		snapshot: () => rules.slice()
	};

	return udev;
};

module.exports = {
	create: create,
	matchRule: matchRule,
	diff: diff,
	flatten: flatten
};
