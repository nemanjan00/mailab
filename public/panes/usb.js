// USB tree: buses → hubs → ports → devices with their /dev nodes and the lab
// devices using them; ports of switchable hubs get power toggles (uhubctl).
// Below: in-app udev rules (notify on matching devices added / removed).

import { el, list, onDispose, state, when } from "@nemanjan00/qrp";
import { empty, iconButton, pane } from "../sdk/index.js";

const REFRESH_MS = 3000;
const SPEED = { 1.5: "LS", 12: "FS", 480: "HS", 5000: "SS", 10000: "SS+", 20000: "SS++" };

export default pane((ctx) => {
	const view = state({ data: null, error: "", busy: "", rules: [], events: [] });
	const load = () => ctx.api("GET", "/usb").then((d) => {
		view.data = Object.freeze(d);
		view.error = "";
	}, (err) => {
		view.error = err.message;
	});
	const loadRules = () => ctx.api("GET", "/udev").then((r) => {
		view.rules = r;
	}, () => null);
	load();
	loadRules();
	ctx.api("GET", "/notifications").then((list) => {
		view.events = list.filter((ev) => ev.type === "udev").slice(-8).reverse();
	}, () => null);
	onDispose(ctx.on("notify", (msg) => {
		if (msg.event.type === "udev") {
			view.events = [msg.event].concat(view.events).slice(0, 8);
			load();
		}
	}));
	const timer = setInterval(load, REFRESH_MS);
	onDispose(() => clearInterval(timer));

	const power = (hub, port, action) => {
		if (action !== "on" && !confirm("Switch " + action + " hub " + hub + " port " + port + "? The device on it drops off the bus.")) {
			return;
		}
		view.busy = hub + "." + port;
		ctx.api("POST", "/usb/power", { hub: hub, port: port, action: action }).then(load, (err) => {
			view.error = err.message;
		}).then(() => {
			view.busy = "";
		});
	};

	const portRow = (hub, p, depth) => {
		const d = p.device;
		const hubPower = view.data.power[hub.name];
		const status = hubPower && hubPower.ports[p.port];
		const controls = hubPower && hubPower.ppps ? [
			el("button", { class: status && status.power ? "primary" : "", onclick: () => power(hub.name, p.port, status && status.power ? "off" : "on") }, status && status.power ? "on" : "off"),
			iconButton("↻", "power-cycle", () => power(hub.name, p.port, "cycle"))
		] : [];
		const label = d ? [
			el("b", {}, d.product || d.idName || "(unnamed)"), " ",
			el("span", { class: "muted mono" }, (d.vid || "") + ":" + (d.pid || "") + (SPEED[d.speed] ? " " + SPEED[d.speed] : "")
				+ (d.drivers && d.drivers.length && !d.hub ? " " + d.drivers.join(",") : "")),
			d.networks && d.networks.length ? el("span", { class: "mono usb-nodes" }, " " + d.networks.map((n) => n.name + (n.address.length ? " " + n.address.join(",") : "")).join(" ")) : "",
			d.nodes.length ? el("span", { class: "mono usb-nodes" }, " " + d.nodes.join(" ")) : "",
			d.labDevices && d.labDevices.length ? el("span", { class: "state running" }, " lab: " + d.labDevices.join(", ")) : ""
		] : [el("span", { class: "muted" }, "empty")];
		const rows = [el("div", { class: "usb-row", style: { paddingLeft: (depth * 18 + 8) + "px" } },
			el("span", { class: "muted mono usb-port" }, "p" + p.port), " ", ...label, el("span", { class: "usb-ctl" }, ...controls))];
		if (d && d.ports) {
			// empty ports only matter where they can be switched
			const ppps = view.data.power[d.name] && view.data.power[d.name].ppps;
			d.ports.filter((child) => child.device || ppps).forEach((child) => rows.push(...portRow(d, child, depth + 1)));
		}
		return rows;
	};

	const form = state({ name: "", action: "", field: "vid", value: "" });
	const addRule = () => {
		if (!form.value) {
			return;
		}
		ctx.api("POST", "/udev", { name: form.name, action: form.action || null, match: { [form.field]: form.value } }).then(() => {
			form.value = "";
			form.name = "";
			loadRules();
		}, (err) => {
			view.error = err.message;
		});
	};
	const describe = (r) => (r.action || "any") + " " + Object.keys(r.match).map((k) => k + "=" + r.match[k]).join(" ");
	const rulesBox = el("div", { class: "usb-rules pad" },
		el("div", { class: "muted" }, "udev rules (in-app): notify when a matching device appears / disappears"),
		list(() => view.rules, (r) => r.id, (r) => el("div", { class: "usb-row" },
			el("span", { class: "mono" }, r.id), " ", el("b", {}, r.name || ""), " ", el("span", { class: "mono muted" }, describe(r)),
			el("span", { class: "usb-ctl" }, iconButton("✕", "remove rule", () => ctx.api("DELETE", "/udev/" + r.id).then(loadRules))))),
		el("div", { class: "usb-row" },
			el("input", { placeholder: "name", size: 8, value: () => form.name, oninput: (e) => {
				form.name = e.target.value;
			} }),
			el("select", { onchange: (e) => {
				form.action = e.target.value;
			} }, ...["", "add", "remove", "change"].map((a) => el("option", { value: a }, a || "any"))),
			el("select", { onchange: (e) => {
				form.field = e.target.value;
			} }, ...["vid", "pid", "product", "manufacturer", "serial", "driver", "node", "path"].map((f) => el("option", { value: f }, f))),
			el("input", { placeholder: "glob, e.g. 9ac4 or /dev/ttyACM*", value: () => form.value, oninput: (e) => {
				form.value = e.target.value;
			}, onkeydown: (e) => {
				if (e.key === "Enter") {
					addRule();
				}
			} }),
			el("button", { onclick: addRule }, "add")),
		list(() => view.events, (ev) => ev.id, (ev) => el("div", { class: "usb-row mono" },
			el("span", { class: "muted" }, new Date(ev.t).toLocaleTimeString() + " "),
			el("span", { class: ev.action === "remove" ? "state error" : "state running" }, ev.action), " ",
			ev.usb.path + " " + (ev.usb.product || "") + " " + (ev.usb.nodes || []).join(" "),
			el("span", { class: "muted" }, " ← " + (ev.ruleName || ev.rule)))));

	return el("div", { class: "usbtree" },
		when(() => view.error, () => el("div", { class: "error pad" }, () => view.error)),
		() => {
			if (!view.data) {
				return empty("reading USB…");
			}
			const powerErr = view.data.power && view.data.power._error;
			return el("div", {},
				powerErr ? el("div", { class: "muted pad" }, "port power control unavailable: " + powerErr + " (install uhubctl; needs permissions)") : "",
				...view.data.tree.filter((r) => r.ports && r.ports.some((p) => p.device)).map((root) => el("div", { class: "usb-bus" },
					el("div", { class: "usb-row usb-root" }, el("b", {}, root.name), " ", el("span", { class: "muted" }, root.product)),
					...root.ports.filter((p) => p.device).flatMap((p) => portRow(root, p, 1)))));
		},
		rulesBox);
});
