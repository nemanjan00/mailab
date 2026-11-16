// MCP server: the AI's hands in the lab. Every tool call is recorded in the
// activity feed so the user sees what the AI did.

const McpServer = require("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
const z = require("zod");
const pkg = require("../../package.json");

const MAX_POINTS = 500;
const ARGS_PREVIEW = 160;

const INSTRUCTIONS = [
	"mailab is a hardware lab you operate. Instruments are devices (lab_drivers lists drivers, their options and commands).",
	"Devices publish live time series as channels named <device>_<field>, captured arrays (spectra, VNA sweeps, scope/logic captures, glitch scatter) as traces, and images (screenshots).",
	"Use math_eval for analysis (mathjs; a channel name is a vector of its recent values, a trace name is its first series' y and <name>_x its x).",
	"Shape the user's web UI with panes (pane_types, pane_add, pane_update, note) so they can see what you see: charts for channels, trace panes for captures, markdown notes with KaTeX for findings.",
	"Hardware can be damaged: confirm with the user before enabling power outputs, transmitting (ptt) or glitching unknown targets."
].join(" ");

const PREVIEW_ARRAY_ITEMS = 6;
const PREVIEW_STRING_CHARS = 80;

// compact args for the activity feed: long arrays -> "[400 numbers]"
const summarize = (value) => {
	return JSON.stringify(value, (_key, v) => {
		if (Array.isArray(v) && v.length > PREVIEW_ARRAY_ITEMS) {
			let kind = "items";
			if (v.every((x) => {
				return typeof x === "number";
			})) {
				kind = "numbers";
			}
			return "[" + v.length + " " + kind + "]";
		}
		if (typeof v === "string" && v.length > PREVIEW_STRING_CHARS) {
			return v.slice(0, PREVIEW_STRING_CHARS) + "…";
		}
		return v;
	});
};

const downsample = (values, max) => {
	if (values.length <= max) {
		return values;
	}
	const stride = values.length / max;
	return Array.from({ length: max }, (_, i) => {
		return values[Math.floor(i * stride)];
	});
};

const stats = (v) => {
	if (!v.length) {
		return { count: 0 };
	}
	const sum = v.reduce((a, b) => {
		return a + b;
	}, 0);
	const mean = sum / v.length;
	const variance = v.reduce((a, b) => {
		return a + (b - mean) * (b - mean);
	}, 0) / v.length;
	return {
		count: v.length,
		min: v.reduce((a, b) => {
			return Math.min(a, b);
		}, Infinity),
		max: v.reduce((a, b) => {
			return Math.max(a, b);
		}, -Infinity),
		mean: mean,
		std: Math.sqrt(variance),
		last: v[v.length - 1]
	};
};

const text = (value) => {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }] };
};

const toContent = (value) => {
	if (value && value._image) {
		const rest = Object.assign({}, value);
		delete rest._image;
		return {
			content: [
				{ type: "image", data: value._image.data, mimeType: value._image.mime },
				{ type: "text", text: JSON.stringify(rest) }
			]
		};
	}
	if (value === undefined) {
		return text({ ok: true });
	}
	return text(value);
};

/**
 * Build an MCP server bound to a lab.
 * @param {Object} lab from src/lab
 */
const create = (lab) => {
	const server = new McpServer({ name: "mailab", version: pkg.version }, { instructions: INSTRUCTIONS });

	// register a tool whose handler returns a value or promise; records activity
	const tool = (name, description, shape, handler) => {
		server.registerTool(name, { description: description, inputSchema: shape }, (args) => {
			const preview = summarize(args || {}).slice(0, ARGS_PREVIEW);
			return Promise.resolve()
				.then(() => {
					return handler(args || {});
				})
				.then((result) => {
					lab.recordActivity({ tool: name, args: preview, ok: true });
					return toContent(result);
				}, (err) => {
					lab.recordActivity({ tool: name, args: preview, ok: false, error: err.message });
					return { isError: true, content: [{ type: "text", text: err.message }] };
				});
		});
	};

	const json = z.record(z.string(), z.any());

	// ---- overview --------------------------------------------------------

	tool("lab_overview", "Everything in the lab: devices, channels (with latest values), traces, images, derived channels, panes", {}, () => {
		const state = lab.state();
		delete state.paneTypes;
		return state;
	});

	tool("lab_drivers", "Available device drivers with their options and commands", {}, () => {
		return require("../devices").list();
	});

	// ---- devices ---------------------------------------------------------

	tool("device_add", "Add and start a device. Any driver can have several instances, each with its own id (the channel prefix) and options selecting the unit (port, host, serial...).", {
		id: z.string().optional().describe("short identifier, letters/digits/_ (e.g. psu1, scope); default <driver>, <driver>2, ..."),
		driver: z.string(),
		options: json.optional()
	}, (a) => {
		return lab.addDevice(a.id, a.driver, a.options || {});
	});

	tool("device_remove", "Stop and remove a device", { id: z.string() }, (a) => {
		return lab.removeDevice(a.id);
	});

	tool("device_start", "(Re)start a device", { id: z.string() }, (a) => {
		return lab.startDevice(a.id);
	});

	tool("device_stop", "Stop a device (keeps its configuration)", { id: z.string() }, (a) => {
		return lab.stopDevice(a.id);
	});

	tool("device_command", "Run a driver command on a device (see lab_drivers for commands and args)", {
		id: z.string(),
		command: z.string(),
		args: json.optional()
	}, (a) => {
		return lab.commandDevice(a.id, a.command, a.args || {});
	});

	tool("device_log", "Recent log / console lines (all devices or one)", {
		id: z.string().optional(),
		last: z.number().optional()
	}, (a) => {
		return lab.getLogs({ device: a.id, last: a.last || 100 });
	});

	// ---- data ------------------------------------------------------------

	tool("channel_read", "Read a channel: statistics plus (downsampled) samples. t is ms since epoch.", {
		name: z.string(),
		seconds: z.number().optional().describe("only the last N seconds"),
		last: z.number().optional().describe("only the last N samples"),
		maxPoints: z.number().optional().describe("default 500; 0 = stats only")
	}, (a) => {
		const data = lab.channels.read(a.name, { seconds: a.seconds, last: a.last });
		let max = MAX_POINTS;
		if (a.maxPoints !== undefined) {
			max = a.maxPoints;
		}
		return {
			channel: lab.channels.describe(a.name),
			stats: stats(data.v),
			t: downsample(data.t, max),
			v: downsample(data.v, max)
		};
	});

	tool("channel_write", "Push samples into a channel (created if missing). Use it to log results from other tools.", {
		name: z.string(),
		values: z.array(z.number()).describe("values, timestamped now (spread over `spanMs` if given)"),
		spanMs: z.number().optional(),
		unit: z.string().optional()
	}, (a) => {
		const now = Date.now();
		const span = a.spanMs || 0;
		a.values.forEach((value, i) => {
			let t = now;
			if (a.values.length > 1) {
				t = now - span + (span * i) / (a.values.length - 1);
			}
			lab.pushSample(a.name, value, { t: t, unit: a.unit, source: "ai" });
		});
		return { name: a.name, written: a.values.length };
	});

	tool("trace_read", "Read a trace (spectrum, sweep, capture, scatter), downsampled", {
		name: z.string(),
		maxPoints: z.number().optional()
	}, (a) => {
		const tr = lab.getTrace(a.name);
		const max = a.maxPoints || MAX_POINTS;
		return {
			name: tr.name,
			mode: tr.mode,
			xUnit: tr.xUnit,
			yUnit: tr.yUnit,
			t: tr.t,
			x: downsample(tr.x, max),
			series: tr.series.map((s) => {
				return {
					label: s.label,
					stats: stats(s.y),
					x: s.x && downsample(s.x, max),
					y: downsample(s.y, max)
				};
			})
		};
	});

	tool("trace_write", "Create/replace a trace, e.g. a computed result to show in a trace pane", {
		name: z.string(),
		x: z.array(z.number()),
		series: z.array(z.object({ label: z.string(), y: z.array(z.number()) })),
		xUnit: z.string().optional(),
		yUnit: z.string().optional(),
		mode: z.enum(["line", "step", "scatter"]).optional()
	}, (a) => {
		lab.setTrace(a.name, a, "ai");
		return { name: a.name };
	});

	tool("image_get", "Get an image (e.g. a scope screenshot) to look at", { name: z.string() }, (a) => {
		const img = lab.getImage(a.name);
		return { _image: { data: img.data.toString("base64"), mime: img.mime }, name: img.name, t: img.t };
	});

	// ---- math ------------------------------------------------------------

	tool("math_eval", "Evaluate a mathjs expression. Channel names are vectors of recent samples; trace names are y of the first series (<name>_x for x). Extras: rms, vpp, db, undb, dbm2w, w2dbm, mag. Example: max(mag(fft(scope_ch1)))", {
		expression: z.string(),
		samples: z.number().optional().describe("samples per channel (default 1000)"),
		seconds: z.number().optional().describe("only the last N seconds of each channel")
	}, (a) => {
		return lab.evaluate(a.expression, { samples: a.samples, seconds: a.seconds });
	});

	tool("math_derive", "Define a derived channel computed per sample from latest values of other channels, e.g. psu_v * psu_i", {
		name: z.string(),
		expression: z.string(),
		unit: z.string().optional()
	}, (a) => {
		return lab.defineDerived(a.name, a.expression, a.unit);
	});

	tool("math_remove", "Remove a derived channel", { name: z.string() }, (a) => {
		return lab.removeDerived(a.name);
	});

	// ---- ui --------------------------------------------------------------

	tool("pane_types", "Pane types for the web UI and their config", {}, () => {
		return lab.state().paneTypes;
	});

	tool("pane_add", "Add a pane to the user's web UI (12-column grid; omitted x/y = append below)", {
		type: z.string(),
		title: z.string().optional(),
		config: json.optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		w: z.number().optional(),
		h: z.number().optional()
	}, (a) => {
		return lab.panes.add(a);
	});

	tool("pane_update", "Change a pane (title, config — merged, position/size)", {
		id: z.string(),
		title: z.string().optional(),
		config: json.optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		w: z.number().optional(),
		h: z.number().optional()
	}, (a) => {
		const changes = Object.assign({}, a);
		delete changes.id;
		return lab.panes.update(a.id, changes);
	});

	tool("pane_remove", "Remove a pane", { id: z.string() }, (a) => {
		return lab.panes.remove(a.id);
	});

	tool("note", "Write findings into a markdown pane (KaTeX: $x$, $$x$$). Creates the pane, or replaces/appends to an existing one.", {
		content: z.string(),
		title: z.string().optional(),
		id: z.string().optional().describe("existing pane id"),
		append: z.boolean().optional()
	}, (a) => {
		if (!a.id) {
			return lab.panes.add({ type: "markdown", title: a.title || "Notes", config: { content: a.content } });
		}
		const pane = lab.panes.get(a.id);
		let content = a.content;
		if (a.append) {
			content = (pane.config.content || "") + "\n\n" + a.content;
		}
		const changes = { config: { content: content } };
		if (a.title) {
			changes.title = a.title;
		}
		return lab.panes.update(a.id, changes);
	});

	return server;
};

module.exports = {
	create: create,
	INSTRUCTIONS: INSTRUCTIONS
};
