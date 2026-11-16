// Lab profiles: named, saved lab setups (devices, panes, derived channels,
// safety rules + policy, classifier templates, trend patterns) as JSON files.

const fs = require("fs");
const path = require("path");

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

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
	create: create
};
