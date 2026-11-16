// Lab profiles dialog: save the setup under a name, load/download/delete
// saved ones, or upload a .mailab.json. Loading replaces the whole lab.

import { el, list, mount, state, when } from "@nemanjan00/qrp";
import { time } from "./panes/util.js";

let mounted = null;

export default (dialog, body, ctx) => {
	if (mounted) {
		mounted.dispose();
	}
	const view = state({ profiles: [], name: "", status: "" });
	const refresh = () => ctx.api("GET", "/profiles").then((list) => {
		view.profiles = list;
	}, (err) => {
		view.status = err.message;
	});
	const act = (promise, done) => promise.then(() => {
		view.status = done;
		return refresh();
	}, (err) => {
		view.status = "⚠ " + err.message;
	});

	const upload = (event) => {
		const file = event.target.files[0];
		if (!file) {
			return;
		}
		file.text().then((text) => {
			if (!confirm("Replace the whole lab with " + file.name + "?")) {
				return;
			}
			act(ctx.api("POST", "/lab/import", JSON.parse(text)), "loaded " + file.name);
		});
	};

	mounted = mount(body, () => el("div", {},
		el("h3", {}, "Lab setups"),
		el("p", { class: "muted" }, "A profile holds devices and their options, panes, derived channels, safety rules + approval policy, classifier templates and trend patterns (not recorded data)."),
		el("form", { class: "toolbar", onsubmit: (e) => {
			e.preventDefault();
			const name = view.name;
			// replacing a profile people trust by name: show what changes first
			const existing = view.profiles.some((p) => p.name === name);
			const check = existing ? ctx.api("GET", "/profiles/" + encodeURIComponent(name) + "/diff").then((d) => confirm("Overwrite profile \"" + name + "\"?\n\n"
				+ (d.save.length ? d.save.join("\n") : "(no changes)"))) : Promise.resolve(true);
			check.then((ok) => {
				if (ok) {
					act(ctx.api("POST", "/profiles", { name: name }), "saved " + name);
				}
			});
		} },
		el("input", { placeholder: "name, e.g. psu-bringup", bind: [view, "name"] }),
		el("button", { class: "primary" }, "save current lab"),
		el("label", { class: "upload" }, "upload…", el("input", { type: "file", accept: ".json", hidden: true, onchange: upload }))),
		when(() => view.status, () => el("p", { class: "muted" }, () => view.status)),
		when(() => view.profiles.length, () => el("table", {},
			el("thead", {}, el("tr", {}, el("th", {}, "profile"), el("th", {}, "devices"), el("th", {}, "saved"), el("th"))),
			el("tbody", {}, list(() => view.profiles, (p) => p.name, (p) => el("tr", {},
				el("td", { class: "mono" }, p.name),
				el("td", { class: "muted" }, p.devices.join(", ") || "—"),
				el("td", { class: "muted" }, p.savedAt ? time(Date.parse(p.savedAt)) : ""),
				el("td", {},
					el("button", { onclick: () => ctx.api("GET", "/profiles/" + encodeURIComponent(p.name) + "/diff").then((d) => {
						if (confirm("Replace the whole lab with \"" + p.name + "\"? Devices restart.\n\n" + (d.load.length ? d.load.join("\n") : "(same as the current lab)"))) {
							act(ctx.api("POST", "/profiles/" + p.name + "/load"), "loaded " + p.name);
						}
					}, (err) => {
						view.status = "⚠ " + err.message;
					}) }, "load"), " ",
					el("a", { href: "/api/profiles/" + p.name, download: p.name + ".mailab.json" }, "download"), " ",
					el("button", { class: "icon", title: "delete", onclick: () => {
						if (confirm("Delete profile " + p.name + "?")) {
							act(ctx.api("DELETE", "/profiles/" + p.name), "deleted " + p.name);
						}
					} }, "×")))))),
		() => el("p", { class: "muted" }, "no saved profiles yet")),
		el("p", {}, el("a", { href: "/api/lab/export", download: "lab.mailab.json" }, "download the current lab"), " · ",
			el("button", { onclick: () => dialog.close() }, "close"))));
	refresh();
	dialog.showModal();
};
