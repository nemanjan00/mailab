// Plays a lab audio stream (e.g. a flowgraph audio sink) through WebAudio.
// Browsers only start audio after a user gesture, hence the listen button.

import { escapeHtml } from "./util.js";

// schedule this far ahead to absorb network jitter
const LEAD_S = 0.15;
const MAX_LAG_S = 1.0;

const decode = (base64) => {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
	return Float32Array.from(pcm, (v) => v / 32768);
};

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		let audio = null;
		let gain = null;
		let next = 0;
		let level = 0;
		body.innerHTML = "<div class=\"pad audiopane\"><button data-act=\"listen\">▶ listen</button> "
			+ "<label>volume <input type=\"range\" min=\"0\" max=\"2\" step=\"0.05\" value=\"1\"></label>"
			+ "<div class=\"meter\"><div></div></div><div class=\"muted status\"></div></div>";
		const button = body.querySelector("[data-act=listen]");
		const slider = body.querySelector("input");
		const bar = body.querySelector(".meter div");
		const status = body.querySelector(".status");

		const describe = () => {
			status.textContent = pane.config.stream ? "stream " + pane.config.stream : "set config.stream (e.g. fg_audio)";
		};

		button.addEventListener("click", () => {
			if (audio) {
				audio.close();
				audio = null;
				button.textContent = "▶ listen";
				return;
			}
			audio = new AudioContext();
			gain = audio.createGain();
			gain.gain.value = Number(slider.value);
			gain.connect(audio.destination);
			next = 0;
			button.textContent = "■ stop";
		});
		slider.addEventListener("input", () => {
			if (gain) {
				gain.gain.value = Number(slider.value);
			}
		});

		const off = ctx.on("audio", (msg) => {
			const chunk = msg.chunk;
			if (chunk.name !== pane.config.stream) {
				return;
			}
			const samples = decode(chunk.data);
			level = Math.max(level * 0.8, samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
			bar.style.width = Math.round(level * 100) + "%";
			if (!audio || !samples.length) {
				return;
			}
			const buffer = audio.createBuffer(1, samples.length, chunk.rate);
			buffer.copyToChannel(samples, 0);
			const source = audio.createBufferSource();
			source.buffer = buffer;
			source.connect(gain);
			const now = audio.currentTime;
			// fell behind or drifted too far ahead: resync
			if (next < now || next > now + MAX_LAG_S) {
				next = now + LEAD_S;
			}
			source.start(next);
			next += buffer.duration;
			status.textContent = "stream " + escapeHtml(chunk.name) + " · " + chunk.rate + " Hz";
		});
		describe();

		return {
			update: (nextPane) => {
				pane = nextPane;
				describe();
			},
			destroy: () => {
				off();
				if (audio) {
					audio.close();
				}
			}
		};
	}
};
