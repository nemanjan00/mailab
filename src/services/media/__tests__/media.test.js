const fs = require("fs");
const os = require("os");
const path = require("path");
const spawnSync = require("child_process").spawnSync;
const media = require("..");

const has = (cmd) => spawnSync("sh", ["-c", "command -v " + cmd]).status === 0;
const hasFfmpeg = has("ffmpeg") && has("ffprobe");

// 1 s 1 kHz sine, 8 kHz mono s16le, as a WAV file
const sineWav = () => {
	const rate = 8000;
	const pcm = Buffer.alloc(rate * 2);
	for (let i = 0; i < rate; i++) {
		pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 1000 * i / rate) * 16000), i * 2);
	}
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + pcm.length, 4);
	h.write("WAVEfmt ", 8);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(1, 22);
	h.writeUInt32LE(rate, 24);
	h.writeUInt32LE(rate * 2, 28);
	h.writeUInt16LE(2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(pcm.length, 40);
	return { wav: Buffer.concat([h, pcm]), pcm: pcm };
};

describe("media paths", () => {
	test("paths are confined to the media dirs", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-media-"));
		const old = process.env.MAILAB_MEDIA_DIRS;
		process.env.MAILAB_MEDIA_DIRS = dir;
		try {
			fs.writeFileSync(path.join(dir, "a.wav"), "x");
			expect(media.checkPath(path.join(dir, "a.wav"))).toBe(fs.realpathSync(path.join(dir, "a.wav")));
			expect(() => media.checkPath("/etc/passwd")).toThrow(/inside/);
			expect(() => media.checkPath(path.join(dir, "..", path.basename(dir), "..", "x"))).toThrow();
			expect(() => media.checkPath("relative.wav")).toThrow(/absolute/);
			fs.symlinkSync("/etc/hostname", path.join(dir, "link.wav"));
			expect(() => media.checkPath(path.join(dir, "link.wav"))).toThrow(/inside/);
		} finally {
			if (old === undefined) {
				delete process.env.MAILAB_MEDIA_DIRS;
			} else {
				process.env.MAILAB_MEDIA_DIRS = old;
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("png splitting", () => {
		const end = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
		const a = Buffer.concat([Buffer.from("A"), end]);
		const b = Buffer.concat([Buffer.from("BB"), end]);
		expect(media.splitPngs(Buffer.concat([a, b])).map((x) => x.length)).toEqual([9, 10]);
	});
});

(hasFfmpeg ? describe : describe.skip)("ffmpeg", () => {
	test("probe, decode to pcm, encode to flac and back", () => {
		const s = sineWav();
		return media.probe({ data: s.wav })
			.then((info) => {
				expect(info.streams[0]).toMatchObject({ type: "audio", rate: 8000, channels: 1 });
				return media.decodeAudio({ data: s.wav }, { rate: 8000, channels: 1, format: "s16le" });
			})
			.then((r) => {
				expect(r.samples).toBe(8000);
				expect(r.pcm.equals(s.pcm)).toBe(true);
				return media.encodeAudio(r.pcm, { rate: 8000, codec: "flac" });
			})
			.then((flac) => {
				expect(flac.subarray(0, 4).toString()).toBe("fLaC");
				return media.decodeAudio({ data: flac }, { rate: 16000, format: "f32le" });
			})
			.then((r) => {
				// resampled to 16 kHz: twice the samples, still a ~0.49 amplitude sine
				expect(Math.abs(r.samples - 16000)).toBeLessThan(50);
				const f = new Float32Array(r.pcm.buffer, r.pcm.byteOffset, r.samples);
				expect(Math.max(...f.slice(1000, 2000))).toBeGreaterThan(0.45);
			});
	});

	test("video frames out and back in", () => {
		// a 2 s test pattern video made by ffmpeg itself
		const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10", "-t", "2", "-f", "matroska", "-c:v", "ffv1", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
		expect(made.status).toBe(0);
		return media.videoFrames({ data: made.stdout }, { fps: 2, maxFrames: 3 })
			.then((frames) => {
				expect(frames.length).toBe(3);
				frames.forEach((png) => expect(png.subarray(1, 4).toString()).toBe("PNG"));
				return media.encodeVideo(frames, { fps: 2, format: "gif" });
			})
			.then((gif) => {
				expect(gif.subarray(0, 3).toString()).toBe("GIF");
			});
	});

	test("bad options are refused before running anything", () => {
		expect(() => media.decodeAudio({ data: Buffer.alloc(1) }, { format: "mp3" })).toThrow(/format/);
		expect(() => media.decodeAudio({ data: Buffer.alloc(1) }, { rate: 5 })).toThrow(/rate/);
		expect(() => media.encodeVideo([], {})).toThrow(/no frames/);
		return expect(media.decodeAudio({ data: Buffer.from("not audio at all") }, {})).rejects.toThrow(/ffmpeg failed/);
	});
});

(hasFfmpeg ? describe : describe.skip)("flowgraph media blocks", () => {
	test("audio_file decodes a recording; file/wav paths stay inside the media dirs", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-fgmedia-"));
		const made = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=1200:sample_rate=44100:duration=1", "-ac", "2", path.join(dir, "tone.flac")]);
		expect(made.status).toBe(0);
		const script = [
			"import flowgraph_bridge as fg, numpy as np, json, sys, os",
			"d = os.environ[\"MAILAB_MEDIA_ROOTS\"]",
			"b = fg.AudioFileSource('a', {'path': d + '/tone.flac', 'rate': 8000, 'realtime': False})",
			"tone = float(np.argmax(np.abs(np.fft.rfft(b.data.real))) * 8000 / len(b.data))",
			"def refused(f):",
			"    try:",
			"        f()",
			"        return False",
			"    except ValueError:",
			"        return True",
			"w = fg.Wav('w', {})",
			"w.work(np.zeros(100, np.complex64), 8000.0)",
			"w.close()",
			"print(json.dumps({'n': len(b.data), 'tone': tone,",
			"    'audio_outside': refused(lambda: fg.AudioFileSource('x', {'path': '/etc/hostname'})),",
			"    'iq_outside': refused(lambda: fg.FileSource('x', {'path': '/etc/hostname'})),",
			"    'wav_outside': refused(lambda: fg.Wav('x', {'path': '/tmp/evil.wav'}).work(np.zeros(4, np.complex64), 8000.0)),",
			"    'wav_default': os.path.exists(d + '/w.wav')}))"
		].join("\n");
		const out = spawnSync("python3", ["-c", script], { cwd: path.join(__dirname, "..", "..", "..", "..", "python"), env: Object.assign({}, process.env, { MAILAB_MEDIA_ROOTS: dir }) });
		fs.rmSync(dir, { recursive: true, force: true });
		if (out.status !== 0) {
			throw new Error(String(out.stderr).slice(-800));
		}
		const r = JSON.parse(String(out.stdout).trim().split("\n").pop());
		expect(r.n).toBe(8000);
		expect(Math.abs(r.tone - 1200)).toBeLessThan(2);
		expect(r).toMatchObject({ audio_outside: true, iq_outside: true, wav_outside: true, wav_default: true });
	});
});
