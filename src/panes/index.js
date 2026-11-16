// Pane layout: the web UI is a 12-column grid of typed panes. Both the user
// (drag/resize/edit) and the AI (MCP) edit this same list.

const randomUUID = require("crypto").randomUUID;

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
		description: "x/y plot of traces: spectrum, VNA, scope/logic capture, glitch scatter, constellation, eye diagram (drawn by the trace's mode)",
		config: {
			traces: "[trace names]",
			logX: "bool",
			yMin: "",
			yMax: "",
			markers: "[{mode: \"peak\" | \"x\", x, trace, series, ref}] markers with a readings table (ref = index of another marker for Δ); users shift-click to add",
			peaks: "N: also mark the N highest peaks",
			view: "\"map\" for scatter traces: findus-style parameter map (grid coloured by success rate)",
			bins: "map columns (default 40)",
			success: "class counted as success in the map (default \"success\")"
		}
	},
	waterfall: {
		description: "waterfall (spectrogram) built from successive updates of one trace",
		config: { trace: "trace name", rows: "history rows (default 200)", min: "dB at bottom of colour scale", max: "dB at top" }
	},
	image: {
		description: "latest image: scope screenshot, live camera frames (<cam>_frame) or snapshots",
		config: { image: "image name", device: "camera device id: adds a snapshot button" }
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
	audio: {
		description: "play a lab audio stream (e.g. a flowgraph audio sink) in the browser",
		config: { stream: "stream name, e.g. fg_audio" }
	},
	json: {
		description: "collapsible JSON view of a lab value",
		config: { value: "value name, e.g. fg_stats", depth: "levels expanded (default 2)" }
	},
	kaitai: {
		description: "parse a lab blob with a Kaitai Struct .ksy: field tree with byte ranges + hex dump (click a range to highlight)",
		config: { blob: "blob name", ksy: ".ksy YAML source", depth: "levels expanded (default 2)" }
	},
	flowgraph: {
		description: "editor for a flowgraph device: blocks, links, live rates and errors",
		config: { device: "flowgraph device id" }
	},
	trend: {
		description: "long-term trends (Grafana-like): recorded channels over 5 min … 30 days, mean line in a min/max band",
		config: { channels: "[recorded channel names] (see trend_record)", range: "5m|1h|6h|24h|7d|30d (default 6h)" }
	},
	classifier: {
		description: "log classifier: templates with counts (numbers recorded as channels) and unclassified line clusters; turn clusters into templates",
		config: {}
	},
	blob: {
		description: "blob analysis: file type, entropy profile, binwalk signatures; with compare, a byte diff against another blob",
		config: { blob: "blob name", compare: "second blob to diff against (optional)" }
	},
	graph: {
		description: "graphing calculator: mathjs expressions of x, parametric \"x(t); y(t)\", or lab data (db(mag(fft(ch))))",
		config: { exprs: "[\"sin(x)\", {x: \"cos(t)\", y: \"sin(t)\"}]", xmin: "default -10", xmax: "default 10", ymin: "", ymax: "", equal: "same scale on both axes (polar)", refreshMs: "default 2000" }
	},
	chat: {
		description: "lab chat between people and AIs (markdown + KaTeX)",
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

	const overlaps = (a, b) => {
		return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
	};

	// first top-left spot where a w×h pane fits without overlapping others
	const freeSpot = (w, h) => {
		const bottom = panes.reduce((max, pane) => {
			return Math.max(max, pane.y + pane.h);
		}, 0);
		const candidates = Array.from({ length: bottom + 1 }, (_, y) => {
			return Array.from({ length: GRID_COLUMNS - w + 1 }, (__, x) => {
				return { x: x, y: y, w: w, h: h };
			});
		}).flat();
		return candidates.find((spot) => {
			return !panes.some((pane) => {
				return overlaps(spot, pane);
			});
		});
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
			const w = Math.min(spec.w || DEFAULT_SIZE.w, GRID_COLUMNS);
			const h = spec.h || DEFAULT_SIZE.h;
			let spot = { x: spec.x, y: spec.y };
			if (spec.x === undefined || spec.y === undefined) {
				spot = freeSpot(w, h);
			}
			const pane = {
				id: spec.id || randomUUID().slice(0, 8),
				type: spec.type,
				title: spec.title || spec.type,
				config: spec.config || {},
				x: spot.x,
				y: spot.y,
				w: w,
				h: h
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
