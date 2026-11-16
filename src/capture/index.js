// Media pushed by browsers (the capture pane: getUserMedia mic + camera) into
// virtual `browser` devices. Each WebSocket connection is a client; its
// messages are validated and capped here, then handed to the device:
//
//   capture_start {device, ref, mic: {rate, channels} | null, cam: {fps} | null}
//   capture_audio {device, rate, channels, data}            int16 LE PCM, base64
//   capture_frame {device, mime, data, snapshot?, request?} JPEG/PNG/WebP, base64
//   capture_stop  {device, ref}
//
// The server sends capture_started / capture_error / capture_stop (device
// stopped in the lab) / capture_snapshot {device, request} (an MCP snapshot).

const channelsModule = require("../channels");
const authModule = require("../auth");
const pcm = require("../utils/pcm");

const DRIVER = "browser";
const LIMITS = {
	maxNameLength: 48,
	maxDevicesPerClient: 4,
	minRate: 8000,
	maxRate: 48000,
	maxChannels: 2,
	// one chunk: 0.5 s of 48 kHz stereo
	maxChunkBytes: 96 * 1024,
	// samples accepted per second, relative to the announced rate (jitter, bursts after a stall)
	rateSlack: 1.5,
	maxFps: 10,
	maxFrameBytes: 2 * 1024 * 1024,
	// user-pressed snapshots, per second
	maxSnapshotsPerSecond: 2
};
// frames arriving a bit early (timer jitter) are still fine
const FRAME_JITTER = 0.8;
const WINDOW_MS = 1000;

const fail = (message) => {
	throw new Error(message);
};

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Decode base64 with a size cap checked before decoding.
 */
const decode = (data, maxBytes, what) => {
	if (typeof data !== "string" || !data.length) {
		fail(what + ": data (base64) required");
	}
	if (data.length > Math.ceil(maxBytes / 3) * 4) {
		fail(what + " too large (max " + maxBytes + " bytes)");
	}
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
		fail(what + ": data is not base64");
	}
	return Buffer.from(data, "base64");
};

const parseMic = (mic) => {
	if (mic === null || mic === undefined || mic === false) {
		return null;
	}
	if (!isPlainObject(mic)) {
		fail("mic must be {rate, channels}");
	}
	const rate = Number(mic.rate);
	if (!Number.isInteger(rate) || rate < LIMITS.minRate || rate > LIMITS.maxRate) {
		fail("mic rate must be an integer " + LIMITS.minRate + ".." + LIMITS.maxRate + " Hz");
	}
	const channels = mic.channels === undefined ? 1 : Number(mic.channels);
	if (channels !== 1 && channels !== 2) {
		fail("mic channels must be 1 or 2");
	}
	return { rate: rate, channels: channels };
};

const parseCam = (cam) => {
	if (cam === null || cam === undefined || cam === false) {
		return null;
	}
	if (!isPlainObject(cam)) {
		fail("cam must be {fps}");
	}
	const fps = cam.fps === undefined ? 1 : Number(cam.fps);
	if (!Number.isFinite(fps) || fps <= 0 || fps > LIMITS.maxFps) {
		fail("cam fps must be > 0 and <= " + LIMITS.maxFps);
	}
	const out = { fps: fps };
	["width", "height"].forEach((key) => {
		if (Number.isInteger(cam[key]) && cam[key] > 0) {
			out[key] = cam[key];
		}
	});
	return out;
};

const checkName = (name) => {
	if (typeof name !== "string" || name.length > LIMITS.maxNameLength || !channelsModule.isValidName(name)) {
		fail("invalid device name (letters, digits, _; not starting with a digit; max " + LIMITS.maxNameLength + ")");
	}
	return name;
};

/**
 * @param {Object} lab
 * @param {{limits: Object}} [options] override LIMITS (tests)
 */
const create = (lab, options) => {
	const limits = Object.assign({}, LIMITS, (options && options.limits) || {});
	let clientId = 0;
	let requestId = 0;

	const findDevice = (name) => {
		try {
			return lab.getDevice(name);
		} catch (_err) {
			return null;
		}
	};

	// the lab device, when it is a browser capture
	const deviceOf = (name) => {
		const inst = lab.getDevice(name);
		if (inst.driver !== DRIVER) {
			fail("device " + name + " is a " + inst.driver + ", not a browser capture");
		}
		return inst;
	};

	const owned = (client, name) => {
		checkName(name);
		const stream = client.streams[name];
		const inst = stream ? findDevice(name) : null;
		if (!stream || !inst || !inst.instance || inst.instance.owner() !== client) {
			fail("not capturing into " + name + " (send capture_start first)");
		}
		return { stream: stream, device: inst.instance };
	};

	// sliding one-second budget; false = over the cap
	const spend = (bucket, amount, perSecond, now) => {
		if (now - bucket.start >= WINDOW_MS) {
			bucket.start = now;
			bucket.used = 0;
		}
		if (bucket.used + amount > perSecond) {
			return false;
		}
		bucket.used += amount;
		return true;
	};

	const start = (client, msg) => {
		const name = checkName(msg.device);
		const mic = parseMic(msg.mic);
		const cam = parseCam(msg.cam);
		if (!mic && !cam) {
			fail("nothing to capture: give mic and/or cam");
		}
		if (!client.streams[name] && Object.keys(client.streams).length >= limits.maxDevicesPerClient) {
			fail("too many captures from one browser (max " + limits.maxDevicesPerClient + ")");
		}
		let ready;
		if (!findDevice(name)) {
			ready = lab.addDevice(name, DRIVER, {});
		} else if (!deviceOf(name).instance) {
			ready = lab.startDevice(name);
		} else {
			ready = Promise.resolve();
		}
		return ready.then(() => {
			const inst = deviceOf(name);
			if (!inst.instance) {
				fail("device " + name + " did not start: " + inst.detail);
			}
			inst.instance.attach({ client: client, who: client.who.name, mic: mic, cam: cam });
			const prev = client.streams[name] || { audio: { start: 0, used: 0 }, snaps: { start: 0, used: 0 }, lastFrame: 0 };
			client.streams[name] = Object.assign(prev, { mic: mic, cam: cam });
			return { type: "capture_started", device: name, ref: msg.ref, mic: mic, cam: cam, limits: limits };
		});
	};

	const audio = (client, msg) => {
		const target = owned(client, msg.device);
		const mic = target.stream.mic;
		if (!mic) {
			fail("mic not started for " + msg.device);
		}
		if (Number(msg.rate) !== mic.rate || (Number(msg.channels) || 1) !== mic.channels) {
			fail("audio format differs from capture_start (" + mic.rate + " Hz, " + mic.channels + " ch)");
		}
		const buffer = decode(msg.data, limits.maxChunkBytes, "audio chunk");
		const frameBytes = 2 * mic.channels;
		if (!buffer.length || buffer.length % frameBytes) {
			fail("audio chunk must be whole int16 frames (" + frameBytes + " bytes each)");
		}
		const frames = buffer.length / frameBytes;
		if (!spend(target.stream.audio, frames, mic.rate * limits.rateSlack, Date.now())) {
			target.device.dropped();
			return null;
		}
		target.device.audio(buffer, mic.rate, mic.channels);
		return null;
	};

	const image = (msg) => {
		const mime = msg.mime || "image/jpeg";
		if (pcm.IMAGE_TYPES.indexOf(mime) === -1) {
			fail("image type must be one of " + pcm.IMAGE_TYPES.join(", "));
		}
		const buffer = decode(msg.data, limits.maxFrameBytes, "frame");
		if (!pcm.isImage(buffer, mime)) {
			fail("frame is not a valid " + mime);
		}
		return { data: buffer, mime: mime };
	};

	const frame = (client, msg) => {
		// answer to an MCP snapshot request
		if (msg.request !== undefined) {
			const pending = client.pending[msg.request];
			if (!pending || pending.device !== msg.device) {
				fail("unknown snapshot request");
			}
			const target = owned(client, msg.device);
			const img = image(msg);
			target.device.frame(img.data, img.mime, true);
			pending.resolve(img);
			return null;
		}
		const target = owned(client, msg.device);
		const cam = target.stream.cam;
		if (!cam) {
			fail("camera not started for " + msg.device);
		}
		const now = Date.now();
		if (msg.snapshot) {
			if (!spend(target.stream.snaps, 1, limits.maxSnapshotsPerSecond, now)) {
				fail("too many snapshots (max " + limits.maxSnapshotsPerSecond + "/s)");
			}
			const snap = image(msg);
			target.device.frame(snap.data, snap.mime, true);
			return { type: "capture_snapshot_saved", device: msg.device, image: msg.device + "_snapshot", ref: msg.ref };
		}
		const minInterval = 1000 / Math.min(cam.fps, limits.maxFps) * FRAME_JITTER;
		if (now - target.stream.lastFrame < minInterval) {
			target.device.dropped();
			return null;
		}
		const img = image(msg);
		target.stream.lastFrame = now;
		target.device.frame(img.data, img.mime, false);
		return null;
	};

	const stopOne = (client, name, reason) => {
		delete client.streams[name];
		const inst = findDevice(name);
		if (inst && inst.instance && inst.instance.owner() === client) {
			inst.instance.detach(reason);
		}
		Object.keys(client.pending).forEach((id) => {
			if (client.pending[id].device === name) {
				client.pending[id].reject(new Error("capture of " + name + " ended before the snapshot arrived"));
			}
		});
	};

	const HANDLERS = {
		capture_start: start,
		capture_audio: audio,
		capture_frame: frame,
		capture_stop: (client, msg) => {
			stopOne(client, checkName(msg.device), "browser stopped capturing");
			return { type: "capture_stopped", device: msg.device, ref: msg.ref };
		}
	};

	const hub = {
		LIMITS: limits,

		isCaptureMessage: (msg) => isPlainObject(msg) && Object.prototype.hasOwnProperty.call(HANDLERS, msg.type),

		/**
		 * A browser connection.
		 * @param {{name: string, role: string}} who identity of the connection
		 * @param {function(Object)} send delivers a message to that browser
		 */
		connect: (who, send) => {
			clientId++;
			const client = {
				id: clientId,
				who: who,
				streams: {},
				pending: {},
				send: send,
				/**
				 * Ask the browser for something (a snapshot); resolves with its answer.
				 */
				request: (msg, timeoutMs) => {
					requestId++;
					const id = requestId;
					return new Promise((resolve, reject) => {
						const done = () => {
							clearTimeout(client.pending[id].timer);
							delete client.pending[id];
						};
						client.pending[id] = {
							device: msg.device,
							resolve: (value) => {
								done();
								resolve(value);
							},
							reject: (err) => {
								done();
								reject(err);
							},
							timer: setTimeout(() => {
								client.pending[id].reject(new Error("no " + msg.type.replace("capture_", "") + " from the browser within " + timeoutMs + " ms"));
							}, timeoutMs)
						};
						send(Object.assign({}, msg, { request: id }));
					});
				}
			};
			return client;
		},

		/**
		 * Handle one capture message; resolves with a reply for the browser (or null).
		 */
		message: (client, msg) => {
			return Promise.resolve().then(() => {
				if (!client.who || authModule.WRITE_ROLES.indexOf(client.who.role) === -1) {
					fail((client.who && client.who.name) + " is read-only: pushing media needs a rw or human token");
				}
				if (!hub.isCaptureMessage(msg)) {
					fail("unknown capture message");
				}
				return HANDLERS[msg.type](client, msg);
			});
		},

		disconnect: (client) => {
			Object.keys(client.streams).forEach((name) => {
				stopOne(client, name, "browser disconnected (tab closed or connection lost)");
			});
			Object.keys(client.pending).forEach((id) => {
				client.pending[id].reject(new Error("browser disconnected"));
			});
		}
	};
	return hub;
};

module.exports = {
	LIMITS: LIMITS,
	create: create
};
