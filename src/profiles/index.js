// Lab profiles: named, saved lab setups (devices, panes, derived channels,
// safety rules + policy, classifier templates, trend patterns) as JSON files.

const fs = require("fs");
const path = require("path");

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_DIFF_LINES = 12;

const short = (v) => {
	const text = JSON.stringify(v);
	return text === undefined ? "unset" : text.length > 40 ? text.slice(0, 37) + "…" : text;
};

/**
 * What changes going from lab state `from` to `to`: devices (added, removed,
 * driver / option / enabled changes), safety rules and policy, derived
 * channels, panes. Short lines, for an approval prompt or a load dialog.
 */
const diffStates = (from, to) => {
	const a = from || {};
	const b = to || {};
	const lines = [];
	const byId = (list) => {
		const out = {};
		(list || []).forEach((d) => {
			out[d.id] = d;
		});
		return out;
	};
	const da = byId(a.devices);
	const db = byId(b.devices);
	Object.keys(db).forEach((id) => {
		const x = da[id];
		const y = db[id];
		if (!x) {
			lines.push("+ device " + id + " (" + y.driver + ")");
			return;
		}
		if (x.driver !== y.driver) {
			lines.push("~ device " + id + ": driver " + x.driver + " → " + y.driver);
		}
		const keys = Array.from(new Set(Object.keys(x.options || {}).concat(Object.keys(y.options || {})))).sort();
		keys.forEach((k) => {
			const ox = (x.options || {})[k];
			const oy = (y.options || {})[k];
			if (JSON.stringify(ox) !== JSON.stringify(oy)) {
				lines.push("~ device " + id + ": " + k + " " + short(ox) + " → " + short(oy));
			}
		});
		if (Boolean(x.enabled) !== Boolean(y.enabled)) {
			lines.push("~ device " + id + ": " + (y.enabled ? "enabled" : "disabled"));
		}
	});
	Object.keys(da).filter((id) => !db[id]).forEach((id) => lines.push("- device " + id + " (" + da[id].driver + ")"));
	const sa = a.safety || {};
	const sb = b.safety || {};
	const ruleKey = (r) => JSON.stringify([r.id, r.when, r.action, r.locked]);
	const ra = (sa.rules || []).map(ruleKey);
	const rb = (sb.rules || []).map(ruleKey);
	const lost = ra.filter((r) => rb.indexOf(r) === -1).length;
	const gained = rb.filter((r) => ra.indexOf(r) === -1).length;
	if (lost || gained) {
		lines.push("~ safety rules: " + lost + " removed or changed, " + gained + " added or changed");
	}
	if (JSON.stringify(sa.policy || null) !== JSON.stringify(sb.policy || null)) {
		lines.push("~ approval policy: " + (sa.policy || []).length + " → " + (sb.policy || []).length + " entries (contents differ)");
	}
	const names = (list) => (list || []).map((d) => d.name + "=" + d.expression).sort().join(";");
	if (names(a.derived) !== names(b.derived)) {
		lines.push("~ derived channels: " + (a.derived || []).length + " → " + (b.derived || []).length);
	}
	if ((a.panes || []).length !== (b.panes || []).length) {
		lines.push("~ panes: " + (a.panes || []).length + " → " + (b.panes || []).length);
	}
	if (lines.length > MAX_DIFF_LINES) {
		return lines.slice(0, MAX_DIFF_LINES).concat(["… " + (lines.length - MAX_DIFF_LINES) + " more"]);
	}
	return lines;
};

/**
 * @param {Object} lab
 * @param {string} dir DATA_DIR/profiles
 */
const create = (lab, dir) => {
	const fileFor = (name) => {
		if (!NAME_RE.test(name) || name.startsWith(".")) {
			throw new Error("profile names: letters, digits, _ . - (max 64)");
		}
		return path.join(dir, name + ".json");
	};

	const profiles = {
		list: () => {
			if (!fs.existsSync(dir)) {
				return [];
			}
			return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
				const file = path.join(dir, f);
				const state = JSON.parse(fs.readFileSync(file, "utf8"));
				return {
					name: f.slice(0, -5),
					savedAt: state.savedAt,
					devices: (state.devices || []).map((d) => d.id + ":" + d.driver),
					panes: (state.panes || []).length
				};
			}).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
		},

		exists: (name) => fs.existsSync(fileFor(name)),

		/**
		 * Lines describing what saving now would change in profile `name`
		 * (empty when it doesn't exist yet).
		 */
		saveDiff: (name) => (profiles.exists(name) ? diffStates(profiles.get(name), lab.exportState()) : []),

		/**
		 * Lines describing what loading profile `name` would change in the lab.
		 */
		loadDiff: (name) => diffStates(lab.exportState(), profiles.get(name)),

		save: (name) => {
			const state = lab.exportState();
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(fileFor(name), JSON.stringify(state, null, "\t"));
			return { name: name, savedAt: state.savedAt, devices: state.devices.length, panes: state.panes.length };
		},

		get: (name) => {
			const file = fileFor(name);
			if (!fs.existsSync(file)) {
				throw new Error("no profile " + name);
			}
			return JSON.parse(fs.readFileSync(file, "utf8"));
		},

		remove: (name) => {
			fs.rmSync(fileFor(name), { force: true });
		},

		load: (name) => lab.importState(profiles.get(name))
	};

	return profiles;
};

module.exports = {
	create: create,
	diffStates: diffStates
};
