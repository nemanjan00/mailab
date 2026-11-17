// MCP server: the AI's hands in the lab. Every tool call is recorded in the
// activity feed so the user sees what the AI did.

const McpServer = require("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
const z = require("zod");
const pkg = require("../../package.json");
const batch = require("../batch");
const kaitai = require("../kaitai");
const blobs = require("../blobs");
const blobEdit = require("../blobs/edit");
const media = require("../services/media");
const sweepModule = require("../sweep");
const pdfUtil = require("../utils/pdf");
const research = {
	fccid: require("../services/fccid"),
	datasheets: require("../services/datasheets")
};
const vision = require("../vision");

const MAX_POINTS = 500;
const DEFAULT_RENDER_PAGES = 3;
const MAX_RENDER_PAGES = 20;
const FCC_DPI = 100;

// blob / image names from free text (ids, document titles)
const labName = (str) => String(str).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "doc";
const ARGS_PREVIEW = 160;

const INSTRUCTIONS = [
	"mailab is a hardware lab you operate. Instruments are devices (lab_drivers lists drivers, their options and commands).",
	"Devices publish live time series as channels named <device>_<field>, captured arrays (spectra, VNA sweeps, scope/logic captures, glitch scatter) as traces, and images (screenshots).",
	"Use math_eval for analysis (mathjs; a channel name is a vector of its recent values, a trace name is its first series' y and <name>_x its x).",
	"Shape the user's web UI with panes (pane_types, pane_add, pane_update, note) so they can see what you see: charts for channels, trace panes for captures, markdown notes with KaTeX for findings.",
	"For an unknown device or chip, research it: fccid_search / fccid_exhibits / fccid_fetch (FCC filings: internal photos, block diagrams), datasheet_search / datasheet_fetch / datasheet_find / datasheet_page (pinouts, register maps).",
	"Hardware can be damaged: confirm with the user before enabling power outputs, transmitting (ptt) or glitching unknown targets.",
	"Several people and AIs may share this lab: coordinate in the lab chat (chat_read / chat_send) before changing shared devices."
].join(" ");

const PREVIEW_ARRAY_ITEMS = 6;
const PREVIEW_STRING_CHARS = 80;

// compact args for the activity feed: long arrays -> "[400 numbers]"
const summarize = (value) => {
	return JSON.stringify(value, (key, v) => {
		// secrets in device options (vnc password) never reach the activity feed
		if (key === "password" && v !== undefined && v !== "") {
			return "***";
		}
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
	"blob_read", "vision_ops", "vision_watches", "blob_peek", "blob_search", "blob_checksum", "media_probe", "kaitai_parse", "blob_analyze", "blob_diff", "classifier_status", "trend_read", "lab_profiles", "recordings", "usb_tree", "uart_ports", "udev_rules", "subscribe", "unsubscribe", "subscriptions", "notifications_read", "math_eval", "pane_types", "chat_read", "chat_send",
	"board_list", "board_get", "board_search", "board_graph", "board_netlist", "board_view",
	// lookups only (they fill the on-disk HTTP cache, not the lab)
	"fccid_search", "fccid_exhibits", "datasheet_search", "datasheet_find"];

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
		const who = actor();
		const device = lab.getDevice(a.id);
		const rule = lab.safety.needsApproval(a.id, device.driver, a.command, args);
		if (!rule) {
			return lab.commandDevice(a.id, a.command, args, { who: who });
		}
		return lab.safety.requestApproval({ who: who, device: a.id, command: a.command, args: args, reason: rule.reason || "approval required" })
			.then(() => lab.commandDevice(a.id, a.command, args, { who: who, approved: true }));
	});

	tool("tx_status", "Active RF transmit sessions (device, frequency, gain, started by, auto-stop deadline); the same list drives the lab's TX banner and kill switch", {}, () => {
		return { tx: lab.txSessions() };
	});

	tool("tx_kill", "Kill switch: stop one active RF transmit session (or all of them). Never needs approval.", { id: z.string().optional() }, (a) => {
		return lab.stopTxSession(a.id || null, "kill switch");
	});

	tool("safety_overview", "Safety rules (server-enforced), the approval policy, pending approvals and recent rule firings", {}, () => {
		return { rules: lab.safety.listRules(), policy: lab.safety.getPolicy(), pending: lab.safety.listPending(), fired: lab.safety.firedLog().slice(-20), bypass: lab.safety.bypassInfo() };
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

	// ---- hex editor --------------------------------------------------------

	const searchShape = {
		hex: z.string().optional().describe("hex pattern, ?? = any byte: \"de ad ?? ef\""),
		text: z.string().optional(),
		encoding: z.enum(["ascii", "latin1", "utf8", "utf16le"]).optional().describe("for text (default ascii)"),
		ignoreCase: z.boolean().optional().describe("for text: ASCII case-insensitive"),
		regex: z.string().optional().describe("JavaScript regex over the latin1 view (\\xNN = byte NN); offsets are byte offsets"),
		flags: z.string().optional().describe("regex flags: i, s, m")
	};

	tool("blob_peek", "Read part of a blob as hex / base64 / ascii / utf8 / utf16le / bin or as typed values "
		+ "(u8, i8, u16le, u16be, i16le, i16be, u32le, u32be, i32le, i32be, u64le, u64be, i64le, i64be (as strings), f32le, f32be, f64le, f64be)", {
		name: z.string(),
		offset: z.number().int().optional(),
		length: z.number().int().optional().describe("bytes, default 256, max 65536"),
		as: z.string().optional().describe("default hex")
	}, (a) => blobEdit.peek(lab, a));

	tool("blob_poke", "Overwrite bytes in a blob at offset: hex, or value + type (e.g. value \"0x1234\", type u16le; value 3.3, type f32le). "
		+ "Writing past the end extends the blob. Returns undo ops for blob_patch", {
		name: z.string(),
		offset: z.number().int(),
		hex: z.string().optional(),
		value: z.union([z.number(), z.string()]).optional(),
		type: z.string().optional().describe("u8…u64 / i8…i64 / f32 / f64 with le|be suffix (u8/i8 without)")
	}, (a) => blobEdit.poke(lab, a, "ai"));

	tool("blob_patch", "Apply edit ops to a blob in order, each seeing the previous result: "
		+ "{op:\"poke\", offset, hex} overwrite · {op:\"insert\", offset, hex} · {op:\"delete\", offset, length} · {op:\"fill\", offset, length, hex (pattern, default 00)}. "
		+ "base64 works instead of hex. Returns `undo` (ops that restore the blob)", {
		name: z.string(),
		ops: z.array(z.object({
			op: z.enum(["poke", "insert", "delete", "fill"]),
			offset: z.number().int(),
			length: z.number().int().optional(),
			hex: z.string().optional(),
			base64: z.string().optional()
		})).min(1)
	}, (a) => {
		const r = blobEdit.patch(lab, a, "ai");
		delete r.inverses;
		return r;
	});

	tool("blob_search", "Search a blob: hex with ?? wildcards, text (ascii / utf8 / utf16le, optional ignoreCase) or regex. "
		+ "dir all (default, non-overlapping hits) | next (first at/after from) | prev (last before from)", Object.assign({
		name: z.string(),
		dir: z.enum(["all", "next", "prev"]).optional(),
		from: z.number().int().optional(),
		start: z.number().int().optional().describe("range start"),
		end: z.number().int().optional().describe("range end (exclusive)"),
		max: z.number().int().optional().describe("most hits (default 1000, max 10000)"),
		wrap: z.boolean().optional()
	}, searchShape), (a) => blobEdit.search(lab, a));

	tool("blob_replace", "Find and replace in a blob: the next hit at/after `from`, or all hits (in [start, end)). "
		+ "find: {hex (?? wildcards) | text | regex}; replace: {hex | text, encoding}; ?? in a hex replacement keeps the matched byte. "
		+ "A different length inserts / deletes. Returns count and undo ops", {
		name: z.string(),
		find: z.union([z.string().describe("hex pattern"), z.object(searchShape)]),
		replace: z.union([z.string().describe("hex"), z.object({ hex: z.string().optional(), text: z.string().optional(), encoding: z.string().optional() })]),
		all: z.boolean().optional(),
		from: z.number().int().optional(),
		start: z.number().int().optional(),
		end: z.number().int().optional(),
		max: z.number().int().optional()
	}, (a) => blobEdit.replace(lab, a, "ai"));

	tool("blob_checksum", "Checksums / hashes over a blob range (default whole blob): CRC-8/16/32 variants (crc8, crc8-maxim, crc16-ccitt-false, crc16-xmodem, "
		+ "crc16-modbus, crc16-kermit, crc16-arc, crc32, crc32c, crc32-mpeg2 (STM32), …), adler32, sum8/16/32, word sums, xor8, twos8, inet16, md5, sha1, sha256, sha512, entropy, histogram", {
		name: z.string(),
		offset: z.number().int().optional(),
		length: z.number().int().optional(),
		algorithms: z.union([z.array(z.string()), z.literal("all")]).optional().describe("default: a common set; \"all\" for every one")
	}, (a) => blobEdit.checksum(lab, a));

	tool("blob_slice", "Copy a range of a blob into a new blob `to` (whole blob = save as / snapshot before editing)", {
		name: z.string(),
		offset: z.number().int().optional(),
		length: z.number().int().optional(),
		to: z.string()
	}, (a) => blobEdit.slice(lab, a, "ai"));

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

	// ---- media (ffmpeg / sox) ------------------------------------------------

	const mediaInput = (a) => (a.blob ? { data: lab.getBlob(a.blob).data } : { path: a.path });
	const mediaSource = { blob: z.string().optional().describe("lab blob holding the file (upload: PUT /api/blobs/:name)"), path: z.string().optional().describe("absolute path inside DATA_DIR/media or MAILAB_MEDIA_DIRS") };

	tool("media_probe", "Container, duration and streams (codec, sample rate, channels, video size, fps) of an audio/video file or blob", mediaSource, (a) => media.probe(mediaInput(a)));

	tool("audio_to_pcm", "Decode an audio (or video's audio) file/blob to raw PCM, stored as blob `name` (for kaitai/blob tools, flowgraph `audio_file`, analysis). "
		+ "Optionally also plays it into lab audio stream `name` for the audio pane", Object.assign({
		name: z.string(),
		rate: z.number().optional().describe("default 48000"),
		channels: z.number().optional().describe("default 1"),
		format: z.enum(["s16le", "f32le", "s32le", "u8"]).optional(),
		start: z.number().optional().describe("seconds"),
		duration: z.number().optional().describe("seconds"),
		engine: z.enum(["ffmpeg", "sox"]).optional(),
		play: z.boolean().optional()
	}, mediaSource), (a) => media.decodeAudio(mediaInput(a), a).then((r) => {
		lab.setBlob(a.name, r.pcm, actor());
		if (a.play && r.format === "s16le" && r.channels === 1) {
			// in ~0.1 s chunks, like a flowgraph audio sink
			const step = Math.round(r.rate / 10) * 2;
			for (let i = 0; i < r.pcm.length; i += step) {
				lab.pushAudio(a.name, r.rate, r.pcm.subarray(i, i + step).toString("base64"));
			}
		}
		return { blob: a.name, bytes: r.pcm.length, rate: r.rate, channels: r.channels, format: r.format, samples: r.samples, seconds: r.samples / r.rate };
	}));

	tool("audio_encode", "Encode a raw PCM blob to wav / flac / mp3 / ogg / opus (blob `name`)", {
		blob: z.string().describe("raw PCM blob"),
		name: z.string(),
		rate: z.number(),
		channels: z.number().optional(),
		format: z.enum(["s16le", "f32le", "s32le", "u8"]).optional(),
		codec: z.enum(["wav", "flac", "mp3", "ogg", "opus"]).optional(),
		bitrate: z.string().optional().describe("e.g. 128k")
	}, (a) => media.encodeAudio(lab.getBlob(a.blob).data, a).then((out) => {
		lab.setBlob(a.name, out, actor());
		return { blob: a.name, bytes: out.length };
	}));

	tool("video_frames", "Decode frames of a video file/blob into lab images `<name>_<n>` (look at them with image_get)", Object.assign({
		name: z.string(),
		fps: z.number().optional().describe("frames per second of video to take (default 1)"),
		start: z.number().optional().describe("seconds"),
		maxFrames: z.number().optional().describe("default 10, max 200"),
		width: z.number().optional().describe("scale to this width")
	}, mediaSource), (a) => media.videoFrames(mediaInput(a), a).then((frames) => {
		frames.forEach((png, i) => lab.setImage(a.name + "_" + i, png, "image/png"));
		return { images: frames.map((_png, i) => a.name + "_" + i) };
	}));

	tool("video_encode", "Encode lab images (same size, in order) into a video blob: mp4 / webm / gif (e.g. a time-lapse of camera snapshots)", {
		images: z.array(z.string()),
		name: z.string(),
		fps: z.number().optional(),
		format: z.enum(["mp4", "webm", "gif"]).optional()
	}, (a) => media.encodeVideo(a.images.map((n) => lab.getImage(n).data), a).then((out) => {
		lab.setBlob(a.name, out, actor());
		return { blob: a.name, bytes: out.length };
	}));

	tool("image_get", "Get an image (e.g. a scope screenshot) to look at", { name: z.string() }, (a) => {
		const img = lab.getImage(a.name);
		return { _image: { data: img.data.toString("base64"), mime: img.mime }, name: img.name, t: img.t };
	});

	// ---- research: FCC ID filings, datasheets -----------------------------

	tool("fccid_search", "Look up FCC equipment authorizations (via fccid.io, a mirror of the FCC's public records). "
		+ "An FCC ID (grantee + product code, e.g. 2AC7Z-ESP32WROOM32E, BCG-E2430A) gives the filing: description, grantee, grant dates, frequency ranges with output power, confidentiality and the exhibit list; "
		+ "a grantee code (2AC7Z) lists the company's FCC IDs; anything else (company, model) is a search", {
		query: z.string().describe("FCC ID, grantee code, company or model")
	}, (a) => {
		return research.fccid.find(a.query);
	});

	tool("fccid_exhibits", "Exhibits of an FCC ID: external/internal photos, block diagram, schematics, test reports, user manual... "
		+ "with links and whether each is public or held confidential (available: false). Fetch one with fccid_fetch", {
		fccId: z.string()
	}, (a) => {
		return research.fccid.exhibits(a.fccId);
	});

	tool("fccid_fetch", "Download an FCC exhibit into the lab: the file becomes blob `name`, PDF pages are rendered to images <name>_p1.. (you get the first one to look at; image_get the others). "
		+ "Give the exhibit url from fccid_exhibits, or fccId + type (substring of type/title, e.g. \"internal photo\", \"schematic\", \"block diagram\") + index", {
		url: z.string().optional().describe("exhibit page URL (from fccid_exhibits)"),
		fccId: z.string().optional(),
		type: z.string().optional(),
		index: z.number().optional().describe("n-th matching exhibit (default 0)"),
		name: z.string().optional().describe("blob/image name (default fcc_<document id>)"),
		pages: z.number().optional().describe("PDF pages to render as images (default 3, max 20, 0 = none)"),
		dpi: z.number().optional().describe("render resolution (default 100)")
	}, (a) => {
		return research.fccid.download({ url: a.url, fccId: a.fccId, type: a.type, index: a.index }).then((r) => {
			const name = labName(a.name || "fcc_" + (r.exhibit.documentId || r.exhibit.sha256 || Date.now()));
			lab.setBlob(name, r.data, "fccid");
			const out = {
				name: name,
				bytes: r.data.length,
				mime: r.mime,
				fccId: r.exhibit.fccId,
				type: r.exhibit.type,
				title: r.exhibit.title,
				documentTitle: r.exhibit.documentTitle,
				pages: r.exhibit.pages,
				source: r.exhibit.fileUrl,
				fccUrl: r.exhibit.fccUrl
			};
			if (/^image\//.test(r.mime)) {
				lab.setImage(name, r.data, r.mime);
				return Object.assign(out, { images: [name], _image: { data: r.data.toString("base64"), mime: r.mime } });
			}
			if (!pdfUtil.isPdf(r.data)) {
				return out;
			}
			const count = Math.min(MAX_RENDER_PAGES, a.pages === undefined ? DEFAULT_RENDER_PAGES : Math.max(0, a.pages));
			return pdfUtil.withTempFile(r.data, (file) => {
				return pdfUtil.info(file).then((info) => {
					const pages = Array.from({ length: Math.min(count, info.Pages || count) }, (_x, i) => i + 1);
					// one page at a time: pdftoppm on big scans is memory hungry
					return pages.reduce((chain, page) => chain.then((images) => {
						return pdfUtil.render(file, page, a.dpi || FCC_DPI).then((png) => {
							lab.setImage(name + "_p" + page, png, "image/png");
							return images.concat([{ name: name + "_p" + page, png: png }]);
						});
					}), Promise.resolve([])).then((images) => {
						const result = Object.assign(out, { pages: info.Pages, images: images.map((img) => img.name) });
						if (images.length) {
							result._image = { data: images[0].png.toString("base64"), mime: "image/png" };
						}
						return result;
					});
				});
			});
		});
	});

	tool("datasheet_search", "Find datasheets for a part number: the local datasheet DB (by name and full text) plus online candidates "
		+ "(manufacturer URL patterns verified as PDF; Mouser / Nexar-Octopart / DigiKey / SearXNG when their keys are configured). Store one with datasheet_fetch", {
		query: z.string().describe("part number, e.g. NE555, STM32F103C8, ESP32-WROOM-32"),
		online: z.boolean().optional().describe("default true; false = local DB only"),
		providers: z.array(z.string()).optional().describe("only these providers (manufacturer, mouser, nexar, digikey, searxng)")
	}, (a) => {
		return research.datasheets.search(a.query, { online: a.online, providers: a.providers });
	});

	tool("datasheet_fetch", "Download a datasheet PDF (url) into the local datasheet DB, or import a PDF lab blob; extracts the text of every page for datasheet_find", {
		url: z.string().optional(),
		blob: z.string().optional().describe("import this lab blob (a PDF) instead"),
		part: z.string().optional(),
		manufacturer: z.string().optional(),
		title: z.string().optional()
	}, (a) => {
		const info = { part: a.part, manufacturer: a.manufacturer, title: a.title };
		if (a.blob) {
			return research.datasheets.importPdf(lab.getBlob(a.blob).data, info);
		}
		return research.datasheets.fetch(Object.assign({ url: a.url }, info));
	});

	tool("datasheet_find", "Full-text search in the local datasheet DB with page numbers and snippets. "
		+ "kind finds sections: pinout, registers, ratings, package, timing. Then read the page with datasheet_page (rendered image + text)", {
		query: z.string().optional().describe("words that must all be on the page; \"quoted phrase\" for exact text"),
		kind: z.enum(Object.keys(research.datasheets.library().KINDS)).optional(),
		id: z.string().optional().describe("only this datasheet (id from datasheet_search)"),
		limit: z.number().optional()
	}, (a) => {
		return research.datasheets.find({ query: a.query, kind: a.kind, id: a.id, limit: a.limit });
	});

	tool("datasheet_page", "Render a datasheet page as lab image ds_<id>_p<page> to look at (pinout drawings, register tables, timing diagrams); text: true adds the page's extracted text", {
		id: z.string(),
		page: z.number(),
		dpi: z.number().optional().describe("default 110 (150-200 for small print)"),
		text: z.boolean().optional()
	}, (a) => {
		return research.datasheets.render(a.id, a.page, a.dpi).then((png) => {
			const name = labName("ds_" + a.id + "_p" + a.page);
			lab.setImage(name, png, "image/png");
			const out = { name: name, id: a.id, page: a.page, _image: { data: png.toString("base64"), mime: "image/png" } };
			if (a.text) {
				out.text = research.datasheets.library().pageText(a.id, a.page);
			}
			return out;
		});
	});

	tool("image_write", "Store an image (PNG / JPEG / ... as base64, or from a blob) as lab image `name`: a reference for vision_run align/template, a photo to analyze, a frame for a vision_watch", {
		name: z.string(),
		data: z.string().optional().describe("base64"),
		blob: z.string().optional().describe("take the bytes from this lab blob"),
		mime: z.string().optional().describe("default: sniffed (png / jpeg / gif / webp / bmp)")
	}, (a) => {
		const bytes = a.blob ? lab.getBlob(a.blob).data : Buffer.from(a.data || "", "base64");
		if (!bytes.length) {
			throw new Error("data (base64) or blob is required");
		}
		const mime = a.mime || vision.sniffMime(bytes);
		lab.setImage(a.name, bytes, mime);
		return { name: a.name, bytes: bytes.length, mime: mime };
	});

	// ---- vision (OpenCV) ---------------------------------------------------

	tool("vision_ops", "OpenCV ops for vision_run pipelines and ROI kinds for vision_watch, with their params", {}, () => ({ ops: vision.OPS, kinds: vision.KINDS }));

	tool("vision_run", "Run an OpenCV pipeline on a lab image (camera frame, screenshot, photo): ops in order, e.g. "
		+ "[{op: \"crop\", rect: [x, y, w, h]}, {op: \"seven_seg\", rect: [...], count: 4}, {op: \"led\", rect: [...]}, {op: \"ocr\", rect: [...], digits: true}, "
		+ "{op: \"aruco\", marker_mm: 20}, {op: \"measure\", points: [[x, y], [x, y]]}, {op: \"template\", template: \"<lab image>\"}, {op: \"align\", reference: \"<lab image>\"}]. "
		+ "Coordinates are image pixels (after earlier crop / warp / align). Overlays go to image <image>_annotated; show: true returns that image to look at. See vision_ops", {
		image: z.string(),
		ops: z.array(json),
		annotate: z.boolean().optional().describe("default true: store <image>_annotated"),
		output: z.string().optional().describe("store the final pipeline image (after crop / threshold / warp...) as this lab image"),
		show: z.boolean().optional().describe("return the annotated image")
	}, (a) => lab.vision.run({ image: a.image, ops: a.ops, annotate: a.annotate !== false || a.show, output: a.output }).then((out) => {
		const reply = Object.assign({}, out);
		delete reply.png;
		if (a.show && out.png) {
			reply._image = { data: out.png, mime: "image/png" };
		}
		return reply;
	}));

	tool("vision_watch", "Watch regions of an image stream (a camera's <cam>_frame, browser <dev>_frame, screenshots): every time the image updates (at most fps), "
		+ "each ROI is evaluated into channel <name>_<roi>; changes raise lab notifications {type: \"vision\", watch, roi, state, prev, line} "
		+ "(\"status LED turned red\", display shows \"Err\") pushed to this session (others: subscribe types [\"vision\"]). "
		+ "ROI kinds: led (1/0), seven_seg (number), value_ocr (number via tesseract), color (hue, state = colour name), motion (changed fraction), template (match score). "
		+ "Optional per ROI: above / below (notify on crossing), stable (frames a new state must hold), cooldownMs, notify: \"none\". "
		+ "Live results: value <name>_vision; overlays: image <name>_annotated. Same name replaces the watch; it persists with the lab", {
		name: z.string().describe("watch name: channel prefix"),
		image: z.string(),
		rois: z.array(z.object({
			name: z.string(),
			rect: z.array(z.number()).describe("[x, y, w, h] image px"),
			kind: z.enum(["led", "seven_seg", "value_ocr", "color", "motion", "template"]),
			params: json.optional(),
			above: z.number().optional(),
			below: z.number().optional(),
			stable: z.number().optional(),
			cooldownMs: z.number().optional(),
			notify: z.enum(["change", "none"]).optional()
		})),
		fps: z.number().optional().describe("evaluation rate cap (default 2, max 30); extra frames are dropped"),
		annotate: z.boolean().optional().describe("default true: image <name>_annotated")
	}, (a) => {
		const watch = lab.vision.add(a);
		if (ctx.session && !ctx.session.subs.some((sub) => sub.watch === a.name)) {
			ctx.session.subs.push({ id: "s" + (ctx.session.subs.length + 1), types: ["vision"], watch: a.name });
		}
		return watch;
	});

	tool("vision_unwatch", "Remove a vision watch", { name: z.string() }, (a) => {
		if (ctx.session) {
			ctx.session.subs = ctx.session.subs.filter((sub) => sub.watch !== a.name);
		}
		return lab.vision.remove(a.name);
	});

	tool("vision_watches", "Vision watches with their ROIs, stats (frames, dropped, errors, ms per frame) and the last state / value per ROI", {}, () => lab.vision.list());

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

	tool("pane_add", "Add a pane to the user's web UI (12-column grid; omitted x/y = append below). `tab` puts it on a dashboard tab (created if new; default: the first tab)", {
		type: z.string(),
		title: z.string().optional(),
		config: json.optional(),
		tab: z.string().optional(),
		collapsed: z.boolean().optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		w: z.number().optional(),
		h: z.number().optional()
	}, (a) => {
		return lab.panes.add(a);
	});

	tool("pane_update", "Change a pane (title, config — merged, position/size, tab — moves it to that tab, collapsed)", {
		id: z.string(),
		title: z.string().optional(),
		config: json.optional(),
		tab: z.string().optional(),
		collapsed: z.boolean().optional(),
		x: z.number().optional(),
		y: z.number().optional(),
		w: z.number().optional(),
		h: z.number().optional()
	}, (a) => {
		const changes = Object.assign({}, a);
		delete changes.id;
		return lab.panes.update(a.id, changes);
	});

	tool("pane_tabs", "Dashboard tabs (pages of panes): list, add, rename, remove (its panes move to `into` or the first other tab), order", {
		action: z.enum(["list", "add", "rename", "remove", "order"]),
		name: z.string().optional(),
		to: z.string().optional().describe("rename: new name"),
		into: z.string().optional().describe("remove: tab that gets the panes"),
		tabs: z.array(z.string()).optional().describe("order: tab names in order")
	}, (a) => {
		if (a.action === "add") {
			return lab.panes.addTab(a.name);
		}
		if (a.action === "rename") {
			return lab.panes.renameTab(a.name, a.to);
		}
		if (a.action === "remove") {
			return lab.panes.removeTab(a.name, a.into);
		}
		if (a.action === "order") {
			return lab.panes.orderTabs(a.tabs || []);
		}
		return lab.panes.tabs();
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

	tool("lab_save", "Save the whole lab setup (devices + options, panes, derived channels, safety rules + policy, classifier templates, trend patterns) as a named profile. "
		+ "A new name saves directly; overwriting an existing profile waits for a person's approval (they see what changes)", {
		name: z.string()
	}, (a) => {
		if (!lab.profiles.exists(a.name)) {
			return lab.profiles.save(a.name);
		}
		// the snapshot the person sees is the one saved: changes made while the
		// approval waits are not slipped in
		const snapshot = lab.exportState();
		const diff = lab.profiles.saveDiff(a.name, snapshot);
		return lab.safety.requestApproval({
			who: actor(), device: "lab", command: "save", args: { profile: a.name },
			reason: "overwrites profile \"" + a.name + "\"" + (diff.length ? ":\n" + diff.join("\n") : " (no changes)")
		}).then(() => lab.profiles.save(a.name, snapshot));
	});

	tool("lab_load", "Replace the lab with a saved profile (stops all devices). Waits for a person's approval: it can replace safety rules", {
		name: z.string()
	}, (a) => {
		const profile = lab.profiles.get(a.name);
		const diff = lab.profiles.loadDiff(a.name);
		return lab.safety.requestApproval({
			who: actor(), device: "lab", command: "load", args: { profile: a.name },
			reason: "replaces the whole lab with profile \"" + a.name + "\" (" + (profile.devices || []).length + " devices, safety rules included)"
				+ (diff.length ? ":\n" + diff.join("\n") : "")
		}).then(() => lab.importState(profile)).then((state) => ({ loaded: a.name, devices: state.devices.map((d) => d.id + ":" + d.state) }));
	});

	// ---- boards: PCB / schematic tracing ---------------------------------------

	const xy = z.array(z.number()).length(2);
	const region = {
		x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional()
	};

	tool("board_list", "Boards: tracing workspaces for reverse engineering PCBs / schematics (background layers + traced components, pins, wires)", {}, () => lab.boards.list());

	tool("board_get", "A board: layers (id, size, transform matrix [a,b,c,d,e,f] layer px → board units), traced components (refdes, pins with positions), "
		+ "wires, vias, labels, test points, notes, and the nets computed from that geometry. With a region (board units) or `text`, "
		+ "also the words on the layers there (refdes / net labels from PDFs)", Object.assign({
		name: z.string(),
		text: z.boolean().optional().describe("include layer words (inside the region if given)"),
		layer: z.string().optional().describe("only words of this layer"),
		geometry: z.boolean().optional().describe("include traced geometry (default true); false = summary + nets")
	}, region), (a) => {
		const snap = lab.boards.snapshot(a.name);
		const inRegion = a.w && a.h ? { x: a.x || 0, y: a.y || 0, w: a.w, h: a.h } : null;
		const out = Object.assign({}, snap);
		if (a.geometry === false) {
			["components", "wires", "vias", "labels", "testpoints", "notes"].forEach((k) => {
				out[k] = snap[k].length;
			});
		}
		if (a.text || inRegion) {
			out.text = lab.boards.text(a.name, { layer: a.layer, region: inRegion || undefined });
		}
		return out;
	});

	tool("board_import", "Import a PDF (each page becomes a background layer rendered to PNG, with its words extracted for search) "
		+ "or an image (photo of the top / bottom, SVG) into a board, creating the board if needed. Source: a file path on the lab host, a lab blob or a lab image", {
		name: z.string().describe("board name: letters, digits, _ . -"),
		path: z.string().optional(),
		blob: z.string().optional(),
		image: z.string().optional(),
		pages: z.string().optional().describe("PDF pages like \"1-3,7\" (default all, max 30 per import)"),
		dpi: z.number().optional().describe("PDF render resolution (default 150)"),
		label: z.string().optional(),
		side: z.string().optional().describe("top | bottom | any: which copper side the layer shows")
	}, (a) => {
		let data;
		if (a.path) {
			data = require("fs").readFileSync(a.path);
		} else if (a.blob) {
			data = lab.getBlob(a.blob).data;
		} else if (a.image) {
			data = lab.getImage(a.image).data;
		} else {
			throw new Error("give path, blob or image");
		}
		const label = a.label || (a.path ? require("path").basename(a.path).replace(/\.[^.]+$/, "") : a.blob || a.image);
		return lab.boards.importData(a.name, data, { pages: a.pages, dpi: a.dpi, label: label, side: a.side })
			.then((layers) => ({ layers: layers.map((l) => ({ id: l.id, name: l.name, width: l.width, height: l.height, words: l.words })) }));
	});

	tool("board_layer", "Change a board layer: visibility, opacity, side, order, transform (params: x, y, scale, rotate°, flip; or a raw matrix), "
		+ "or align it with 2 point pairs (similarity, optional mirror for bottom photos) or 3 (affine): from = layer pixels, to = board units. remove: true deletes the layer", {
		name: z.string(),
		layer: z.string(),
		visible: z.boolean().optional(),
		opacity: z.number().optional(),
		side: z.string().optional(),
		order: z.number().optional().describe("new index (0 = bottom)"),
		params: z.object({ x: z.number().optional(), y: z.number().optional(), scale: z.number().optional(), rotate: z.number().optional(), flip: z.boolean().optional() }).optional(),
		matrix: z.array(z.number()).length(6).optional(),
		align: z.array(z.object({ from: xy, to: xy })).optional(),
		flip: z.boolean().optional().describe("mirror while aligning with 2 pairs"),
		remove: z.boolean().optional()
	}, (a) => {
		if (a.remove) {
			return lab.boards.removeLayer(a.name, a.layer);
		}
		if (a.align) {
			lab.boards.alignLayer(a.name, a.layer, a.align, a.flip);
		}
		const changes = {};
		["visible", "opacity", "side", "order", "params", "matrix"].forEach((k) => {
			if (a[k] !== undefined) {
				changes[k] = a[k];
			}
		});
		return lab.boards.updateLayer(a.name, a.layer, changes);
	});

	tool("board_draw", "Trace on a board (all ops apply or none). Geometry IS the connectivity: wires (polylines) join pins, vias, labels, test points "
		+ "and other wires wherever their points touch (within board.snap units, also mid-segment T-junctions); sides (top/bottom/…) only meet the same side "
		+ "or unsided items (vias, THT parts). Net names are optional: a label on a wire or wire.net names the net, and equal names join. "
		+ "ops: {op: add|update|remove, kind, ...}: component {id: refdes, value, footprint, side, box: [x,y,w,h], pins: [{name, x, y}], rename}; "
		+ "pin {component, name, x, y}; wire {id?, points: [[x,y],...], side, width, net}; via {id?, x, y}; label {id?, x, y, name, side}; "
		+ "testpoint {id?, x, y, side, channel (lab channel measuring it), reading, unit}; note {id?, x, y, text}; net {name, color, notes}", {
		name: z.string(),
		ops: z.array(json)
	}, (a) => lab.boards.draw(a.name, a.ops));

	tool("board_search", "Search a board: words on its layers (PDF text: refdes, net labels, part numbers; with board-unit boxes) and the traced graph "
		+ "(components, nets, pins)", {
		name: z.string(),
		query: z.string(),
		regex: z.boolean().optional(),
		exact: z.boolean().optional().describe("whole word, case-insensitive")
	}, (a) => lab.boards.search(a.name, a.query, { regex: a.regex, exact: a.exact }));

	tool("board_graph", "Query the connectivity graph traced on a board. what: nets (all nets with pin counts) | net {net} (its pins, wires, test points) "
		+ "| pin {pin: \"U3.12\"} (its net and what else is on it) | neighbors {ref} (per pin: net + connected pins; neighbouring parts) "
		+ "| path {from, to} (shortest route between parts / pins / nets through components and nets) | search {text}. "
		+ "avoid: nets not to walk through (GND, VCC)", {
		name: z.string(),
		what: z.enum(["nets", "net", "pin", "neighbors", "path", "search"]),
		net: z.string().optional(),
		pin: z.string().optional(),
		ref: z.string().optional(),
		from: z.string().optional(),
		to: z.string().optional(),
		text: z.string().optional(),
		avoid: z.array(z.string()).optional()
	}, (a) => lab.boards.query(a.name, a));

	tool("board_netlist", "Export the netlist reconstructed from a board's tracing: json (components with pin nets, nets with nodes), csv (net,ref,pin) or kicad (.net)", {
		name: z.string(),
		format: z.enum(["json", "csv", "kicad"]).optional()
	}, (a) => {
		const out = lab.boards.netlist(a.name, a.format || "json");
		return typeof out === "string" ? { format: a.format, text: out } : out;
	});

	tool("board_view", "Look at a board region: renders it from one layer (default the top visible one; PDF layers are re-rendered sharp at the needed zoom) "
		+ "with the traced geometry drawn on top (net highlighted if given), returns the image and stores it as lab image <board>_view. "
		+ "toBoard maps image pixels to board units: x' = a*x + c*y + e, y' = b*x + d*y + f", Object.assign({
		name: z.string(),
		layer: z.string().optional(),
		maxPx: z.number().optional().describe("longest side of the image (default 1600)"),
		overlay: z.boolean().optional().describe("draw traced geometry (default true)"),
		net: z.string().optional().describe("net to highlight")
	}, region), (a) => lab.boards.view(a.name, a).then((v) => {
		const name = a.name + "_view";
		if (who.role === "rw" || who.role === "human") {
			lab.setImage(name, v.png, "image/png");
		}
		return { _image: { data: v.png.toString("base64"), mime: "image/png" }, image: name, layer: v.layer, width: v.width, height: v.height, toBoard: v.toBoard };
	}));

	tool("board_delete", "Delete a board with its layers and tracing. Waits for a person's approval", {
		name: z.string()
	}, (a) => {
		const board = lab.boards.get(a.name);
		return lab.safety.requestApproval({
			who: actor(), device: "board", command: "delete", args: { board: a.name },
			reason: "deletes board \"" + a.name + "\" (" + board.layers.length + " layers, " + board.components.length + " components, " + board.wires.length + " wires)"
		}).then(() => lab.boards.remove(a.name));
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
		+ "line clusters, debounced), match (template matches), line, udev (USB events matching an in-app udev rule), vision (vision_watch ROI changes). Optional filters: device, template, rule (udev rule id), watch (vision watch), pattern (regex on the line)", {
		types: z.array(z.enum(["rule", "approval", "trigger", "cluster", "match", "line", "udev", "vision"])),
		watch: z.string().optional().describe("vision watch name"),
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

	// ---- record & replay -------------------------------------------------

	tool("recordings", "Recordings on disk and running (name, channels, duration, counts). Play one back with device_add driver \"replay\" options {recording, prefix, speed, loop}", {}, () => lab.recordings.list());

	tool("recording_start", "Record channels (globs) plus traces, values, lab events and device log lines to DATA_DIR/recordings/<name>.ndjson, "
		+ "to replay later as a virtual device (driver \"replay\") and develop analysis/rules offline on real data", {
		name: z.string().describe("letters, digits, _ . - (max 64)"),
		channels: z.array(z.string()).describe("channel globs, e.g. [\"psu_*\", \"scope_ch1\"] or [\"*\"]"),
		traces: z.array(z.string()).optional().describe("trace globs (default: the channel globs)"),
		values: z.array(z.string()).optional().describe("value globs (default: the channel globs)"),
		events: z.boolean().optional().describe("lab events: triggers, rules, matches... (default true)"),
		logs: z.boolean().optional().describe("device log lines (default true)"),
		note: z.string().optional(),
		maxSeconds: z.number().optional().describe("stop automatically after N seconds")
	}, (a) => lab.recordings.start(a, actor()));

	tool("recording_stop", "Stop a running recording", { name: z.string() }, (a) => lab.recordings.stop(a.name));

	// ---- sweep & optimize -------------------------------------------------

	const axisShape = z.object({
		device: z.string(),
		command: z.string(),
		arg: z.string().optional().describe("the command argument to step, e.g. \"volts\" (or put \"$value\" in args)"),
		args: json.optional().describe("other arguments, e.g. {signal: \"sine\", key: \"freq\", value: \"$value\"}"),
		values: z.array(z.any()).optional().describe("explicit list of values"),
		from: z.number().optional(),
		to: z.number().optional(),
		steps: z.number().optional().describe("number of points, from..to inclusive"),
		scale: z.enum(["linear", "log"]).optional(),
		unit: z.string().optional()
	});
	const afterShape = z.object({ device: z.string(), command: z.string(), args: json.optional() }).optional()
		.describe("command run at the end, also after a failure (e.g. turn the output off)");

	tool("sweep", "Step one or two device-command parameters (x, optional y: a grid) over a range, wait settleMs, measure channels "
		+ "(mean over windowMs, or the first fresh sample with mode \"latest\") and return a table; stored as value `name` (json pane) "
		+ "and trace `name` (trace pane). stopWhen (mathjs over x, y and the read channels) ends early, e.g. brown-out: "
		+ "x = psu volts 3.3→1.5, reads [\"uart_alive\"], stopWhen \"uart_alive < 0.5\". "
		+ "Commands pass the approval policy: if any step needs approval a person approves the whole plan once", {
		name: z.string().optional().describe("value/trace name (default \"sweep\")"),
		x: axisShape,
		y: axisShape.optional(),
		reads: z.array(z.union([z.string(), z.object({ channel: z.string(), mode: z.enum(["mean", "latest"]).optional(), windowMs: z.number().optional() })])),
		settleMs: z.number().optional().describe("wait after setting (default 100)"),
		windowMs: z.number().optional().describe("measurement window (default 200)"),
		stopWhen: z.string().optional(),
		after: afterShape,
		trace: z.boolean().optional().describe("also store a trace (default true)"),
		yUnit: z.string().optional()
	}, (a) => sweepModule.sweep(lab, a, lab.safety.gate(actor())));

	tool("optimize", "Search one device-command parameter in [min, max] for the min or max of an objective (mathjs over channels, each the mean over windowMs after settleMs; x = the parameter). "
		+ "method golden (golden-section, unimodal objectives) or hill (hill-climb from start with step, halving). maxIterations = measurements (default 20, max 200). "
		+ "Stores value and scatter trace `name`. Commands pass the approval policy (one approval for the range)", {
		name: z.string().optional().describe("value/trace name (default \"optimize\")"),
		param: axisShape.extend({ min: z.number(), max: z.number() }),
		objective: z.string().describe("e.g. \"rx_rssi\", \"-abs(scope_vpp - 1)\", \"psu_v * psu_i\""),
		goal: z.enum(["min", "max"]).optional().describe("default min"),
		method: z.enum(["golden", "hill"]).optional(),
		maxIterations: z.number().optional(),
		tolerance: z.number().optional().describe("stop when the bracket/step is below this (default range/1000)"),
		step: z.number().optional().describe("hill: initial step (default range/10)"),
		start: z.number().optional().describe("hill: start point (default middle)"),
		settleMs: z.number().optional(),
		windowMs: z.number().optional(),
		mode: z.enum(["mean", "latest"]).optional(),
		after: afterShape
	}, (a) => sweepModule.optimize(lab, a, lab.safety.gate(actor())));

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
