// Device settings editor. With config.device set it renders the device's
// settings form (the driver exposes settings_schema + a synced settings
// value, e.g. the mho900 scope) and edits go through the high-level `set`
// command — no SCPI knowledge needed. Without a schema it falls back to a
// generic status-command JSON view (config.command).
//
// The form DOM is built once per schema and values update in place, so a
// live update (or the driver's periodic re-sync) never eats a half-typed
// edit. Number fields accept engineering suffixes (500m, 2u, 1e-3).

import { el } from "@nemanjan00/qrp";
import { escapeHtml } from "./util.js";
import units from "../../src/utils/units/index.js";

const fmt = (v) => {
	if (v === undefined || v === null) {
		return "";
	}
	if (typeof v === "number") {
		return String(Number(v.toPrecision(8)));
	}
	return String(v);
};

const sectionId = (s) => s.key + (s.index !== undefined ? ":" + s.index : "");
const fieldPath = (s, f) => s.key + "." + (s.index !== undefined ? s.index + "." : "") + f.key;

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		body.classList.add("settings-pane");
		let schema = null;
		let syncing = false;
		let lastModelT = 0;
		const controls = {}; // "ch:1/scale" -> {input, row}
		const modelCache = {};
		const statusCache = {};

		const api = (method, path, data) => ctx.api(method, path, data);

		// ---- skeleton ------------------------------------------------------

		const buildToolbar = () => {
			const bar = el("div", { class: "toolbar" });
			bar.append(
				el("span", { class: "devstate muted" }),
				el("span", { class: "age muted", title: "last settings sync" }, "—"),
				el("span", { class: "msg", role: "status" }),
				el("button", { class: "sync", title: "re-read all settings from the device", onclick: () => sync() }, "⟳ sync")
			);
			return bar;
		};

		const buildForm = () => {
			const form = el("div", { class: "form" });
			schema.forEach((section) => {
				const fs = el("fieldset", { "data-section": sectionId(section) },
					el("legend", {}, section.title));
				section.fields.forEach((f) => {
					const id = sectionId(section) + "/" + f.key;
					let input;
					if (f.type === "bool") {
						input = el("input", { type: "checkbox", "data-path": fieldPath(section, f) });
					} else if (f.type === "enum") {
						input = el("select", { "data-path": fieldPath(section, f) },
							...(f.options || []).map((o) => el("option", { value: o }, o)));
					} else {
						input = el("input", {
							type: "text", inputmode: "decimal", class: "num",
							spellcheck: "false", "data-path": fieldPath(section, f),
							title: f.unit ? "in " + f.unit + " (suffixes like 500m, 2u work)" : ""
						});
					}
					const row = el("label", { class: "row", "data-field": id },
						el("span", { class: "k" }, f.label),
						el("div", { class: "c" }, input,
							f.unit ? el("span", { class: "unit" }, f.unit) : null,
							el("span", { class: "mark" })));
					controls[id] = { input: input, row: row, section: section, field: f };
					input.addEventListener("change", () => submit(controls[id]));
					input.addEventListener("keydown", (e) => {
						if (e.key === "Enter") {
							input.blur();
						}
					});
					fs.append(row);
				});
				form.append(fs);
			});
			return form;
		};

		// ---- model -> controls ---------------------------------------------

		const modelValue = (section, f) => {
			const model = modelCache[pane.config.device + "_settings"];
			if (!model) {
				return undefined;
			}
			return section.index !== undefined
				? ((model[section.key] || {})[section.index] || {})[f.key]
				: (model[section.key] || {})[f.key];
		};

		const paint = () => {
			Object.keys(controls).forEach((id) => {
				const c = controls[id];
				if (c.input === document.activeElement || c.row.classList.contains("saving")) {
					return;
				}
				const v = modelValue(c.section, c.field);
				if (c.input.type === "checkbox") {
					c.input.checked = Boolean(v);
				} else if (c.input.tagName === "SELECT") {
					const str = String(v).toUpperCase();
					const hit = Array.from(c.input.options).find((o) => o.value.toUpperCase() === str
						|| o.value.toUpperCase().startsWith(str));
					c.input.value = hit ? hit.value : (v === undefined ? "" : String(v));
				} else {
					c.input.value = fmt(v);
				}
				c.row.classList.remove("bad");
			});
		};

		// ---- edits -> driver ------------------------------------------------

		const msg = (text, cls) => {
			const m = body.querySelector(".msg");
			m.className = "msg " + (cls || "");
			m.textContent = text || "";
			if (text && !cls) {
				setTimeout(() => {
					if (m.textContent === text) {
						m.textContent = "";
					}
				}, 2500);
			}
		};

		const submit = (c) => {
			const path = c.input.dataset.path.split(".");
			let value;
			if (c.input.type === "checkbox") {
				value = c.input.checked;
			} else if (c.input.tagName === "SELECT") {
				value = c.input.value;
			} else {
				const parsed = units.parse(c.input.value, c.field.unit || "");
				if (parsed === null || (typeof parsed !== "number") || !Number.isFinite(parsed)) {
					c.row.classList.add("bad");
					msg("bad number: " + c.input.value, "err");
					return;
				}
				value = parsed;
			}
			const args = {};
			let node = args;
			path.forEach((key, i) => {
				if (i === path.length - 1) {
					node[key] = value;
				} else {
					node[key] = {};
					node = node[key];
				}
			});
			c.row.classList.add("saving");
			api("POST", "/devices/" + pane.config.device + "/command", { command: "set", args: args })
				.then((model) => {
					modelCache[pane.config.device + "_settings"] = model;
					lastModelT = Date.now();
					c.row.classList.remove("saving", "bad");
					const mark = c.row.querySelector(".mark");
					mark.textContent = "✓";
					setTimeout(() => {
						if (mark.textContent === "✓") {
							mark.textContent = "";
						}
					}, 1500);
					paint();
				}, (err) => {
					c.row.classList.remove("saving");
					c.row.classList.add("bad");
					msg(c.field.label + ": " + err.message, "err");
				});
		};

		const sync = () => {
			if (syncing) {
				return;
			}
			syncing = true;
			body.querySelector(".sync").disabled = true;
			body.classList.add("busy");
			api("POST", "/devices/" + pane.config.device + "/command", { command: "sync", args: {} })
				.then((model) => {
					modelCache[pane.config.device + "_settings"] = model;
					lastModelT = Date.now();
					msg("synced");
				}, (err) => msg("sync failed: " + err.message, "err"))
				.then(() => {
					syncing = false;
					body.querySelector(".sync").disabled = false;
					body.classList.remove("busy");
					paint();
				});
		};

		// ---- json fallback ---------------------------------------------------

		const renderJson = () => {
			const device = ctx.state.devices.find((d) => d.id === pane.config.device);
			const rows = [];
			if (device) {
				rows.push("<tr><th>state</th><td>" + escapeHtml(device.state) + " " + escapeHtml(device.detail || "") + "</td></tr>");
				rows.push("<tr><th>driver</th><td>" + escapeHtml(device.driver) + "</td></tr>");
				Object.keys(device.options || {}).forEach((k) => {
					rows.push("<tr><th>" + escapeHtml(k) + "</th><td class=\"mono\">" + escapeHtml(JSON.stringify(device.options[k])) + "</td></tr>");
				});
			}
			const status = statusCache[pane.config.device];
			if (status !== undefined) {
				rows.push("<tr><th>status</th><td class=\"mono\">" + escapeHtml(JSON.stringify(status, null, 1).slice(0, 4000)) + "</td></tr>");
			}
			return rows.length ? "<table class=\"kv\">" + rows.join("") + "</table>" : "<div class=\"empty\">set config.device</div>";
		};

		// ---- lifecycle -------------------------------------------------------

		const paintState = () => {
			const device = ctx.state.devices.find((d) => d.id === pane.config.device);
			const pill = body.querySelector(".devstate");
			if (pill) {
				pill.textContent = device ? device.id + ": " + device.state + (device.detail ? " (" + device.detail + ")" : "") : "no device";
			}
		};

		const loadSchema = () => {
			if (!pane.config.device) {
				schema = null;
				body.innerHTML = "";
				body.append(buildToolbar(), el("div", { class: "empty" }, "set config.device"));
				return Promise.resolve();
			}
			return api("POST", "/devices/" + pane.config.device + "/command", { command: "settings_schema", args: {} })
				.then((s) => {
					schema = Array.isArray(s) && s.length ? s : null;
				}, () => {
					schema = null;
				})
				.then(() => {
					body.innerHTML = "";
					if (schema) {
						body.append(buildToolbar(), buildForm());
						paintState();
						// the driver auto-syncs on start and republishes on
						// change; fetch once now, then live off value events
						return api("GET", "/values/" + pane.config.device + "_settings").then((entry) => {
							modelCache[pane.config.device + "_settings"] = entry.value;
							lastModelT = entry.t || Date.now();
							paint();
						}, () => null).then(() => {
							if (modelCache[pane.config.device + "_settings"] === undefined) {
								sync();
							}
						});
					}
					body.append(buildToolbar());
					const refresh = el("button", { class: "refresh", onclick: () => runStatus() }, "⟳ refresh");
					body.querySelector(".toolbar").append(refresh);
					body.append(el("div", { class: "json" }));
					paintState();
					runStatus();
				});
		};

		const runStatus = () => {
			if (!pane.config.device) {
				return;
			}
			api("POST", "/devices/" + pane.config.device + "/command", { command: pane.config.command || "status", args: {} })
				.then((result) => {
					statusCache[pane.config.device] = result;
				}, (err) => {
					statusCache[pane.config.device] = { error: err.message };
				})
				.then(() => {
					const box = body.querySelector(".json");
					if (box) {
						box.innerHTML = renderJson();
					}
				});
		};

		const offs = [
			ctx.on("state", paintState),
			ctx.on("value", (m) => {
				if (m.name === pane.config.device + "_settings") {
					api("GET", "/values/" + encodeURIComponent(m.name)).then((entry) => {
						modelCache[m.name] = entry.value;
						lastModelT = entry.t || Date.now();
						paint();
					}, () => null);
				}
			})
		];
		const ageTimer = setInterval(() => {
			const age = body.querySelector(".age");
			if (age) {
				age.textContent = lastModelT ? "synced " + Math.max(0, Math.round((Date.now() - lastModelT) / 1000)) + "s ago" : "—";
			}
		}, 1000);

		loadSchema();

		return {
			update: (next) => {
				const deviceChanged = next.config.device !== pane.config.device;
				pane = next;
				if (deviceChanged) {
					loadSchema();
				} else {
					paintState();
					runStatus();
				}
			},
			destroy: () => {
				offs.forEach((off) => off());
				clearInterval(ageTimer);
			}
		};
	}
};
