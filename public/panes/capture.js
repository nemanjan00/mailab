// The browser as an instrument: stream this browser's microphone (Web Audio,
// AudioWorklet → int16 PCM) and camera (<video> → canvas → JPEG) into the lab
// over the UI WebSocket. The server turns them into a `browser` device with an
// audio stream <device>_mic, level channels <device>_mic_level/_peak and images
// <device>_frame / _snapshot (src/capture, src/devices/browser).
// getUserMedia only exists in secure contexts (localhost, https) and only
// starts from a click, hence the buttons.

import { el, list, onDispose, state, when } from "@nemanjan00/qrp";
import { pane, widget } from "../sdk/index.js";

const DEFAULTS = { device: "browser", rate: 48000, channels: 1, fps: 1, maxWidth: 1280, quality: 0.8 };
const RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
const MAX_FPS = 10;
// audio chunk length sent to the lab
const CHUNK_S = 0.05;
// stop sending while this much is queued on the socket (slow link)
const MAX_BACKLOG = 1024 * 1024;
// server cap is 2 MB; stay under it by lowering JPEG quality
const MAX_FRAME_BYTES = 1900 * 1024;
const SNAPSHOT_QUALITY = 0.92;

// runs in the audio thread: resample (linear) to the target rate, interleave,
// convert to int16 and post CHUNK_S-sized chunks to the main thread
const WORKLET = `
class MailabCapture extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const o = options.processorOptions;
		this.channels = o.channels;
		this.step = sampleRate / o.rate;
		this.pos = 0;
		this.prev = new Float32Array(o.channels);
		this.size = Math.round(o.rate * o.chunk) * o.channels;
		this.out = new Int16Array(this.size);
		this.n = 0;
	}
	process(inputs) {
		const input = inputs[0];
		if (!input || !input.length) {
			return true;
		}
		const len = input[0].length;
		const at = (c, i) => {
			const ch = input[Math.min(c, input.length - 1)];
			return i < 0 ? this.prev[c] : ch[i];
		};
		// pos: fractional input index of the next output sample (-1 .. len)
		while (this.pos < len - 1 + 1e-9) {
			const i = Math.floor(this.pos);
			const f = this.pos - i;
			for (let c = 0; c < this.channels; c++) {
				const a = at(c, i);
				const b = i + 1 < len ? at(c, i + 1) : a;
				const v = Math.max(-1, Math.min(1, a + (b - a) * f));
				this.out[this.n++] = v < 0 ? v * 32768 : v * 32767;
			}
			if (this.n >= this.size) {
				this.port.postMessage(this.out.buffer, [this.out.buffer]);
				this.out = new Int16Array(this.size);
				this.n = 0;
			}
			this.pos += this.step;
		}
		this.pos -= len;
		for (let c = 0; c < this.channels; c++) {
			this.prev[c] = at(c, len - 1);
		}
		return true;
	}
}
registerProcessor("mailab-capture", MailabCapture);
`;

const toBase64 = (buffer) => {
	const bytes = new Uint8Array(buffer);
	const parts = [];
	for (let i = 0; i < bytes.length; i += 0x8000) {
		parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
	}
	return btoa(parts.join(""));
};

const clampInt = (v, min, max, fallback) => {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) {
		return fallback;
	}
	return Math.max(min, Math.min(max, n));
};

/**
 * Float samples → int16 interleaved, for the ScriptProcessor fallback.
 */
const interleave = (buffers, channels) => {
	const len = buffers[0].length;
	const out = new Int16Array(len * channels);
	for (let i = 0; i < len; i++) {
		for (let c = 0; c < channels; c++) {
			const v = Math.max(-1, Math.min(1, buffers[Math.min(c, buffers.length - 1)][i]));
			out[i * channels + c] = v < 0 ? v * 32768 : v * 32767;
		}
	}
	return out;
};

const secureHint = () => {
	if (window.isSecureContext) {
		return "this browser has no getUserMedia (navigator.mediaDevices is missing)";
	}
	return "the microphone and camera only work in a secure context: open the lab on http://localhost (e.g. through an SSH tunnel: ssh -L 8080:localhost:8080 lab) or over https. Plain http on a LAN address (" + location.host + ") is blocked by the browser.";
};

export default pane((ctx, p) => {
	const cfg = (key) => {
		const v = p.pane.config[key];
		return v === undefined || v === "" ? DEFAULTS[key] : v;
	};
	const view = state({
		device: String(cfg("device")),
		rate: clampInt(cfg("rate"), 8000, 48000, DEFAULTS.rate),
		channels: Number(cfg("channels")) === 2 ? 2 : 1,
		fps: Math.max(0.1, Math.min(MAX_FPS, Number(cfg("fps")) || DEFAULTS.fps)),
		maxWidth: clampInt(cfg("maxWidth"), 64, 4096, DEFAULTS.maxWidth),
		audioInputs: [],
		videoInputs: [],
		audioId: "",
		videoId: "",
		mic: false,
		cam: false,
		status: "",
		error: "",
		sent: { chunks: 0, frames: 0, skipped: 0 }
	});
	const media = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
	// live objects (not reactive)
	const live = { micStream: null, audio: null, node: null, analyser: null, camStream: null, timer: null, encoding: false, rate: 0 };
	const video = el("video", { muted: true, playsinline: true, autoplay: true, class: "capture-video" });
	video.muted = true;
	const grab = document.createElement("canvas");
	let ref = 0;

	const refreshDevices = () => {
		if (!media || !navigator.mediaDevices.enumerateDevices) {
			return Promise.resolve();
		}
		return navigator.mediaDevices.enumerateDevices().then((all) => {
			const pick = (kind) => all.filter((d) => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: d.label || kind.replace("input", "") + " " + (i + 1) }));
			view.audioInputs = pick("audioinput");
			view.videoInputs = pick("videoinput");
		}, () => null);
	};

	// tell the server what this browser streams into the device (or that it stopped)
	const announce = () => {
		ref++;
		if (!live.micStream && !live.camStream) {
			ctx.send({ type: "capture_stop", device: view.device, ref: ref });
			return;
		}
		const sent = ctx.send({
			type: "capture_start",
			device: view.device,
			ref: ref,
			mic: live.micStream ? { rate: live.rate, channels: view.channels } : null,
			cam: live.camStream ? { fps: view.fps, width: video.videoWidth || undefined, height: video.videoHeight || undefined } : null
		});
		if (!sent) {
			view.status = "waiting for the lab connection…";
		}
	};

	// ---- microphone ---------------------------------------------------------

	const sendAudio = (int16) => {
		if (ctx.sendBacklog() > MAX_BACKLOG) {
			view.sent.skipped++;
			return;
		}
		if (ctx.send({ type: "capture_audio", device: view.device, rate: live.rate, channels: view.channels, data: toBase64(int16.buffer) })) {
			view.sent.chunks++;
		}
	};

	const makeContext = (rate) => {
		try {
			return new AudioContext({ sampleRate: rate });
		} catch (_err) {
			// some browsers refuse a fixed rate; the worklet resamples instead
			return new AudioContext();
		}
	};

	const startMic = () => {
		view.error = "";
		const channels = view.channels;
		const constraints = { audio: { channelCount: channels, echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
		if (view.audioId) {
			constraints.audio.deviceId = { exact: view.audioId };
		}
		return navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
			live.micStream = stream;
			live.rate = view.rate;
			const audio = makeContext(view.rate);
			live.audio = audio;
			const source = audio.createMediaStreamSource(stream);
			const analyser = audio.createAnalyser();
			analyser.fftSize = 2048;
			source.connect(analyser);
			live.analyser = analyser;
			// processors only run when pulled by the destination; keep them silent
			const mute = audio.createGain();
			mute.gain.value = 0;
			mute.connect(audio.destination);
			const viaWorklet = () => {
				const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
				return audio.audioWorklet.addModule(url).then(() => {
					URL.revokeObjectURL(url);
					const node = new AudioWorkletNode(audio, "mailab-capture", {
						numberOfInputs: 1,
						numberOfOutputs: 1,
						channelCount: channels,
						channelCountMode: "explicit",
						processorOptions: { rate: live.rate, channels: channels, chunk: CHUNK_S }
					});
					node.port.onmessage = (e) => sendAudio(new Int16Array(e.data));
					return node;
				});
			};
			// older browsers: ScriptProcessor at the context rate (needs the context to run at view.rate)
			const viaScript = () => {
				if (Math.round(audio.sampleRate) !== live.rate) {
					live.rate = Math.round(audio.sampleRate);
					view.rate = live.rate;
				}
				const node = audio.createScriptProcessor(4096, channels, channels);
				node.onaudioprocess = (e) => {
					const bufs = [];
					for (let c = 0; c < e.inputBuffer.numberOfChannels; c++) {
						bufs.push(e.inputBuffer.getChannelData(c));
					}
					sendAudio(interleave(bufs, channels));
				};
				return Promise.resolve(node);
			};
			const build = audio.audioWorklet ? viaWorklet().catch(viaScript) : viaScript();
			return build.then((node) => {
				source.connect(node);
				node.connect(mute);
				live.node = node;
				view.mic = true;
				announce();
				refreshDevices();
			});
		}).catch((err) => {
			stopMic(true);
			view.error = "microphone: " + err.message;
		});
	};

	const stopMic = (quiet) => {
		if (live.micStream) {
			live.micStream.getTracks().forEach((t) => t.stop());
		}
		if (live.audio) {
			live.audio.close();
		}
		live.micStream = null;
		live.audio = null;
		live.node = null;
		live.analyser = null;
		view.mic = false;
		if (!quiet) {
			announce();
		}
	};

	// ---- camera ---------------------------------------------------------------

	/**
	 * Current video frame as JPEG, scaled to maxWidth (0 = full size).
	 * @returns {Promise<{data: string, mime: string, width: number, height: number}>}
	 */
	const encodeFrame = (maxWidth, quality) => {
		const w = video.videoWidth;
		const h = video.videoHeight;
		if (!w || !h) {
			return Promise.reject(new Error("no video frame yet"));
		}
		const scale = maxWidth ? Math.min(1, maxWidth / w) : 1;
		grab.width = Math.round(w * scale);
		grab.height = Math.round(h * scale);
		grab.getContext("2d").drawImage(video, 0, 0, grab.width, grab.height);
		const attempt = (q) => new Promise((resolve) => grab.toBlob(resolve, "image/jpeg", q)).then((blob) => {
			if (!blob) {
				throw new Error("could not encode the frame");
			}
			if (blob.size > MAX_FRAME_BYTES && q > 0.3) {
				return attempt(q - 0.15);
			}
			return blob.arrayBuffer().then((buf) => ({ data: toBase64(buf), mime: "image/jpeg", width: grab.width, height: grab.height }));
		});
		return attempt(quality);
	};

	const sendFrame = () => {
		if (live.encoding || !live.camStream || ctx.sendBacklog() > MAX_BACKLOG) {
			view.sent.skipped++;
			return;
		}
		live.encoding = true;
		const quality = Math.max(0.1, Math.min(1, Number(cfg("quality")) || DEFAULTS.quality));
		encodeFrame(view.maxWidth, quality).then((frame) => {
			if (ctx.send({ type: "capture_frame", device: view.device, mime: frame.mime, data: frame.data })) {
				view.sent.frames++;
			}
		}, () => null).then(() => {
			live.encoding = false;
		});
	};

	// a full-size frame: the pane's button, or an MCP request relayed by the server
	const snapshot = (request) => {
		return encodeFrame(0, SNAPSHOT_QUALITY).then((frame) => {
			const msg = { type: "capture_frame", device: view.device, mime: frame.mime, data: frame.data };
			if (request !== undefined) {
				msg.request = request;
			} else {
				msg.snapshot = true;
			}
			ctx.send(msg);
			view.status = "snapshot " + frame.width + "×" + frame.height + " sent";
		}, (err) => {
			view.error = "snapshot: " + err.message;
		});
	};

	const schedule = () => {
		clearInterval(live.timer);
		live.timer = live.camStream ? setInterval(sendFrame, 1000 / view.fps) : null;
	};

	const startCam = () => {
		view.error = "";
		const constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: Math.max(5, view.fps) } } };
		if (view.videoId) {
			constraints.video.deviceId = { exact: view.videoId };
		}
		return navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
			live.camStream = stream;
			video.srcObject = stream;
			return video.play().catch(() => null).then(() => {
				view.cam = true;
				schedule();
				announce();
				refreshDevices();
			});
		}).catch((err) => {
			stopCam(true);
			view.error = "camera: " + err.message;
		});
	};

	const stopCam = (quiet) => {
		if (live.camStream) {
			live.camStream.getTracks().forEach((t) => t.stop());
		}
		live.camStream = null;
		video.srcObject = null;
		view.cam = false;
		schedule();
		if (!quiet) {
			announce();
		}
	};

	// ---- server messages ---------------------------------------------------------

	onDispose(ctx.on("capture_started", (msg) => {
		if (msg.device === view.device) {
			view.status = "streaming into device " + msg.device;
		}
	}));
	onDispose(ctx.on("capture_stopped", (msg) => {
		if (msg.device === view.device) {
			view.status = "stopped";
		}
	}));
	onDispose(ctx.on("capture_snapshot_saved", (msg) => {
		if (msg.device === view.device) {
			view.status = "snapshot saved as image " + msg.image;
		}
	}));
	onDispose(ctx.on("capture_error", (msg) => {
		if (!msg.device || msg.device === view.device) {
			view.error = msg.error;
		}
	}));
	// the lab stopped or removed the device
	onDispose(ctx.on("capture_stop", (msg) => {
		if (msg.device === view.device) {
			stopMic(true);
			stopCam(true);
			view.status = "stopped by the lab: " + (msg.reason || "");
		}
	}));
	onDispose(ctx.on("capture_snapshot", (msg) => {
		if (msg.device === view.device) {
			snapshot(msg.request);
		}
	}));
	// after a reconnect the server has forgotten this browser's streams
	onDispose(ctx.on("ws_open", () => {
		if (live.micStream || live.camStream) {
			announce();
		}
	}));
	if (media && navigator.mediaDevices.addEventListener) {
		navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
		onDispose(() => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices));
	}
	onDispose(() => {
		const streaming = live.micStream || live.camStream;
		stopMic(true);
		stopCam(true);
		if (streaming) {
			announce();
		}
	});
	refreshDevices();

	// ---- view ----------------------------------------------------------------------

	if (!media) {
		return el("div", { class: "pad capture" },
			el("p", {}, el("b", {}, "Browser capture unavailable")),
			el("p", { class: "muted" }, secureHint()));
	}

	const scope = widget((host) => {
		const canvas = document.createElement("canvas");
		host.appendChild(canvas);
		let raf = 0;
		let time = null;
		let freq = null;
		const draw = () => {
			raf = requestAnimationFrame(draw);
			const w = host.clientWidth;
			const h = host.clientHeight;
			if (canvas.width !== w || canvas.height !== h) {
				canvas.width = w;
				canvas.height = h;
			}
			const g = canvas.getContext("2d");
			g.clearRect(0, 0, w, h);
			const analyser = live.analyser;
			if (!analyser || !w || !h) {
				return;
			}
			if (!time || time.length !== analyser.fftSize) {
				time = new Float32Array(analyser.fftSize);
				freq = new Float32Array(analyser.frequencyBinCount);
			}
			analyser.getFloatTimeDomainData(time);
			analyser.getFloatFrequencyData(freq);
			const half = h / 2;
			g.lineWidth = 1;
			// scope (top half)
			g.strokeStyle = ctx.color(0);
			g.beginPath();
			time.forEach((v, i) => {
				const x = i / (time.length - 1) * w;
				const y = half / 2 - v * half / 2;
				if (i) {
					g.lineTo(x, y);
				} else {
					g.moveTo(x, y);
				}
			});
			g.stroke();
			// spectrum (bottom half), -120..0 dBFS, log frequency
			g.strokeStyle = ctx.color(1);
			g.beginPath();
			const nyquist = live.audio ? live.audio.sampleRate / 2 : 24000;
			const fMin = 20;
			const span = Math.log(nyquist / fMin);
			freq.forEach((db, i) => {
				const f = (i + 0.5) * nyquist / freq.length;
				if (f < fMin) {
					return;
				}
				const x = Math.log(f / fMin) / span * w;
				const y = half + Math.max(0, Math.min(1, -db / 120)) * half;
				g.lineTo(x, y);
			});
			g.stroke();
			g.fillStyle = getComputedStyle(host).color;
			g.font = "10px monospace";
			g.fillText("scope", 4, 12);
			g.fillText("spectrum 20 Hz – " + Math.round(nyquist / 1000) + " kHz", 4, half + 12);
		};
		draw();
		return { destroy: () => cancelAnimationFrame(raf) };
	});

	const option = (d) => el("option", { value: d.id }, d.label);
	const select = (items, key, title) => el("select", {
		title: title,
		onchange: (e) => {
			view[key] = e.target.value;
		}
	}, el("option", { value: "" }, "default " + title), list(items, (d) => d.id, option));
	const number = (key, props, parse) => el("input", Object.assign({
		type: "number",
		value: String(view[key]),
		onchange: (e) => {
			view[key] = parse(e.target.value);
			e.target.value = String(view[key]);
			if (key === "fps") {
				schedule();
				announce();
			}
		}
	}, props));
	const locked = () => view.mic || view.cam;

	return el("div", { class: "capture" },
		el("div", { class: "toolbar pad capture-bar" },
			el("label", {}, "device ", el("input", {
				class: "mono",
				value: view.device,
				size: 10,
				disabled: locked,
				onchange: (e) => {
					view.device = e.target.value.trim() || DEFAULTS.device;
				}
			})),
			el("button", {
				class: () => (view.mic ? "primary" : ""),
				onclick: () => (view.mic ? stopMic() : startMic())
			}, () => (view.mic ? "■ mic" : "🎤 mic")),
			el("button", {
				class: () => (view.cam ? "primary" : ""),
				onclick: () => (view.cam ? stopCam() : startCam())
			}, () => (view.cam ? "■ camera" : "📷 camera")),
			el("button", { disabled: () => !view.cam, title: "full-size frame → image <device>_snapshot", onclick: () => snapshot() }, "snapshot")),
		el("div", { class: "toolbar pad capture-bar" },
			select(() => view.audioInputs, "audioId", "mic"),
			el("select", {
				title: "sample rate",
				disabled: () => view.mic,
				onchange: (e) => {
					view.rate = Number(e.target.value);
				}
			}, ...RATES.map((r) => el("option", { value: String(r), selected: r === view.rate }, (r / 1000) + " kHz"))),
			el("select", {
				title: "channels",
				disabled: () => view.mic,
				onchange: (e) => {
					view.channels = Number(e.target.value);
				}
			}, el("option", { value: "1", selected: view.channels === 1 }, "mono"), el("option", { value: "2", selected: view.channels === 2 }, "stereo")),
			select(() => view.videoInputs, "videoId", "camera"),
			el("label", {}, "fps ", number("fps", { min: 0.1, max: MAX_FPS, step: 0.5, style: "width: 4.5em" }, (v) => Math.max(0.1, Math.min(MAX_FPS, Number(v) || 1)))),
			el("label", {}, "max w ", number("maxWidth", { min: 64, max: 4096, step: 64, style: "width: 5.5em" }, (v) => clampInt(v, 64, 4096, DEFAULTS.maxWidth)))),
		el("div", { class: "pad capture-status" },
			el("span", { class: "muted" }, () => view.status || "not streaming"),
			" ",
			el("span", { class: "muted mono" }, () => (locked() ? view.sent.chunks + " audio chunks · " + view.sent.frames + " frames" + (view.sent.skipped ? " · " + view.sent.skipped + " skipped" : "") : "")),
			when(() => Boolean(view.error), () => el("div", { class: "capture-error" }, () => view.error))),
		el("div", { class: "capture-media" },
			el("div", { class: "capture-cam", style: () => (view.cam ? "" : "display: none") }, video),
			el("div", { class: "capture-scope", style: () => (view.mic ? "" : "display: none") }, scope)));
});
