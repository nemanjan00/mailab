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
		description: "notes; markdown with $inline$ and $$block$$ KaTeX math, live values with {{channel}} / {{channel|digits}}",
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
	capture: {
		description: "the browser as an instrument: stream this browser's microphone and/or camera into the lab (device <device>, driver browser: audio stream <device>_mic, levels <device>_mic_level/_peak dBFS, images <device>_frame / _snapshot). Needs a secure context (localhost or https) and a person clicking start",
		config: {
			device: "lab device id (default \"browser\")",
			rate: "mic sample rate, 8000..48000 (default 48000)",
			channels: "1 or 2 (default 1)",
			fps: "camera frames per second sent to the lab, up to 10 (default 1)",
			maxWidth: "frame width cap in px (default 1280)",
			quality: "JPEG quality 0..1 (default 0.8)"
		}
	},
	vision: {
		description: "OpenCV ROI editor on a live lab image: draw / move / resize regions, pick a kind (led, seven_seg, value_ocr, color, motion, template), see live values; saves a vision watch",
		config: { watch: "vision watch name (created on first save)", image: "lab image to watch (default: the watch's image)", show: "\"annotated\": show the watch's overlay image <watch>_annotated" }
	},
	json: {
		description: "collapsible JSON view of a lab value",
		config: { value: "value name, e.g. fg_stats", depth: "levels expanded (default 2)", view: "\"table\": sortable/filterable table with CSV/JSON export (arrays of objects, sweep results)" }
	},
	kaitai: {
		description: "parse a lab blob with a Kaitai Struct .ksy: field tree with byte ranges + hex dump (click a range to highlight)",
		config: { blob: "blob name", ksy: ".ksy YAML source", depth: "levels expanded (default 2)" }
	},
	flowgraph: {
		description: "editor for a flowgraph device: blocks, links, live rates and errors",
		config: { device: "flowgraph device id" }
	},
	terminal: {
		description: "web terminal (xterm.js, Dracula colors) for a uart device or a shell device's PTY sessions: ANSI colors and TUIs, raw keystrokes or line mode, live baud / format / line ending / hex view (uart); session picker (shell)",
		config: { device: "uart or shell device id", mode: "raw (default) | line", session: "shell session name (shell devices)" }
	},
	board: {
		description: "board tracing: PDF pages / photos as background layers, trace parts, pins and wires over them; nets come from the drawn geometry; "
			+ "board view + auto-laid-out schematic graph with cross-probing, text search, netlist export (see board_* tools)",
		config: { board: "board name", view: "split | board | graph (default split)" }
	},
	vnc: {
		description: "live remote desktop of a vnc device (noVNC): see and drive legacy GUIs with the AI; scale to fit, view-only, Ctrl-Alt-Del, clipboard send, screenshot to the lab",
		config: { device: "vnc device id", viewOnly: "start view-only (default false)" }
	},
	rigol: {
		description: "live screen of a RIGOL Web Control instrument (DM858/MHO98): the device's own H.264 player + touch-input injection (drive the front panel from the pane); view-only, open the instrument UI",
		config: { device: "rigol device id (host from its options)", host: "or a plain instrument IP", viewOnly: "start view-only (default false)" }
	},
	kvm: {
		description: "live screen of a nanokvm device (MJPEG through the lab, credentials stay server-side); keyboard / mouse capture and ATX power buttons for people, screenshot to the lab, LED status",
		config: { device: "nanokvm device id", viewOnly: "start view-only (default false)" }
	},
	usb: {
		description: "USB tree: hubs, ports, devices with /dev nodes and the lab devices using them; power toggles on switchable hubs (uhubctl)",
		config: {}
	},
	datasheets: {
		description: "research: datasheet search (local DB + online), local datasheet DB with a page viewer, FCC ID lookup with exhibits",
		config: { query: "initial datasheet search", fccId: "initial FCC ID / company lookup", datasheet: "datasheet id to open", page: "page to show (default 1)" }
	},
	custom: {
		description: "custom control panel: a layout tree of SDK elements (built by python bridges via mailab_ui.py, or by the AI)",
		config: { layout: "{col: [{text: \"## PSU {{psu_v}}\"}, {row: [{value: \"psu_v\"}, {number: \"set V\", device: \"psu\", command: \"set_voltage\", arg: \"volts\", unit: \"V\"}]}, {toggle: \"output\", device: \"psu\", command: \"output\", arg: \"on\"}, {chart: [\"psu_v\"]}]}  elements: row col text value button toggle slider number chart table image" }
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
	hex: {
		description: "hex editor on a lab blob: virtual-scrolled hex + ASCII (fast on 64 MB dumps), jump to offset / expression, selection + copy as hex / C / Python / base64, "
			+ "poke / insert / delete / fill with undo (saved to the blob), search & replace (hex ?? wildcards, text, regex), data inspector, checksums (CRC-8/16/32, sums, hashes, entropy), "
			+ "side-by-side diff with config.compare, bookmarks, entropy / binwalk / kaitai overlays in the scroll gutter",
		config: {
			blob: "blob name",
			compare: "second blob for a side-by-side diff (optional)",
			bytesPerRow: "8 | 16 (default) | 32",
			radix: "offset column: hex (default) | dec",
			base: "address of byte 0 shown in the offset column (e.g. 0x08000000); \"@addr\" in jump uses it",
			bookmarks: "[{offset, label}]",
			ksy: ".ksy YAML: top-level field ranges as gutter overlay (optional)",
			overlays: "false to skip entropy / binwalk analysis"
		}
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
	settings: {
		description: "device settings: live state + options, plus a status command result (e.g. command \"siggen\" shows the AWG setpoints as the AI changes them); pairs with a log pane of the same device",
		config: { device: "device id", command: "status command to query (e.g. siggen); empty = options only", interval: "auto-refresh seconds (0 = manual refresh button)" }
	},
	channels: {
		description: "table of all channels with latest values",
		config: {}
	}
};

const DEFAULT_SIZE = { w: 6, h: 4 };
const DEFAULT_TAB = "main";
const TAB_MAX = 32;

const checkTab = (name) => {
	const tab = String(name === undefined || name === null ? "" : name).trim();
	if (!tab || Array.from(tab).length > TAB_MAX || Array.from(tab).some((c) => c.charCodeAt(0) < 32)) {
		throw new Error("tab names: 1-32 characters, no control characters");
	}
	return tab;
};

/**
 * @param {Object[]} initial persisted panes
 * @param {function()} onChange
 * @param {string[]} [savedTabs] persisted tab order (dashboard pages)
 */
const create = (initial, onChange, savedTabs) => {
	// panes from before tabs existed land on the default tab
	let panes = (initial || []).map((p) => Object.assign({ tab: DEFAULT_TAB }, p));
	let tabOrder = (savedTabs || []).slice();

	const validate = (pane) => {
		if (!TYPES[pane.type]) {
			throw new Error("unknown pane type: " + pane.type + " (available: " + Object.keys(TYPES).join(", ") + ")");
		}
	};

	const overlaps = (a, b) => {
		return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
	};

	// first top-left spot in a tab where a w×h pane fits without overlapping others
	const freeSpot = (w, h, tab) => {
		const others = panes.filter((p) => p.tab === tab);
		const bottom = others.reduce((max, pane) => {
			return Math.max(max, pane.y + pane.h);
		}, 0);
		const candidates = Array.from({ length: bottom + 1 }, (_, y) => {
			return Array.from({ length: GRID_COLUMNS - w + 1 }, (__, x) => {
				return { x: x, y: y, w: w, h: h };
			});
		}).flat();
		return candidates.find((spot) => {
			return !others.some((pane) => {
				return overlaps(spot, pane);
			});
		});
	};

	const layout = {
		types: TYPES,

		list: () => {
			return panes;
		},

		/**
		 * Tabs in order: the saved order, then tabs panes use that it doesn't list.
		 */
		tabs: () => {
			const out = tabOrder.slice();
			panes.forEach((p) => {
				if (out.indexOf(p.tab) === -1) {
					out.push(p.tab);
				}
			});
			return out.length ? out : [DEFAULT_TAB];
		},

		addTab: (name) => {
			const tab = checkTab(name);
			if (layout.tabs().indexOf(tab) === -1 || tabOrder.indexOf(tab) === -1) {
				tabOrder = layout.tabs().filter((t) => t !== tab).concat([tab]);
				onChange();
			}
			return layout.tabs();
		},

		renameTab: (from, to) => {
			const next = checkTab(to);
			if (layout.tabs().indexOf(from) === -1) {
				throw new Error("unknown tab: " + from);
			}
			if (from !== next && layout.tabs().indexOf(next) !== -1) {
				throw new Error("tab exists: " + next);
			}
			tabOrder = layout.tabs().map((t) => (t === from ? next : t));
			panes = panes.map((p) => (p.tab === from ? Object.assign({}, p, { tab: next }) : p));
			onChange();
			return layout.tabs();
		},

		/**
		 * Remove a tab; its panes move to `into` (default: the first other tab), below what's there.
		 */
		removeTab: (name, into) => {
			const tabs = layout.tabs();
			if (tabs.indexOf(name) === -1) {
				throw new Error("unknown tab: " + name);
			}
			const target = into === undefined ? tabs.find((t) => t !== name) || DEFAULT_TAB : checkTab(into);
			if (target === name) {
				throw new Error("can't move a tab's panes into itself");
			}
			const moving = panes.filter((p) => p.tab === name);
			const bottom = panes.filter((p) => p.tab === target).reduce((max, p) => Math.max(max, p.y + p.h), 0);
			panes = panes.map((p) => (p.tab === name ? Object.assign({}, p, { tab: target, y: p.y + bottom }) : p));
			tabOrder = tabs.filter((t) => t !== name);
			if (tabOrder.indexOf(target) === -1) {
				tabOrder.push(target);
			}
			onChange();
			return { tabs: layout.tabs(), moved: moving.map((p) => p.id), into: target };
		},

		orderTabs: (list) => {
			const known = layout.tabs();
			const order = list.map(checkTab).filter((t, i, all) => all.indexOf(t) === i);
			tabOrder = order.concat(known.filter((t) => order.indexOf(t) === -1));
			onChange();
			return layout.tabs();
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
			const tab = spec.tab === undefined ? layout.tabs()[0] : checkTab(spec.tab);
			let spot = { x: spec.x, y: spec.y };
			if (spec.x === undefined || spec.y === undefined) {
				spot = freeSpot(w, h, tab);
			}
			const pane = {
				id: spec.id || randomUUID().slice(0, 8),
				type: spec.type,
				title: spec.title || spec.type,
				config: spec.config || {},
				x: spot.x,
				y: spot.y,
				w: w,
				h: h,
				tab: tab,
				collapsed: Boolean(spec.collapsed)
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
			next.tab = checkTab(next.tab);
			next.collapsed = Boolean(next.collapsed);
			if (changes.tab !== undefined && changes.tab !== pane.tab && changes.y === undefined) {
				// moved to another tab: append below what's there
				const spot = freeSpot(next.w, next.h, next.tab);
				next.x = spot.x;
				next.y = spot.y;
			}
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

		replaceAll: (list, tabs) => {
			list.forEach(validate);
			panes = [];
			tabOrder = (tabs || []).slice();
			list.forEach(layout.add);
		}
	};

	return layout;
};

module.exports = {
	create: create,
	DEFAULT_TAB: DEFAULT_TAB,
	TYPES: TYPES
};
