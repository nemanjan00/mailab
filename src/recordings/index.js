// Recordings: capture channels (globs), traces, values, lab events and device
// log lines to DATA_DIR/recordings/<name>.ndjson, to replay later as a
// virtual device (src/devices/replay) and develop analysis offline.
//
// File: one JSON object per line, in arrival order (not strictly by t):
//   {type: "header", mailab_recording: 1, name, started, channels, traces, values, events, logs, note, who}
//   {type: "channel", name, unit}           first sample of a channel
//   {type: "s", c, t, v}                    a sample
//   {type: "trace", name, t, data}          a trace snapshot (throttled)
//   {type: "value", name, t, value}
//   {type: "event", t, event}               a lab notification (approvals excluded)
//   {type: "log", t, device, level, text}
//   {type: "end", t, counts, reason}        missing if the server died mid-recording

const fs = require("fs");
const path = require("path");
const glob = require("../utils/glob");

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const FLUSH_MS = 200;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_LOAD_BYTES = 512 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
// lab events never worth replaying (people decide approvals live)
const SKIP_EVENTS = ["approval"];

const fileFor = (dir, name) => {
	if (!NAME_RE.test(String(name)) || String(name).startsWith(".")) {
		throw new Error("recording names: letters, digits, _ . - (max 64)");
	}
	return path.join(dir, name + ".ndjson");
};

const lastLine = (file, size) => {
	const length = Math.min(size, TAIL_BYTES);
	const fd = fs.openSync(file, "r");
	const buffer = Buffer.alloc(length);
	fs.readSync(fd, buffer, 0, length, size - length);
	fs.closeSync(fd);
	const lines = buffer.toString("utf8").split("\n").filter(Boolean);
	return lines[lines.length - 1] || "";
};

const firstLine = (file) => {
	const fd = fs.openSync(file, "r");
	const buffer = Buffer.alloc(TAIL_BYTES);
	const n = fs.readSync(fd, buffer, 0, TAIL_BYTES, 0);
	fs.closeSync(fd);
	return buffer.slice(0, n).toString("utf8").split("\n")[0];
};

const parse = (line) => {
	try {
		return JSON.parse(line);
	} catch (_err) {
		return null;
	}
};

/**
 * Load a recording for playback: records sorted by t (stable).
 * @param {string} dir DATA_DIR/recordings
 * @param {string} name
 * @returns {{header: Object, end: Object, units: Object, records: Object[], t0: number, t1: number}}
 */
const load = (dir, name) => {
	const file = fileFor(dir, name);
	if (!fs.existsSync(file)) {
		throw new Error("no recording " + name);
	}
	if (fs.statSync(file).size > MAX_LOAD_BYTES) {
		throw new Error("recording " + name + " is larger than " + MAX_LOAD_BYTES + " bytes");
	}
	const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(parse).filter(Boolean);
	const header = lines.find((l) => l.type === "header") || {};
	const end = lines.find((l) => l.type === "end") || null;
	const units = {};
	lines.filter((l) => l.type === "channel").forEach((l) => {
		units[l.name] = l.unit || "";
	});
	const records = lines
		.filter((l) => ["s", "trace", "value", "event", "log"].indexOf(l.type) !== -1 && Number.isFinite(l.t))
		.map((l, i) => Object.assign({ i: i }, l))
		.sort((a, b) => a.t - b.t || a.i - b.i);
	let t0 = header.started || 0;
	let t1 = t0;
	if (records.length) {
		t0 = records[0].t;
		t1 = records[records.length - 1].t;
	}
	return { header: header, end: end, units: units, records: records, t0: t0, t1: t1 };
};

/**
 * @param {Object} lab
 * @param {string} dir DATA_DIR/recordings
 */
const create = (lab, dir) => {
	// name -> active recording
	const active = {};

	const describe = (rec) => ({
		name: rec.name,
		active: true,
		started: rec.header.started,
		channels: rec.header.channels,
		traces: rec.header.traces,
		values: rec.header.values,
		events: rec.header.events,
		logs: rec.header.logs,
		note: rec.header.note,
		bytes: rec.bytes,
		counts: Object.assign({}, rec.counts),
		seconds: (Date.now() - rec.header.started) / 1000
	});

	const write = (rec, entry) => {
		const line = JSON.stringify(entry) + "\n";
		rec.lines.push(line);
		rec.bytes += Buffer.byteLength(line);
		if (rec.bytes > rec.maxBytes && !rec.stopping) {
			rec.stopping = true;
			setImmediate(() => {
				lab.log("lab", "recording " + rec.name + " reached " + rec.maxBytes + " bytes: stopped", "warn");
				recordings.stop(rec.name, "maxBytes");
			});
		}
	};

	const flushOne = (rec) => {
		Object.keys(rec.dirtyTraces).forEach((name) => {
			let tr;
			try {
				tr = lab.getTrace(name);
			} catch (_err) {
				tr = null;
			}
			if (tr) {
				rec.counts.traces++;
				write(rec, { type: "trace", name: name, t: rec.dirtyTraces[name], data: { x: tr.x, series: tr.series, xUnit: tr.xUnit, yUnit: tr.yUnit, mode: tr.mode, measurements: tr.measurements } });
			}
		});
		rec.dirtyTraces = {};
		if (rec.lines.length) {
			fs.appendFileSync(rec.file, rec.lines.join(""));
			rec.lines = [];
		}
	};

	const each = (fn) => {
		Object.keys(active).forEach((name) => fn(active[name]));
	};

	const recordings = {
		/**
		 * @param {{name: string, channels: string[], traces: string[], values: string[], events: boolean, logs: boolean, note: string, maxSeconds: number, maxBytes: number}} spec
		 *   traces/values default to the channel globs; events and logs default true
		 * @param {string} [who]
		 */
		start: (spec, who) => {
			const s = spec || {};
			const file = fileFor(dir, s.name);
			if (active[s.name]) {
				throw new Error("recording " + s.name + " is already running");
			}
			if (fs.existsSync(file)) {
				throw new Error("recording " + s.name + " exists (pick another name or delete it)");
			}
			const channels = s.channels || [];
			if (!Array.isArray(channels) || !channels.length) {
				throw new Error("give channel globs to record, e.g. [\"psu_*\"] or [\"*\"]");
			}
			const traces = s.traces || channels;
			const values = s.values || channels;
			const header = {
				type: "header",
				mailab_recording: 1,
				name: s.name,
				started: Date.now(),
				channels: channels,
				traces: traces,
				values: values,
				events: s.events !== false,
				logs: s.logs !== false,
				note: s.note || "",
				who: who || ""
			};
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, JSON.stringify(header) + "\n");
			const rec = {
				name: s.name,
				file: file,
				header: header,
				matchChannel: glob.matcher(channels),
				matchTrace: glob.matcher(traces),
				matchValue: glob.matcher(values),
				lines: [],
				bytes: 0,
				maxBytes: s.maxBytes || DEFAULT_MAX_BYTES,
				counts: { samples: 0, channels: 0, traces: 0, values: 0, events: 0, logs: 0 },
				seen: {},
				dirtyTraces: {},
				timer: null,
				stopping: false
			};
			if (s.maxSeconds) {
				rec.timer = setTimeout(() => recordings.stop(s.name, "maxSeconds"), s.maxSeconds * 1000);
				rec.timer.unref();
			}
			active[s.name] = rec;
			lab.events.emit("recording", { name: s.name, active: true });
			return describe(rec);
		},

		/**
		 * @returns {Object} summary of the finished recording
		 */
		stop: (name, reason) => {
			const rec = active[name];
			if (!rec) {
				throw new Error("recording " + name + " is not running");
			}
			clearTimeout(rec.timer);
			flushOne(rec);
			const end = { type: "end", t: Date.now(), counts: rec.counts, reason: reason || "stopped" };
			fs.appendFileSync(rec.file, JSON.stringify(end) + "\n");
			delete active[name];
			lab.events.emit("recording", { name: name, active: false });
			return Object.assign(describe(rec), { active: false, stopped: end.t, reason: end.reason, bytes: fs.statSync(rec.file).size });
		},

		stopAll: (reason) => Object.keys(active).map((name) => recordings.stop(name, reason)),

		/**
		 * Active recordings plus the ones on disk, newest first.
		 */
		list: () => {
			if (!fs.existsSync(dir)) {
				return [];
			}
			return fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson")).map((f) => {
				const name = f.slice(0, -".ndjson".length);
				if (active[name]) {
					return describe(active[name]);
				}
				const file = path.join(dir, f);
				const size = fs.statSync(file).size;
				const header = parse(firstLine(file)) || {};
				const end = parse(lastLine(file, size));
				const out = {
					name: name,
					active: false,
					started: header.started || null,
					channels: header.channels || [],
					note: header.note || "",
					bytes: size,
					complete: Boolean(end && end.type === "end")
				};
				if (out.complete) {
					out.stopped = end.t;
					out.seconds = (end.t - header.started) / 1000;
					out.counts = end.counts;
				}
				return out;
			}).sort((a, b) => (b.started || 0) - (a.started || 0));
		},

		get: (name) => {
			const found = recordings.list().find((r) => r.name === name);
			if (!found) {
				throw new Error("no recording " + name);
			}
			return found;
		},

		fileFor: (name) => {
			const file = fileFor(dir, name);
			if (!fs.existsSync(file)) {
				throw new Error("no recording " + name);
			}
			return file;
		},

		remove: (name) => {
			if (active[name]) {
				throw new Error("recording " + name + " is running: stop it first");
			}
			fs.rmSync(fileFor(dir, name), { force: true });
		},

		load: (name) => load(dir, name),

		isRecording: () => Object.keys(active).length > 0,

		// ---- inputs ------------------------------------------------------------

		sample: (channel, t, v) => {
			each((rec) => {
				if (!rec.matchChannel(channel)) {
					return;
				}
				if (!rec.seen[channel]) {
					rec.seen[channel] = true;
					rec.counts.channels++;
					let unit = "";
					if (lab.channels.has(channel)) {
						unit = lab.channels.describe(channel).unit || "";
					}
					write(rec, { type: "channel", name: channel, unit: unit });
				}
				rec.counts.samples++;
				write(rec, { type: "s", c: channel, t: t, v: v });
			});
		},

		flush: () => {
			each(flushOne);
		},

		/**
		 * Hook lab events and start the flush timer; returns a stop function.
		 */
		attach: () => {
			const onTrace = (e) => {
				each((rec) => {
					if (rec.matchTrace(e.name)) {
						rec.dirtyTraces[e.name] = Date.now();
					}
				});
			};
			const onValue = (e) => {
				each((rec) => {
					if (!rec.matchValue(e.name)) {
						return;
					}
					const v = lab.getValue(e.name);
					rec.counts.values++;
					write(rec, { type: "value", name: e.name, t: v.t, value: v.value });
				});
			};
			const onNotify = (ev) => {
				if (SKIP_EVENTS.indexOf(ev.type) !== -1) {
					return;
				}
				each((rec) => {
					if (rec.header.events) {
						rec.counts.events++;
						write(rec, { type: "event", t: ev.t, event: ev });
					}
				});
			};
			const onLog = (entry) => {
				each((rec) => {
					if (rec.header.logs) {
						rec.counts.logs++;
						write(rec, { type: "log", t: entry.t, device: entry.device, level: entry.level, text: entry.text });
					}
				});
			};
			lab.events.on("trace", onTrace);
			lab.events.on("value", onValue);
			lab.events.on("notify", onNotify);
			lab.events.on("log", onLog);
			const timer = setInterval(recordings.flush, FLUSH_MS);
			timer.unref();
			return () => {
				clearInterval(timer);
				lab.events.removeListener("trace", onTrace);
				lab.events.removeListener("value", onValue);
				lab.events.removeListener("notify", onNotify);
				lab.events.removeListener("log", onLog);
			};
		}
	};

	return recordings;
};

module.exports = {
	create: create,
	load: load,
	NAME_RE: NAME_RE
};
