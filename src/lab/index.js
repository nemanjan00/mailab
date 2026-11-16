// The lab: devices feed channels, traces, scatter datasets and images; math
// derives channels; panes describe the UI. Everything the web UI and the MCP
// server do goes through here. Emits:
//   "state"    devices / channels / panes / derived changed
//   "trace"    {name}               a trace was replaced or appended to
//   "image"    {name}
//   "value"    {name}               a JSON document changed
//   "audio"    {name, rate, data}   a chunk of base64 int16 PCM
//   "log"      {t, device, level, text}
//   "activity" {t, tool, args, ok, summary}

const EventEmitter = require("events");
const channelsModule = require("../channels");
const devices = require("../devices");
const math = require("../math");
const plotModule = require("../plot");
const safetyModule = require("../safety");
const classifyModule = require("../classify");
const trendsModule = require("../trends");
const profilesModule = require("../profiles");
const pathModule = require("path");
const panesModule = require("../panes");
const storeModule = require("../store");
const udevModule = require("../udev");
const usbService = require("../services/usb");

const LOG_SIZE = 2000;
const ACTIVITY_SIZE = 500;
const NOTIFY_SIZE = 500;
const CHAT_SIZE = 500;
const CHAT_PERSISTED = 200;
const MAX_SCATTER_POINTS = 100000;
const MAX_DERIVED_DEPTH = 8;

const DEFAULT_PANES = [
	{ type: "markdown", title: "mailab", x: 0, y: 0, w: 4, h: 4, config: { content: "# mailab\n\nThe AI owns this lab. Connect it over MCP at `/mcp`, or add devices and panes here.\n\n$$P = V \\cdot I$$" } },
	{ type: "devices", title: "Devices", x: 4, y: 0, w: 4, h: 4 },
	{ type: "activity", title: "AI activity", x: 8, y: 0, w: 4, h: 4 },
	{ type: "chart", title: "Live", x: 0, y: 4, w: 8, h: 5, config: { channels: [], seconds: 30 } },
	{ type: "channels", title: "Channels", x: 8, y: 4, w: 4, h: 5 }
];

const ring = (list, entry, size) => {
	list.push(entry);
	if (list.length > size) {
		list.splice(0, list.length - size);
	}
};

/**
 * @param {{dataDir: string, channelCapacity: number}} options
 */
const create = (options) => {
	const events = new EventEmitter();
	const store = storeModule.create(options.dataDir);
	const saved = store.load() || {};
	const channels = channelsModule.create(options.channelCapacity);
	const instances = {};
	const traces = {};
	const images = {};
	const values = {};
	const blobs = {};
	const logs = [];
	const activity = [];
	let activityId = 0;
	const notifications = [];
	let notifyId = 0;
	const chat = (saved.chat || []).slice();
	let chatId = chat.reduce((max, m) => Math.max(max, m.id), 0);
	const derived = {};
	// samples not yet pushed to web clients: name -> {t: [], v: []}
	let pending = {};

	const snapshot = () => {
		return {
			devices: Object.keys(instances).map((id) => {
				const inst = instances[id];
				return { id: id, driver: inst.driver, options: inst.options, enabled: inst.enabled };
			}),
			derived: Object.keys(derived).map((name) => {
				return { name: name, expression: derived[name].expression, unit: derived[name].unit };
			}),
			panes: panes.list(),
			chat: chat.slice(-CHAT_PERSISTED),
			safety: lab.safety.snapshot(),
			classifier: { templates: lab.classifier.snapshot() },
			trends: lab.trends.snapshot(),
			udev: lab.udev.snapshot()
		};
	};

	const changed = () => {
		store.save(snapshot);
		events.emit("state");
	};

	const panes = panesModule.create(saved.panes, changed);

	// /dev node -> lab devices using it (fixed paths and the ports drivers resolved)
	const devUsers = () => {
		const users = {};
		Object.keys(instances).forEach((id) => {
			const o = instances[id].options || {};
			const live = instances[id].instance && instances[id].instance.port ? [instances[id].instance.port()] : [];
			[o.path, o.port, o.device, o.conn].concat(live).filter((v) => typeof v === "string" && v.startsWith("/dev/")).forEach((dev) => {
				if ((users[dev] = users[dev] || []).indexOf(id) === -1) {
					users[dev].push(id);
				}
			});
		});
		return users;
	};

	const queue = (name, t, v) => {
		if (!pending[name]) {
			pending[name] = { t: [], v: [] };
		}
		pending[name].t.push(t);
		pending[name].v.push(v);
	};

	const runDerived = (input, t, depth) => {
		if (depth > MAX_DERIVED_DEPTH) {
			return;
		}
		Object.keys(derived).forEach((name) => {
			const d = derived[name];
			if (d.inputs.indexOf(input) === -1) {
				return;
			}
			const scope = {};
			const ready = d.inputs.every((symbol) => {
				const latest = channels.latest(symbol);
				if (latest) {
					scope[symbol] = latest.v;
				}
				// unknown symbols are mathjs constants/functions (pi, sqrt, ...)
				return latest || !channels.has(symbol);
			});
			if (!ready) {
				return;
			}
			let value;
			try {
				value = d.evaluate(scope);
			} catch (_err) {
				return;
			}
			if (Number.isFinite(value)) {
				lab.pushSample(name, value, { t: t }, depth + 1);
			}
		});
	};

	let stopSafety = null;
	let stopTrends = null;
	let stopUdev = null;

	const lab = {
		events: events,
		channels: channels,

		// ---- data -------------------------------------------------------

		/**
		 * @param {string} name channel
		 * @param {number} value
		 * @param {{t: number, unit: string, source: string}} [meta]
		 */
		pushSample: (name, value, meta, depth) => {
			const m = meta || {};
			const isNew = !channels.has(name);
			channels.ensure(name, { unit: m.unit, source: m.source });
			const t = m.t || Date.now();
			const v = Number(value);
			channels.push(name, t, v);
			queue(name, t, v);
			if (isNew) {
				events.emit("state");
			}
			runDerived(name, t, depth || 0);
			lab.safety.onSample(name);
			lab.trends.sample(name, t, v);
		},

		drainPending: () => {
			const out = pending;
			pending = {};
			return out;
		},

		/**
		 * Replace a trace.
		 * @param {{x: number[], series: Object[], xUnit: string, yUnit: string, mode: string}} data
		 */
		setTrace: (name, data, source) => {
			const isNew = !traces[name];
			traces[name] = {
				name: name,
				source: source || "",
				x: data.x || [],
				series: data.series || [],
				xUnit: data.xUnit || "",
				yUnit: data.yUnit || "",
				mode: data.mode || "line",
				// optional [{name, value, unit}] shown as a table under the plot (scope measurements)
				measurements: data.measurements || null,
				t: Date.now()
			};
			if (isNew) {
				events.emit("state");
			}
			events.emit("trace", { name: name });
		},

		/**
		 * Append a classified point to a scatter dataset (one series per class).
		 * @param {{x: number, y: number, class: string, info: string, xLabel: string, yLabel: string}} p
		 */
		addPoint: (name, p, source) => {
			if (!traces[name]) {
				lab.setTrace(name, { mode: "scatter", xUnit: p.xLabel || "x", yUnit: p.yLabel || "y" }, source);
			}
			const trace = traces[name];
			let series = trace.series.find((s) => {
				return s.label === p.class;
			});
			if (!series) {
				series = { label: p.class, x: [], y: [] };
				trace.series.push(series);
			}
			if (series.x.length < MAX_SCATTER_POINTS) {
				series.x.push(p.x);
				series.y.push(p.y);
			}
			trace.t = Date.now();
			events.emit("trace", { name: name });
		},

		getTrace: (name) => {
			if (!traces[name]) {
				throw new Error("unknown trace: " + name);
			}
			return traces[name];
		},

		listTraces: () => {
			return Object.keys(traces).sort().map((name) => {
				const tr = traces[name];
				return {
					name: name,
					source: tr.source,
					mode: tr.mode,
					points: tr.x.length || tr.series.reduce((n, s) => {
						return n + ((s.x && s.x.length) || 0);
					}, 0),
					series: tr.series.map((s) => {
						return s.label;
					}),
					xUnit: tr.xUnit,
					yUnit: tr.yUnit,
					t: tr.t
				};
			});
		},

		setImage: (name, buffer, mime) => {
			const isNew = !images[name];
			images[name] = { name: name, mime: mime || "image/png", data: buffer, t: Date.now() };
			if (isNew) {
				events.emit("state");
			}
			events.emit("image", { name: name });
		},

		getImage: (name) => {
			if (!images[name]) {
				throw new Error("unknown image: " + name);
			}
			return images[name];
		},

		listImages: () => {
			return Object.keys(images).sort().map((name) => {
				return { name: name, mime: images[name].mime, t: images[name].t };
			});
		},

		/**
		 * Named JSON documents (graph descriptions, decoded packets, parse trees...).
		 */
		setValue: (name, value, source) => {
			const isNew = !values[name];
			values[name] = { name: name, source: source || "", value: value, t: Date.now() };
			if (isNew) {
				events.emit("state");
			}
			events.emit("value", { name: name });
		},

		getValue: (name) => {
			if (!values[name]) {
				throw new Error("unknown value: " + name);
			}
			return values[name];
		},

		listValues: () => {
			return Object.keys(values).sort().map((name) => {
				return { name: name, source: values[name].source, t: values[name].t };
			});
		},

		/**
		 * Named binary data: memory dumps, captures, received frames.
		 */
		setBlob: (name, data, source) => {
			const isNew = !blobs[name];
			blobs[name] = { name: name, source: source || "", data: Buffer.from(data), t: Date.now() };
			if (isNew) {
				events.emit("state");
			}
			events.emit("blob", { name: name });
		},

		getBlob: (name) => {
			if (!blobs[name]) {
				throw new Error("unknown blob: " + name);
			}
			return blobs[name];
		},

		listBlobs: () => {
			return Object.keys(blobs).sort().map((name) => {
				return { name: name, source: blobs[name].source, bytes: blobs[name].data.length, t: blobs[name].t };
			});
		},

		/**
		 * Audio is streamed, not stored: chunks go straight to listening browsers.
		 */
		pushAudio: (name, rate, data) => {
			events.emit("audio", { name: name, rate: rate, data: data });
		},

		log: (device, text, level) => {
			const entry = { t: Date.now(), device: device, level: level || "info", text: String(text) };
			ring(logs, entry, LOG_SIZE);
			events.emit("log", entry);
		},

		getLogs: (options) => {
			const opts = options || {};
			return logs.filter((entry) => {
				return !opts.device || entry.device === opts.device;
			}).slice(-(opts.last || 200));
		},

		recordActivity: (entry) => {
			activityId++;
			const full = Object.assign({ id: activityId, t: Date.now() }, entry);
			ring(activity, full, ACTIVITY_SIZE);
			events.emit("activity", full);
		},

		getActivity: () => {
			return activity;
		},

		/**
		 * Lab events for subscribers (MCP sessions, the channel bridge, the UI):
		 * {type: rule | approval | trigger | cluster | match | line, ...}
		 */
		notify: (event) => {
			notifyId++;
			const full = Object.assign({ id: notifyId, t: Date.now() }, event);
			ring(notifications, full, NOTIFY_SIZE);
			events.emit("notify", full);
			return full;
		},

		getNotifications: (options) => {
			const opts = options || {};
			return notifications.filter((n) => opts.since === undefined || n.id > opts.since).slice(-(opts.last || 100));
		},

		/**
		 * Lab chat between people (web UI) and AIs (MCP).
		 * @param {{from: string, kind: string, text: string, session: string}} msg
		 *   kind "human" | "ai"; session: MCP session that sent it (not echoed back to it)
		 */
		postChat: (msg) => {
			if (!msg.text || !String(msg.text).trim()) {
				throw new Error("empty message");
			}
			chatId++;
			const entry = { id: chatId, t: Date.now(), from: msg.from || "anonymous", kind: msg.kind || "human", text: String(msg.text) };
			if (msg.approval) {
				entry.approval = { id: msg.approval.id };
			}
			ring(chat, entry, CHAT_SIZE);
			store.save(snapshot);
			events.emit("chat", Object.assign({ session: msg.session }, entry));
			return entry;
		},

		getChat: (options) => {
			const opts = options || {};
			return chat.filter((m) => {
				return opts.since === undefined || m.id > opts.since;
			}).slice(-(opts.last || 100));
		},

		// ---- devices ----------------------------------------------------

		/**
		 * @param {string} [requestedId] device id, becomes the channel prefix
		 *   (<id>_<field>); empty = <driver>, <driver>2, ...
		 * @param {string} driverName
		 * @param {Object} options driver options
		 */
		addDevice: (requestedId, driverName, options) => {
			const id = requestedId || lab.nextDeviceId(driverName);
			if (!channelsModule.isValidName(id)) {
				throw new Error("invalid device id: " + id + " (letters, digits, _)");
			}
			if (instances[id]) {
				throw new Error("device exists: " + id);
			}
			// throws on unknown driver
			devices.get(driverName);
			instances[id] = { id: id, driver: driverName, options: options || {}, enabled: true, state: "stopped", detail: "", instance: null };
			changed();
			return lab.startDevice(id);
		},

		/**
		 * First free id for another instance of a driver: sim, sim2, sim3 ...
		 */
		nextDeviceId: (driverName) => {
			const base = channelsModule.sanitizeName(driverName);
			let n = 1;
			let id = base;
			while (instances[id]) {
				n++;
				id = base + n;
			}
			return id;
		},

		startDevice: (id) => {
			const inst = lab.getDevice(id);
			const driver = devices.get(inst.driver);
			const field = (name) => {
				return id + "_" + channelsModule.sanitizeName(name);
			};
			const io = {
				// device id, e.g. for owning shared ports
				id: id,
				sample: (name, value, meta) => {
					const m = meta || {};
					lab.pushSample(field(name), value, { t: m.t, unit: m.unit, source: id });
				},
				samples: (name, t, v, unit) => {
					t.forEach((ts, i) => {
						lab.pushSample(field(name), v[i], { t: ts, unit: unit, source: id });
					});
				},
				meta: (name, meta) => {
					channels.ensure(field(name), meta);
					events.emit("state");
				},
				trace: (name, data) => {
					lab.setTrace(field(name), data, id);
				},
				point: (name, p) => {
					lab.addPoint(field(name), p, id);
				},
				image: (name, buffer, mime) => {
					lab.setImage(field(name), buffer, mime);
				},
				value: (name, value) => {
					lab.setValue(field(name), value, id);
				},
				blob: (name, data) => {
					lab.setBlob(field(name), data, id);
				},
				// a device's custom pane: created once, then its layout follows the device
				panel: (name, layout, opts) => {
					const paneId = id + "-" + channelsModule.sanitizeName(name);
					// commands without a device go to this one
					const bind = (node) => {
						if (Array.isArray(node)) {
							return node.map(bind);
						}
						if (node && typeof node === "object") {
							const out = {};
							Object.keys(node).forEach((k) => {
								out[k] = bind(node[k]);
							});
							if (out.command && !out.device) {
								out.device = id;
							}
							return out;
						}
						return node;
					};
					const config = { layout: bind(layout) };
					const o = opts || {};
					if (panes.list().some((p) => p.id === paneId)) {
						panes.update(paneId, { config: config });
					} else {
						panes.add({ id: paneId, type: "custom", title: o.title || id + " " + name, config: config, w: o.w || 6, h: o.h || 6 });
					}
				},
				event: (name, data) => {
					lab.notify(Object.assign({ type: "trigger", device: id, name: field(name) }, data || {}));
				},
				audio: (name, rate, data) => {
					lab.pushAudio(field(name), rate, data);
				},
				// drivers persisting their own state (e.g. a flowgraph) into options
				setOptions: (changes) => {
					inst.options = Object.assign({}, inst.options, changes);
					changed();
				},
				log: (text, level) => {
					lab.log(id, text, level);
				},
				status: (state, detail) => {
					inst.state = state;
					inst.detail = detail || "";
					events.emit("state");
				}
			};
			inst.enabled = true;
			inst.state = "starting";
			inst.detail = "";
			events.emit("state");
			return Promise.resolve()
				.then(() => {
					inst.instance = driver.create(inst.options, io);
					return inst.instance.start();
				})
				.then(() => {
					if (inst.state === "starting") {
						io.status("running");
					}
					changed();
					return lab.describeDevice(id);
				}, (err) => {
					io.status("error", err.message);
					lab.log(id, "start failed: " + err.message, "error");
					// release whatever the driver grabbed (ports, shared bridges)
					const failed = inst.instance;
					inst.instance = null;
					changed();
					let cleanup = Promise.resolve();
					if (failed) {
						cleanup = Promise.resolve().then(failed.stop).catch(() => {
							return null;
						});
					}
					return cleanup.then(() => {
						return lab.describeDevice(id);
					});
				});
		},

		stopDevice: (id) => {
			const inst = lab.getDevice(id);
			inst.enabled = false;
			let stopping = Promise.resolve();
			if (inst.instance) {
				stopping = inst.instance.stop();
			}
			return stopping.catch((err) => {
				lab.log(id, "stop failed: " + err.message, "warn");
			}).then(() => {
				inst.instance = null;
				inst.state = "stopped";
				changed();
				return lab.describeDevice(id);
			});
		},

		removeDevice: (id) => {
			return lab.stopDevice(id).then(() => {
				delete instances[id];
				changed();
			});
		},

		commandDevice: (id, name, args) => {
			const inst = lab.getDevice(id);
			if (!inst.instance || inst.state === "error" || inst.state === "stopped") {
				return Promise.reject(new Error("device " + id + " is " + inst.state + (inst.detail ? ": " + inst.detail : "")));
			}
			return inst.instance.command(name, args || {});
		},

		getDevice: (id) => {
			if (!instances[id]) {
				throw new Error("unknown device: " + id);
			}
			return instances[id];
		},

		describeDevice: (id) => {
			const inst = lab.getDevice(id);
			return {
				id: id,
				driver: inst.driver,
				options: inst.options,
				state: inst.state,
				detail: inst.detail,
				commands: devices.get(inst.driver).commands
			};
		},

		listDevices: () => {
			return Object.keys(instances).sort().map(lab.describeDevice);
		},

		// ---- math -------------------------------------------------------

		/**
		 * Evaluate an expression; each channel symbol is the vector of its
		 * last `samples` values, each trace symbol is {x, y} of its first series.
		 */
		/**
		 * Scope for expressions: each channel symbol is the vector of its last
		 * `samples` values, each trace symbol is {x, y} of its first series
		 * (`<name>_x` for x).
		 */
		scopeFor: (symbols, options) => {
			const opts = options || {};
			const scope = {};
			symbols.forEach((symbol) => {
				const base = symbol.replace(/_x$/, "");
				const aged = symbol.replace(/_age$/, "");
				if (channels.has(symbol) && opts.latest) {
					const last = channels.latest(symbol);
					if (last) {
						scope[symbol] = last.v;
					}
				} else if (channels.has(symbol)) {
					scope[symbol] = channels.read(symbol, { last: opts.samples || 1000, seconds: opts.seconds }).v;
				} else if (symbol !== aged && channels.has(aged)) {
					// seconds since the channel's last sample ("silent for 5 s")
					const last = channels.latest(aged);
					scope[symbol] = last ? (Date.now() - last.t) / 1000 : Infinity;
				} else if (traces[symbol]) {
					scope[symbol] = traces[symbol].series[0].y;
				} else if (traces[base]) {
					scope[symbol] = traces[base].x;
				}
			});
			return scope;
		},

		isLabSymbol: (symbol) => {
			return channels.has(symbol) || Boolean(traces[symbol]) || channels.has(symbol.replace(/_age$/, ""));
		},

		evaluate: (expression, options) => {
			return math.evaluate(expression, lab.scopeFor(math.symbols(expression), options));
		},

		/**
		 * Graphing calculator; see src/plot. `name` also stores the result as a trace.
		 */
		plot: (spec, name) => {
			const result = plotModule.plot((symbols) => lab.scopeFor(symbols, { samples: spec.samples }), spec);
			if (name) {
				lab.setTrace(name, result, spec.source || "plot");
			}
			return result;
		},

		defineDerived: (name, expression, unit) => {
			if (!channelsModule.isValidName(name)) {
				throw new Error("invalid channel name: " + name);
			}
			const compiled = math.compile(expression);
			if (compiled.inputs.indexOf(name) !== -1) {
				throw new Error("derived channel cannot depend on itself");
			}
			derived[name] = Object.assign(compiled, { unit: unit || "" });
			channels.ensure(name, { unit: unit, source: "math", description: expression });
			changed();
			return { name: name, expression: expression, inputs: compiled.inputs };
		},

		removeDerived: (name) => {
			delete derived[name];
			channels.remove(name);
			changed();
		},

		listDerived: () => {
			return Object.keys(derived).map((name) => {
				return { name: name, expression: derived[name].expression, inputs: derived[name].inputs, unit: derived[name].unit };
			});
		},

		// ---- ui ---------------------------------------------------------

		panes: panes,

		state: () => {
			return {
				devices: lab.listDevices(),
				channels: channels.list(),
				traces: lab.listTraces(),
				images: lab.listImages(),
				values: lab.listValues(),
				blobs: lab.listBlobs(),
				derived: lab.listDerived(),
				panes: panes.list(),
				paneTypes: panesModule.TYPES
			};
		},

		// ---- lifecycle --------------------------------------------------

		restore: () => {
			lab.classifier.restore();
			lab.safety.restore();
			stopSafety = lab.safety.start();
			stopTrends = lab.trends.start();
			if (options.watchUsb !== false) {
				stopUdev = lab.udev.start();
			}
			if (!saved.panes) {
				DEFAULT_PANES.forEach(panes.add);
			}
			(saved.derived || []).forEach((d) => {
				try {
					lab.defineDerived(d.name, d.expression, d.unit);
				} catch (err) {
					lab.log("lab", "derived " + d.name + ": " + err.message, "error");
				}
			});
			return Promise.all((saved.devices || []).map((d) => {
				instances[d.id] = { id: d.id, driver: d.driver, options: d.options || {}, enabled: d.enabled, state: "stopped", detail: "", instance: null };
				if (!d.enabled) {
					return null;
				}
				return lab.startDevice(d.id);
			}));
		},

		// ---- USB ------------------------------------------------------------

		/**
		 * USB serial ports with their adapter identity and the lab devices on them.
		 */
		uartPorts: () => {
			const users = devUsers();
			return usbService.serialPorts(usbService.inventory().buses).map((p) => Object.assign(p, { labDevices: users[p.node] || [] }));
		},

		/**
		 * USB tree with power status and which lab device uses which /dev node.
		 */
		usbTree: () => {
			const usb = usbService;
			const users = devUsers();
			const link = (n) => {
				const out = Object.assign({}, n, { labDevices: [].concat(...n.nodes.map((dev) => users[dev] || [])) });
				if (n.ports) {
					out.ports = n.ports.map((p) => ({ port: p.port, device: p.device ? link(p.device) : null }));
				}
				return out;
			};
			const inv = usb.inventory();
			return usb.power().then((power) => ({ controllers: inv.controllers, tree: inv.buses.map(link), power: power }));
		},

		// ---- whole-lab state (profiles) --------------------------------------

		/**
		 * Everything that defines the lab's setup (not its data).
		 */
		exportState: () => {
			const snap = snapshot();
			delete snap.chat;
			return Object.assign({ mailab: 1, savedAt: new Date().toISOString() }, snap);
		},

		/**
		 * Replace the lab's setup with `state` (from exportState / a profile):
		 * stops all devices, applies everything, starts enabled devices.
		 */
		importState: (state) => {
			if (!state || state.mailab !== 1) {
				throw new Error("not a mailab lab state (expected {mailab: 1, ...})");
			}
			return Promise.all(Object.keys(instances).map((id) => lab.removeDevice(id))).then(() => {
				Object.keys(derived).forEach((name) => lab.removeDerived(name));
				(state.derived || []).forEach((d) => lab.defineDerived(d.name, d.expression, d.unit));
				panes.replaceAll(state.panes || []);
				lab.safety.load(state.safety || {});
				lab.classifier.load((state.classifier && state.classifier.templates) || []);
				lab.udev.load(state.udev || []);
				if (state.trends && state.trends.patterns) {
					lab.trends.setPatterns(state.trends.patterns);
				}
				return Promise.all((state.devices || []).map((d) => {
					instances[d.id] = { id: d.id, driver: d.driver, options: d.options || {}, enabled: d.enabled, state: "stopped", detail: "", instance: null };
					return d.enabled ? lab.startDevice(d.id) : null;
				}));
			}).then(() => {
				changed();
				return lab.state();
			});
		},

		shutdown: () => {
			if (stopSafety) {
				stopSafety();
			}
			if (stopTrends) {
				stopTrends();
			}
			if (stopUdev) {
				stopUdev();
			}
			return Promise.all(Object.keys(instances).map((id) => {
				const inst = instances[id];
				if (!inst.instance) {
					return null;
				}
				return inst.instance.stop().catch(() => {
					return null;
				});
			})).then(() => {
				store.saveNow(snapshot());
			});
		}
	};

	lab.safety = safetyModule.create(lab, saved.safety);
	lab.safety.changed = changed;
	lab.trends = trendsModule.create(pathModule.join(options.dataDir, "trends"), saved.trends);
	lab.profiles = profilesModule.create(lab, pathModule.join(options.dataDir, "profiles"));
	lab.classifier = classifyModule.create(lab, saved.classifier);
	lab.classifier.changed = changed;
	lab.udev = udevModule.create({
		scan: () => usbService.inventory().buses,
		notify: (ev) => lab.notify(ev),
		onChange: changed
	}, saved.udev);

	return lab;
};

module.exports = {
	create: create
};
