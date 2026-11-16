// The browser as an instrument: a virtual device fed by a web page that
// captures its microphone / camera (getUserMedia, the capture pane). The page
// talks to src/capture over the UI WebSocket; this driver is the lab side:
//   <id>_mic         audio stream (int16 PCM, plays in an audio pane)
//   <id>_mic_level   RMS level, dBFS     <id>_mic_peak   peak level, dBFS
//   <id>_frame       latest camera frame (JPEG)
//   <id>_snapshot    full-size snapshot (button in the pane, or the snapshot command)
// The device is "running" while a browser streams and "stopped" otherwise.

const pcm = require("../../utils/pcm");

const LEVEL_INTERVAL_MS = 100;
const SNAPSHOT_TIMEOUT_MS = 5000;
const MAX_SNAPSHOT_TIMEOUT_MS = 30000;
const WAITING = "waiting for a browser (open a capture pane and start the mic or camera)";

const summary = (session) => {
	const parts = [];
	if (session.mic) {
		parts.push("mic " + session.mic.rate + " Hz" + (session.mic.channels === 2 ? " stereo" : ""));
	}
	if (session.cam) {
		parts.push("camera " + session.cam.fps + " fps");
	}
	return "streaming from " + session.who + (parts.length ? ": " + parts.join(", ") : "");
};

const create = (options, io) => {
	// {client, who, mic: {rate, channels}, cam: {fps}} while a browser streams
	let session = null;
	const stats = { chunks: 0, frames: 0, snapshots: 0, dropped: 0, lastAudio: null, lastFrame: null };
	const meter = pcm.levelMeter(LEVEL_INTERVAL_MS, (lv, t) => {
		io.sample("mic_level", lv.rms, { t: t, unit: "dBFS" });
		io.sample("mic_peak", lv.peak, { t: t, unit: "dBFS" });
	});

	const device = {
		start: () => {
			io.status("stopped", WAITING);
			return Promise.resolve();
		},

		stop: () => {
			if (session) {
				session.client.send({ type: "capture_stop", device: io.id, reason: "device stopped in the lab" });
				session = null;
			}
			return Promise.resolve();
		},

		// ---- called by the capture hub ----------------------------------------

		/**
		 * A browser starts (or changes) streaming into this device.
		 * @param {{client: Object, who: string, mic: Object, cam: Object}} next
		 */
		attach: (next) => {
			if (session && session.client !== next.client) {
				throw new Error("device " + io.id + " is already streaming from " + session.who);
			}
			session = next;
			io.status("running", summary(session));
			io.log(summary(session));
		},

		detach: (reason) => {
			if (!session) {
				return;
			}
			session = null;
			io.status("stopped", reason || WAITING);
			io.log("capture ended: " + (reason || "stopped"));
		},

		owner: () => (session ? session.client : null),

		audio: (buffer, rate, channels) => {
			stats.chunks++;
			stats.lastAudio = Date.now();
			io.audio("mic", rate, buffer.toString("base64"), channels);
			meter(buffer);
		},

		frame: (buffer, mime, snapshot) => {
			stats.lastFrame = Date.now();
			if (snapshot) {
				stats.snapshots++;
			} else {
				stats.frames++;
			}
			io.image(snapshot ? "snapshot" : "frame", buffer, mime);
		},

		dropped: () => {
			stats.dropped++;
		},

		command: (name, args) => {
			const a = args || {};
			if (name === "snapshot") {
				if (!session || !session.cam) {
					return Promise.reject(new Error("no camera streaming into " + io.id));
				}
				const timeout = Math.min(MAX_SNAPSHOT_TIMEOUT_MS, Number(a.timeout) || SNAPSHOT_TIMEOUT_MS);
				return session.client.request({ type: "capture_snapshot", device: io.id }, timeout).then((frame) => {
					return { image: io.id + "_snapshot", bytes: frame.data.length, _image: { data: frame.data.toString("base64"), mime: frame.mime } };
				});
			}
			if (name === "status") {
				return Promise.resolve(Object.assign({ streaming: Boolean(session), who: session && session.who, mic: session && session.mic, cam: session && session.cam }, stats));
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
	return device;
};

module.exports = {
	name: "browser",
	description: "A web browser's microphone / camera (capture pane, getUserMedia): audio stream <id>_mic, levels <id>_mic_level/_peak (dBFS), images <id>_frame and <id>_snapshot. Created when a browser starts capturing",
	options: {},
	commands: {
		snapshot: "{timeout: 5000} ask the capturing browser for a full-size camera frame (image <id>_snapshot, returned to the AI)",
		status: "who is streaming, formats, chunk/frame counters"
	},
	create: create,
	SNAPSHOT_TIMEOUT_MS: SNAPSHOT_TIMEOUT_MS
};
