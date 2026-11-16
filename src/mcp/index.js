// MCP server: the AI's hands in the lab. Every tool call is recorded in the
// activity feed so the user sees what the AI did.

const McpServer = require("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
const z = require("zod");
const pkg = require("../../package.json");
const batch = require("../batch");
const kaitai = require("../kaitai");
const blobs = require("../blobs");

const MAX_POINTS = 500;
const ARGS_PREVIEW = 160;

const INSTRUCTIONS = [
	"mailab is a hardware lab you operate. Instruments are devices (lab_drivers lists drivers, their options and commands).",
	"Devices publish live time series as channels named <device>_<field>, captured arrays (spectra, VNA sweeps, scope/logic captures, glitch scatter) as traces, and images (screenshots).",
	"Use math_eval for analysis (mathjs; a channel name is a vector of its recent values, a trace name is its first series' y and <name>_x its x).",
	"Shape the user's web UI with panes (pane_types, pane_add, pane_update, note) so they can see what you see: charts for channels, trace panes for captures, markdown notes with KaTeX for findings.",
	"Hardware can be damaged: confirm with the user before enabling power outputs, transmitting (ptt) or glitching unknown targets.",
	"Several people and AIs may share this lab: coordinate in the lab chat (chat_read / chat_send) before changing shared devices."
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

// tools a read-only collaborator may use (chat is collaboration, so it's allowed)
const READ_TOOLS = ["lab_overview", "lab_drivers", "device_log", "channel_read", "trace_read", "image_get", "value_read", "safety_overview",
	"blob_read", "kaitai_parse", "blob_analyze", "blob_diff", "classifier_status", "trend_read", "lab_profiles", "usb_tree", "uart_ports", "udev_rules", "subscribe", "unsubscribe", "subscriptions", "notifications_read", "math_eval", "pane_types", "chat_read", "chat_send"];

/**
 * Build an MCP server bound to a lab.
 * @param {Object} lab from src/lab
 * @param {{who: {name: string, role: string}, session: Object}} [context]
 *   who: authenticated collaborator; session: MCP session (knows the client name)
 */
const create = (lab, context) => {
	const ctx = context || {};
	// no identity = read-only; only an explicit "rw" may change the lab
	const who = ctx.who || { name: "anonymous", role: "ro" };
	// "alice/claude-code" once the client introduced itself
	const actor = () => {
		const client = ctx.session && ctx.session.client;
		return client ? who.name + "/" + client : who.name;
	};
	// logging capability: subscribed lab events are sent as notifications/message
	const server = new McpServer({ name: "mailab", version: pkg.version }, { instructions: INSTRUCTIONS, capabilities: { logging: {} } });

	// name -> handler, so batch can call tools directly
	const handlers = {};

	// register a tool whose handler returns a value or promise; records activity
	const tool = (name, description, shape, handler) => {
		const guarded = (args) => {
			if (who.role !== "rw" && who.role !== "human" && READ_TOOLS.indexOf(name) === -1) {
				throw new Error(who.name + " is read-only: " + name + " is not allowed");
			}
			return handler(args);
		};
		handlers[name] = guarded;
		server.registerTool(name, { description: description, inputSchema: shape }, (args) => {
			const preview = summarize(args || {}).slice(0, ARGS_PREVIEW);
			return Promise.resolve()
				.then(() => {
					return guarded(args || {});
				})
				.then((result) => {
					lab.recordActivity({ who: actor(), tool: name, args: preview, ok: true });
					return toContent(result);
				}, (err) => {
					lab.recordActivity({ who: actor(), tool: name, args: preview, ok: false, error: err.message });
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

	tool("device_command", "Run a driver command on a device (see lab_drivers for commands and args). "
		+ "Risky commands (outputs on, high voltage, PTT, glitching, pairing; see safety_overview) wait for a person to approve them in the lab chat", {
		id: z.string(),
		command: z.string(),
		args: json.optional()
	}, (a) => {
		const args = a.args || {};
		const device = lab.getDevice(a.id);
		const rule = lab.safety.needsApproval(a.id, device.driver, a.command, args);
		if (!rule) {
			return lab.commandDevice(a.id, a.command, args);
		}
		return lab.safety.requestApproval({ who: actor(), device: a.id, command: a.command, args: args, reason: rule.reason || "approval required" })
			.then(() => lab.commandDevice(a.id, a.command, args));
	});

	tool("safety_overview", "Safety rules (server-enforced), the approval policy, pending approvals and recent rule firings", {}, () => {
		return { rules: lab.safety.listRules(), policy: lab.safety.getPolicy(), pending: lab.safety.listPending(), fired: lab.safety.firedLog().slice(-20) };
	});

	tool("rule_add", "Add a server-enforced safety rule: when (mathjs over latest channel values; <channel>_age = seconds since its last sample) "
		+ "holds for for_ms, run action {device, command, args}. E.g. when \"psu_i > 0.5\", action {device: \"psu\", command: \"output\", args: {on: false}}", {
		name: z.string(),
		when: z.string(),
		for_ms: z.number().optional(),
		cooldown_ms: z.number().optional(),
		action: z.object({ device: z.string(), command: z.string(), args: json.optional() }).optional(),
		locked: z.boolean().optional().describe("locked rules can only be removed by a person in the web UI")
	}, (a) => {
		// a rule action is a command the server will run unattended: if the
		// policy wants a person for it, the person approves it now
		const spec = Object.assign({}, a);
		delete spec.id;
		const act = spec.action;
		if (!act) {
			return lab.safety.addRule(spec, actor());
		}
		const device = lab.getDevice(act.device);
		const rule = lab.safety.needsApproval(act.device, device.driver, act.command, act.args || {});
		if (!rule) {
			return lab.safety.addRule(spec, actor());
		}
		return lab.safety.requestApproval({
			who: actor(), device: act.device, command: act.command, args: act.args || {},
			reason: "safety rule \"" + spec.name + "\" would run it automatically when " + spec.when + " (" + (rule.reason || "approval required") + ")"
		}).then(() => lab.safety.addRule(spec, actor()));
	});

	tool("rule_remove", "Remove a safety rule (locked rules can only be removed by a person)", { id: z.string() }, (a) => {
		return lab.safety.removeRule(a.id, false);
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

	tool("value_read", "Read a JSON value (flowgraph graph/stats, decoded data...)", { name: z.string() }, (a) => {
		return lab.getValue(a.name);
	});

	tool("value_write", "Store a JSON value, e.g. structured findings to show in a json pane", {
		name: z.string(),
		value: z.any()
	}, (a) => {
		lab.setValue(a.name, a.value, "ai");
		return { name: a.name };
	});

	tool("blob_write", "Store binary data as a blob (from base64 or hex), e.g. to parse with kaitai_parse or show in a kaitai pane", {
		name: z.string(),
		base64: z.string().optional(),
		hex: z.string().optional()
	}, (a) => {
		let data;
		if (a.base64 !== undefined) {
			data = Buffer.from(a.base64, "base64");
		} else if (a.hex !== undefined) {
			data = Buffer.from(a.hex.replace(/\s+/g, ""), "hex");
		} else {
			throw new Error("give base64 or hex");
		}
		lab.setBlob(a.name, data, "ai");
		return { name: a.name, bytes: data.length };
	});

	tool("blob_read", "Read part of a blob as hex", {
		name: z.string(),
		offset: z.number().optional(),
		length: z.number().optional().describe("default 256, max 65536")
	}, (a) => {
		const blob = lab.getBlob(a.name);
		const offset = a.offset || 0;
		const length = Math.min(a.length || 256, 65536);
		return { name: a.name, bytes: blob.data.length, offset: offset, hex: blob.data.slice(offset, offset + length).toString("hex") };
	});

	tool("blob_analyze", "Analyze a blob: size, sha256, `file` type, entropy profile (also stored as trace <name>_entropy) with high/low-entropy regions, binwalk signatures", {
		name: z.string(),
		window: z.number().optional().describe("entropy window in bytes (default 256)"),
		binwalk: z.boolean().optional().describe("default true")
	}, (a) => {
		const blob = lab.getBlob(a.name);
		return blobs.analyze(blob.data, { window: a.window, binwalk: a.binwalk }).then((r) => {
			lab.setTrace(a.name + "_entropy", { x: r.entropy.x, series: [{ label: "bits/byte", y: r.entropy.y }], xUnit: "B", yUnit: "bits" }, "analysis");
			const out = Object.assign({}, r, { entropy: { mean: r.entropy.mean, window: r.entropy.window, regions: r.entropy.regions, trace: a.name + "_entropy" } });
			return out;
		});
	});

	tool("blob_diff", "Changed byte ranges between two blobs (e.g. flash before/after a glitch)", {
		a: z.string(),
		b: z.string()
	}, (a) => {
		return blobs.diff(lab.getBlob(a.a).data, lab.getBlob(a.b).data);
	});

	tool("kaitai_parse", "Parse a blob with a Kaitai Struct .ksy (YAML text): returns the field tree and each field's byte range", {
		blob: z.string(),
		ksy: z.string().describe(".ksy YAML source"),
		ranges: z.boolean().optional().describe("include byte ranges (default true)")
	}, (a) => {
		return kaitai.parse(a.ksy, lab.getBlob(a.blob).data).then((result) => {
			if (a.ranges === false) {
				delete result.ranges;
			}
			return result;
		});
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

	tool("plot", "Graphing calculator: plot mathjs expressions as trace `name` (show it with a trace pane). "
		+ "\"sin(x)*exp(-x/5)\" over [xmin, xmax]; parametric {x: \"cos(t)\", y: \"sin(2*t)\"} over [tmin, tmax]; "
		+ "data expressions without x (e.g. \"db(mag(fft(scope_ch1)))\") plot against their index", {
		name: z.string().describe("trace name for the result"),
		exprs: z.array(z.union([z.string(), z.object({ x: z.string(), y: z.string(), label: z.string().optional() })])),
		xmin: z.number().optional(),
		xmax: z.number().optional(),
		tmin: z.number().optional(),
		tmax: z.number().optional(),
		points: z.number().optional(),
		xUnit: z.string().optional(),
		yUnit: z.string().optional(),
		ymin: z.number().optional(),
		ymax: z.number().optional(),
		equal: z.boolean().optional().describe("same scale on both axes (polar plots)")
	}, (a) => {
		const result = lab.plot(Object.assign({ source: "ai" }, a), a.name);
		return { trace: a.name, series: result.series.map((s) => ({ label: s.label, points: s.y.length })) };
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

	// ---- chat ------------------------------------------------------------

	tool("chat_send", "Post to the lab chat (people in the web UI and other AIs read it)", {
		text: z.string()
	}, (a) => {
		return lab.postChat({ from: actor(), kind: "ai", text: a.text, session: ctx.session && ctx.session.id });
	});

	tool("chat_read", "Read the lab chat (newest last)", {
		since: z.number().optional().describe("only messages with id > since"),
		last: z.number().optional().describe("default 50")
	}, (a) => {
		return lab.getChat({ since: a.since, last: a.last || 50 });
	});

	// ---- USB --------------------------------------------------------------------

	tool("usb_tree", "USB tree: buses → hubs → ports → devices (vid:pid, product, serial, /dev nodes, which lab device uses it) and per-port power status of switchable hubs (uhubctl)", {}, () => lab.usbTree());

	tool("uart_ports", "Serial ports (ttyUSB / ttyACM) with the USB adapter behind each: vid:pid, serial, product, interface, by-id link, and which lab device uses it. "
		+ "Use the identity as a uart device's `match` (e.g. {vid: \"0403\", pid: \"6010\", interface: 0} for Tigard's UART) so it survives replugs", {}, () => lab.uartPorts());

	tool("usb_power", "Switch a USB hub port: on, off or cycle (power-cycle a hung device). Hub = uhubctl location (e.g. \"1-2\"). Waits for a person's approval", {
		hub: z.string(),
		port: z.number(),
		action: z.enum(["on", "off", "cycle"])
	}, (a) => {
		const usb = require("../services/usb");
		const rule = lab.safety.needsApproval("usb", "usb", "usb_power", a);
		const go = () => usb.setPower(a.hub, a.port, a.action);
		if (!rule) {
			return go();
		}
		return lab.safety.requestApproval({ who: actor(), device: "usb", command: "usb_power", args: a, reason: rule.reason }).then(go);
	});

	tool("udev_rules", "mailab udev rules (in-app, not system udev): USB devices appearing/disappearing that raise lab notifications", {}, () => lab.udev.list());

	tool("udev_rule_add", "Add an in-app udev rule: get notified when a matching USB device is added, removed or changes (drivers / /dev nodes bound). "
		+ "All match fields are optional globs (case-insensitive): vid, pid (hex, e.g. \"1d50\"), product, manufacturer, serial, driver (e.g. \"cdc_acm\"), "
		+ "node (e.g. \"/dev/ttyACM*\"), path (sysfs port path, e.g. \"8-1.3.*\"). Events are {type: \"udev\", rule, action, usb: {path, vid, pid, product, serial, drivers, nodes}}; "
		+ "this session is subscribed to its rule's events automatically (others: subscribe types [\"udev\"] or notifications_read)", {
		name: z.string().optional(),
		action: z.enum(["add", "remove", "change"]).optional().describe("default: any"),
		match: z.object({
			vid: z.string().optional(),
			pid: z.string().optional(),
			product: z.string().optional(),
			manufacturer: z.string().optional(),
			serial: z.string().optional(),
			driver: z.string().optional(),
			node: z.string().optional(),
			path: z.string().optional()
		}).optional()
	}, (a) => {
		const rule = lab.udev.add({ name: a.name, action: a.action, match: a.match || {} });
		if (ctx.session) {
			ctx.session.subs.push({ id: "s" + (ctx.session.subs.length + 1), types: ["udev"], rule: rule.id });
		}
		return rule;
	});

	tool("udev_rule_remove", "Remove an in-app udev rule", { id: z.string() }, (a) => {
		if (ctx.session) {
			ctx.session.subs = ctx.session.subs.filter((sub) => sub.rule !== a.id);
		}
		return lab.udev.remove(a.id);
	});

	// ---- lab profiles ---------------------------------------------------------

	tool("lab_profiles", "Saved lab setups (profiles)", {}, () => lab.profiles.list());

	tool("lab_save", "Save the whole lab setup (devices + options, panes, derived channels, safety rules + policy, classifier templates, trend patterns) as a named profile", {
		name: z.string()
	}, (a) => lab.profiles.save(a.name));

	tool("lab_load", "Replace the lab with a saved profile (stops all devices). Waits for a person's approval: it can replace safety rules", {
		name: z.string()
	}, (a) => {
		const profile = lab.profiles.get(a.name);
		return lab.safety.requestApproval({
			who: actor(), device: "lab", command: "load", args: { profile: a.name },
			reason: "replaces the whole lab with profile \"" + a.name + "\" (" + (profile.devices || []).length + " devices, safety rules included)"
		}).then(() => lab.importState(profile)).then((state) => ({ loaded: a.name, devices: state.devices.map((d) => d.id + ":" + d.state) }));
	});

	// ---- long-term trends ----------------------------------------------------

	tool("trend_read", "Long-term history of a recorded channel: min/max/mean buckets at the finest resolution that fits "
		+ "(1 s for 6 h, 10 s for 3 days, 1 min for 30 days, 1 h for 2 years). from/to: ms since epoch or relative like \"-24h\", \"-30m\", \"-7d\"", {
		channel: z.string(),
		from: z.union([z.number(), z.string()]).optional().describe("default -1h"),
		to: z.union([z.number(), z.string()]).optional().describe("default now"),
		points: z.number().optional().describe("max buckets (default 300)")
	}, (a) => {
		const when = (v, fallback) => {
			if (v === undefined) {
				return fallback;
			}
			if (typeof v === "number") {
				return v;
			}
			const m = /^-(\d+(?:\.\d+)?)([smhd])$/.exec(v);
			if (!m) {
				throw new Error("use ms since epoch or a relative time like -24h");
			}
			return Date.now() - Number(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
		};
		const r = lab.trends.read(a.channel, { from: when(a.from, Date.now() - 3600000), to: when(a.to, Date.now()), points: a.points || 300 });
		return Object.assign({ channel: a.channel, buckets: r.t.length }, r);
	});

	tool("trend_record", "Which channels are recorded long term (glob patterns, e.g. \"psu_*\", \"*_temp\"); give `patterns` to replace the list", {
		patterns: z.array(z.string()).optional()
	}, (a) => {
		if (a.patterns) {
			lab.trends.setPatterns(a.patterns);
		}
		return { patterns: lab.trends.getPatterns(), recording: lab.trends.channels() };
	});

	// ---- classifier & notifications ----------------------------------------

	tool("classifier_status", "Log classifier: templates (match counts) and the unclassified clusters of device lines (serial/UART/helpers), biggest first", {
		limit: z.number().optional()
	}, (a) => lab.classifier.status({ limit: a.limit }));

	tool("classifier_add", "Teach the classifier a line template (placeholders <num> <hex> <ip> <uuid> <word> <*>). Matches count into channel cls_<name>; "
		+ "numbers are recorded as cls_<name>_1, _2 … for charting. Matching clusters (the backlog) are absorbed", {
		name: z.string(),
		pattern: z.string().describe("e.g. \"temp=<num>C\" or \"client <uuid> failed to connect to <ip>:<num>\""),
		record: z.boolean().optional().describe("record numeric fields as channels (default true)")
	}, (a) => lab.classifier.addTemplate(a));

	tool("classifier_remove", "Remove a classifier template", { name: z.string() }, (a) => lab.classifier.removeTemplate(a.name));

	tool("subscribe", "Get lab events pushed to this MCP session as notifications/message: types rule, approval, trigger, cluster (new unclassified "
		+ "line clusters, debounced), match (template matches), line, udev (USB events matching an in-app udev rule). Optional filters: device, template, rule (udev rule id), pattern (regex on the line)", {
		types: z.array(z.enum(["rule", "approval", "trigger", "cluster", "match", "line", "udev"])),
		rule: z.string().optional(),
		device: z.string().optional(),
		template: z.string().optional(),
		pattern: z.string().optional()
	}, (a) => {
		if (!ctx.session) {
			throw new Error("subscriptions need an MCP session (this client is stateless): use notifications_read to poll");
		}
		if (a.pattern) {
			RegExp(a.pattern);
		}
		const sub = Object.assign({ id: "s" + (ctx.session.subs.length + 1) }, a);
		ctx.session.subs.push(sub);
		return sub;
	});

	tool("unsubscribe", "Remove a subscription (or all with id \"*\")", { id: z.string() }, (a) => {
		if (!ctx.session) {
			throw new Error("no MCP session");
		}
		ctx.session.subs = a.id === "*" ? [] : ctx.session.subs.filter((sub) => sub.id !== a.id);
		return ctx.session.subs;
	});

	tool("subscriptions", "This session's subscriptions", {}, () => (ctx.session ? ctx.session.subs : []));

	tool("notifications_read", "Recent lab events (poll alternative to subscribe)", {
		since: z.number().optional().describe("only events with id > since"),
		types: z.array(z.string()).optional()
	}, (a) => lab.getNotifications({ since: a.since }).filter((ev) => !a.types || a.types.indexOf(ev.type) !== -1));

	// ---- batch -----------------------------------------------------------

	tool("batch", "Run several tool calls in one request with precise timing (~1 ms), instead of one round-trip per call. "
		+ "Each step: {tool, args, name?, delayMs?, at?, repeat?, intervalMs?}. `at` = ms after batch start; `delayMs` = wait before the step; "
		+ "`repeat`+`intervalMs` = run N times at a fixed rate. Use \"$name\" or \"$name.path\" in args to reuse an earlier step's result, "
		+ "and loop: {var, values} to run all steps per value (\"$var\" in args). Returns per-call start time t (ms) and duration. "
		+ "Example sweep: loop {var: \"v\", values: [1,2,3]}, steps [{tool: \"device_command\", args: {id: \"psu\", command: \"set_voltage\", args: {volts: \"$v\"}}}, {tool: \"channel_read\", delayMs: 50, args: {name: \"psu_i\", last: 1, maxPoints: 0}}]", {
		steps: z.array(z.object({
			tool: z.string(),
			args: json.optional(),
			name: z.string().optional(),
			delayMs: z.number().optional(),
			at: z.number().optional(),
			repeat: z.number().optional(),
			intervalMs: z.number().optional()
		})),
		loop: z.object({ var: z.string(), values: z.array(z.any()) }).optional(),
		stopOnError: z.boolean().optional().describe("default true")
	}, (a) => {
		const invoke = (name, args) => {
			if (name === "batch") {
				return Promise.reject(new Error("batch cannot be nested"));
			}
			if (!handlers[name]) {
				return Promise.reject(new Error("unknown tool: " + name));
			}
			const preview = "[batch] " + summarize(args).slice(0, ARGS_PREVIEW);
			return Promise.resolve()
				.then(() => {
					return handlers[name](args);
				})
				.then((result) => {
					lab.recordActivity({ who: actor(), tool: name, args: preview, ok: true });
					return result;
				}, (err) => {
					lab.recordActivity({ who: actor(), tool: name, args: preview, ok: false, error: err.message });
					throw err;
				});
		};
		return batch.run(a.steps, { loop: a.loop, stopOnError: a.stopOnError }, invoke);
	});

	return server;
};

module.exports = {
	create: create,
	INSTRUCTIONS: INSTRUCTIONS
};
