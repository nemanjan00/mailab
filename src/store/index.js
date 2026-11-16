// Lab state persistence: one JSON file, written atomically and debounced.

const fs = require("fs");
const path = require("path");

const FILE_NAME = "lab.json";
const SAVE_DELAY_MS = 300;

/**
 * @param {string} dir data directory
 */
const create = (dir) => {
	const file = path.join(dir, FILE_NAME);
	let timer = null;

	const store = {
		load: () => {
			if (!fs.existsSync(file)) {
				return null;
			}
			return JSON.parse(fs.readFileSync(file, "utf8"));
		},

		saveNow: (state) => {
			clearTimeout(timer);
			fs.mkdirSync(dir, { recursive: true });
			const tmp = file + ".tmp";
			fs.writeFileSync(tmp, JSON.stringify(state, null, "\t"));
			fs.renameSync(tmp, file);
		},

		/**
		 * @param {function(): Object} snapshot called when the save actually happens
		 */
		save: (snapshot) => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				store.saveNow(snapshot());
			}, SAVE_DELAY_MS);
			// a pending save must not keep the process alive (shutdown saves synchronously)
			timer.unref();
		}
	};

	return store;
};

module.exports = {
	create: create
};
