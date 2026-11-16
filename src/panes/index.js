// Pane layout: the web UI is a 12-column grid of typed panes. Both the user
// (drag/resize/edit) and the AI (MCP) edit this same list.

const uuid = require("uuid").v4;

const GRID_COLUMNS = 12;

// type -> {description, config docs} (also served to the AI)
const TYPES = {
	chart: {
		description: "live time-series chart",
		config: { channels: "[channel names]", seconds: "time window (default 30)", yMin: "", yMax: "" }
	},
	value: {
		description: "big numeric readout of one channel",
		config: { channel: "channel name", precision: "decimals (default 4)", label: "" }
	},
	trace: {
		description: "x/y plot of a captured trace (spectrum, VNA, scope capture, logic capture, glitch scatter)",
		config: { traces: "[trace names]", logX: "bool", yMin: "", yMax: "" }
	},
	waterfall: {
		description: "waterfall (spectrogram) built from successive updates of one trace",
		config: { trace: "trace name", rows: "history rows (default 200)", min: "dB at bottom of colour scale", max: "dB at top" }
	},
	image: {
		description: "latest image (e.g. scope screenshot)",
		config: { image: "image name" }
	},
	markdown: {
		description: "notes; markdown with $inline$ and $$block$$ KaTeX math",
		config: { content: "markdown text" }
	},
	math: {
		description: "live math: expression over channels (each channel = vector of its last `samples` values), rendered as LaTeX with its result",
		config: { expression: "mathjs expression, e.g. rms(sim_sine)", samples: "default 1000", refreshMs: "default 1000" }
	},
	log: {
		description: "device log / console with a command box",
		config: { device: "device id (empty = all)" }
	},
	activity: {
		description: "feed of what the AI did through MCP",
		config: {}
	},
	devices: {
		description: "device list with status and start/stop",
		config: {}
	},
	channels: {
		description: "table of all channels with latest values",
		config: {}
	}
};

const DEFAULT_SIZE = { w: 6, h: 4 };

/**
 * @param {Object[]} initial persisted panes
 * @param {function()} onChange
 */
const create = (initial, onChange) => {
	let panes = (initial || []).slice();

	const validate = (pane) => {
		if (!TYPES[pane.type]) {
			throw new Error("unknown pane type: " + pane.type + " (available: " + Object.keys(TYPES).join(", ") + ")");
		}
	};

	// first free row below everything
	const nextY = () => {
		return panes.reduce((max, pane) => {
			return Math.max(max, pane.y + pane.h);
		}, 0);
	};

	const layout = {
		types: TYPES,

		list: () => {
			return panes;
		},

		get: (id) => {
			const pane = panes.find((p) => {
				return p.id === id;
			});
			if (!pane) {
				throw new Error("unknown pane: " + id);
			}
			return pane;
		},

		/**
		 * @param {{type: string, title: string, config: Object, x: number, y: number, w: number, h: number}} spec
		 */
		add: (spec) => {
			validate(spec);
			const pane = {
				id: spec.id || uuid().slice(0, 8),
				type: spec.type,
				title: spec.title || spec.type,
				config: spec.config || {},
				x: spec.x !== undefined ? spec.x : 0,
				y: spec.y !== undefined ? spec.y : nextY(),
				w: Math.min(spec.w || DEFAULT_SIZE.w, GRID_COLUMNS),
				h: spec.h || DEFAULT_SIZE.h
			};
			panes = panes.concat([pane]);
			onChange();
			return pane;
		},

		/**
		 * Merge changes into a pane; `config` is merged too.
		 */
		update: (id, changes) => {
			const pane = layout.get(id);
			const next = Object.assign({}, pane, changes, {
				id: pane.id,
				config: Object.assign({}, pane.config, changes.config || {})
			});
			validate(next);
			panes = panes.map((p) => {
				if (p.id === id) {
					return next;
				}
				return p;
			});
			onChange();
			return next;
		},

		remove: (id) => {
			layout.get(id);
			panes = panes.filter((p) => {
				return p.id !== id;
			});
			onChange();
		},

		/**
		 * Apply grid positions from the UI: [{id, x, y, w, h}]
		 */
		arrange: (items) => {
			const byId = {};
			items.forEach((item) => {
				byId[item.id] = item;
			});
			panes = panes.map((pane) => {
				const item = byId[pane.id];
				if (!item) {
					return pane;
				}
				return Object.assign({}, pane, { x: item.x, y: item.y, w: item.w, h: item.h });
			});
			onChange();
		},

		replaceAll: (list) => {
			list.forEach(validate);
			panes = [];
			list.forEach(layout.add);
		}
	};

	return layout;
};

module.exports = {
	create: create,
	TYPES: TYPES
};
