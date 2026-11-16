// Replay: plays a recording (src/recordings) back as a virtual device. Channels,
// traces and values come back under their original names (plus an optional
// prefix), with the original timing scaled by `speed`, optionally looping.
// Timestamps are shifted to "now" so live panes and math windows work.

const path = require("path");
const recordings = require("../../recordings");
const channelsModule = require("../../channels");

const PREFIX_RE = /^([A-Za-z_][A-Za-z0-9_]*)?$/;
// longest sleep between checks (keeps pause/seek responsive)
const MAX_SLEEP_MS = 100;
// records per tick before yielding (fast replays)
const MAX_PER_TICK = 5000;
const LOOP_GAP_MS = 1;

const create = (options, io) => {
	const prefix = options.prefix || "";
	let speed = Number(options.speed || 1);
	const loop = options.loop === true || options.loop === "true";
	const logs = options.logs !== false;
	let rec = null;
	let index = 0;
	// wall time that corresponds to recording time t0 (at the current speed)
	let base = 0;
	let timer = null;
	let paused = false;
	let pausedAt = 0;
	let loops = 0;
	let finished = false;
	let emitted = 0;

	const name = (n) => prefix + n;

	// recording time -> wall time
	const wall = (t) => base + (t - rec.t0) / speed;

	const emit = (r) => {
		const t = wall(r.t);
		if (r.type === "s") {
			io.publish.sample(name(r.c), r.v, { t: t, unit: rec.units[r.c] });
		} else if (r.type === "trace") {
			io.publish.trace(name(r.name), r.data);
		} else if (r.type === "value") {
			io.publish.value(name(r.name), r.value);
		} else if (r.type === "event") {
			const ev = Object.assign({}, r.event, { replay: options.recording, originalDevice: r.event.device });
			delete ev.id;
			delete ev.t;
			io.publish.notify(ev);
		} else if (r.type === "log" && logs && r.device !== io.id) {
			io.log(r.text, r.level);
		}
		emitted++;
	};

	const schedule = (ms) => {
		clearTimeout(timer);
		timer = setTimeout(tick, Math.max(0, Math.min(ms, MAX_SLEEP_MS)));
	};

	const tick = () => {
		timer = null;
		if (paused || finished) {
			return;
		}
		const now = Date.now();
		let n = 0;
		while (index < rec.records.length && wall(rec.records[index].t) <= now && n < MAX_PER_TICK) {
			emit(rec.records[index]);
			index++;
			n++;
		}
		if (index < rec.records.length) {
			if (n >= MAX_PER_TICK) {
				setImmediate(tick);
				return;
			}
			schedule(wall(rec.records[index].t) - now);
			return;
		}
		if (loop && rec.records.length) {
			loops++;
			base = wall(rec.t1) + LOOP_GAP_MS;
			index = 0;
			schedule(0);
			return;
		}
		finished = true;
		io.status("running", "finished");
		io.log("replay of " + options.recording + " finished (" + emitted + " records)");
	};

	const status = () => {
		const duration = (rec.t1 - rec.t0) / 1000;
		let position = 0;
		if (rec.records.length) {
			const at = paused ? pausedAt : Date.now();
			position = Math.min(duration, Math.max(0, ((at - base) * speed) / 1000));
		}
		if (finished) {
			position = duration;
		}
		return {
			recording: options.recording,
			prefix: prefix,
			speed: speed,
			loop: loop,
			paused: paused,
			finished: finished,
			loops: loops,
			position: position,
			duration: duration,
			records: rec.records.length,
			emitted: emitted,
			channels: Object.keys(rec.units).map(name)
		};
	};

	// jump to `seconds` into the recording
	const seek = (seconds) => {
		const target = rec.t0 + seconds * 1000;
		index = rec.records.findIndex((r) => r.t >= target);
		if (index === -1) {
			index = rec.records.length;
		}
		const now = Date.now();
		base = now - (seconds * 1000) / speed;
		pausedAt = now;
		finished = false;
		if (!paused) {
			schedule(0);
		}
	};

	return {
		start: () => {
			if (!options.recording) {
				return Promise.reject(new Error("option `recording` (name) is required"));
			}
			if (!PREFIX_RE.test(prefix)) {
				return Promise.reject(new Error("prefix must be letters, digits, _ (and not start with a digit)"));
			}
			if (!(speed > 0)) {
				return Promise.reject(new Error("speed must be > 0"));
			}
			return Promise.resolve().then(() => {
				rec = recordings.load(path.join(io.dataDir, "recordings"), options.recording);
				Object.keys(rec.units).forEach((c) => {
					if (!channelsModule.isValidName(name(c))) {
						throw new Error("invalid channel name: " + name(c));
					}
					io.publish.meta(name(c), { unit: rec.units[c], description: "replay of " + options.recording });
				});
				io.log("replaying " + options.recording + ": " + rec.records.length + " records, " + ((rec.t1 - rec.t0) / 1000).toFixed(1) + " s at " + speed + "x" + (loop ? ", looping" : ""));
				base = Date.now();
				schedule(0);
			});
		},

		stop: () => {
			clearTimeout(timer);
			timer = null;
			finished = true;
			return Promise.resolve();
		},

		command: (cmd, args) => {
			const a = args || {};
			if (!rec) {
				return Promise.reject(new Error("not loaded"));
			}
			if (cmd === "status") {
				return Promise.resolve(status());
			}
			if (cmd === "pause") {
				if (!paused) {
					paused = true;
					pausedAt = Date.now();
					clearTimeout(timer);
				}
				return Promise.resolve(status());
			}
			if (cmd === "resume") {
				if (paused) {
					base += Date.now() - pausedAt;
					paused = false;
					schedule(0);
				}
				return Promise.resolve(status());
			}
			if (cmd === "restart") {
				loops = 0;
				seek(0);
				io.status("running");
				return Promise.resolve(status());
			}
			if (cmd === "seek") {
				const seconds = Number(a.seconds);
				if (!Number.isFinite(seconds) || seconds < 0) {
					return Promise.reject(new Error("seek needs seconds >= 0"));
				}
				seek(seconds);
				io.status("running");
				return Promise.resolve(status());
			}
			if (cmd === "speed") {
				const factor = Number(a.factor);
				if (!(factor > 0)) {
					return Promise.reject(new Error("speed needs factor > 0"));
				}
				// keep the current position
				const now = paused ? pausedAt : Date.now();
				const position = (now - base) * speed;
				speed = factor;
				base = now - position / speed;
				if (!paused) {
					schedule(0);
				}
				return Promise.resolve(status());
			}
			return Promise.reject(new Error("unknown command: " + cmd));
		}
	};
};

module.exports = {
	name: "replay",
	description: "Plays a recording (recording_start / recordings) back as a virtual device: channels, traces, values, events and log lines under their original names (plus prefix), original timing scaled by speed",
	options: {
		recording: "recording name (see recordings)",
		prefix: "prepended to every channel/trace/value name (default none: the original names)",
		speed: "playback speed factor (default 1; 10 = ten times faster)",
		loop: "start over at the end (default false)",
		logs: "replay recorded log lines into this device's log (default true; the classifier sees them)"
	},
	commands: {
		status: "position, duration, speed, records emitted",
		pause: "pause playback",
		resume: "resume playback",
		restart: "play from the beginning",
		seek: "{seconds} jump to a position",
		speed: "{factor} change playback speed"
	},
	create: create
};
