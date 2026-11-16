// Audio / video decode and encode through ffmpeg (sox as an audio-decode
// fallback): media files or lab blobs → raw PCM or frames, PCM or images →
// encoded files. Inputs are a lab blob (piped on stdin) or a path inside the
// allowed media directories: ffmpeg also opens URLs and renders text files
// (tty demuxer), so paths are confined and only file/pipe protocols allowed.

const fs = require("fs");
const os = require("os");
const path = require("path");
const spawn = require("child_process").spawn;
const config = require("../../config");

const MAX_OUTPUT = 256 * 1024 * 1024;
const TIMEOUT_MS = 120000;
const PCM_FORMATS = { s16le: 2, f32le: 4, u8: 1, s32le: 4 };
const AUDIO_CODECS = {
	wav: ["-f", "wav"],
	flac: ["-f", "flac"],
	mp3: ["-f", "mp3", "-c:a", "libmp3lame"],
	ogg: ["-f", "ogg", "-c:a", "libvorbis"],
	opus: ["-f", "ogg", "-c:a", "libopus"]
};
const VIDEO_FORMATS = {
	mp4: ["-f", "mp4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov"],
	webm: ["-f", "webm", "-c:v", "libvpx-vp9"],
	gif: ["-f", "gif"]
};
const SAFE = ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe"];

/**
 * Directories media paths may come from (MAILAB_MEDIA_DIRS, ":"-separated;
 * DATA_DIR/media always).
 */
const roots = () => [path.join(config.get("DATA_DIR"), "media")]
	.concat(String(config.get("MAILAB_MEDIA_DIRS") || "").split(":").filter(Boolean))
	.map((d) => path.resolve(d.replace(/^~(?=$|\/)/, os.homedir())));

const checkPath = (file) => {
	if (typeof file !== "string" || !path.isAbsolute(file)) {
		throw new Error("media path must be absolute");
	}
	let real;
	try {
		real = fs.realpathSync(file);
	} catch (err) {
		throw new Error("no such file: " + file, { cause: err });
	}
	if (!roots().some((r) => real === r || real.startsWith(r + path.sep))) {
		throw new Error("media paths must be inside " + roots().join(", ") + " (set MAILAB_MEDIA_DIRS), or upload the file as a blob");
	}
	return real;
};

/**
 * @param {{path: string, data: Buffer}} input
 * @returns {{args: string[], stdin: Buffer|null}} ffmpeg input arguments
 */
const inputArgs = (input) => {
	if (input && Buffer.isBuffer(input.data)) {
		return { args: ["-i", "pipe:0"], stdin: input.data };
	}
	return { args: ["-i", "file:" + checkPath(input && input.path)], stdin: null };
};

const run = (cmd, args, stdin) => new Promise((resolve, reject) => {
	const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
	const chunks = [];
	let size = 0;
	let err = "";
	const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
	child.stdout.on("data", (d) => {
		size += d.length;
		if (size > MAX_OUTPUT) {
			child.kill("SIGKILL");
			return;
		}
		chunks.push(d);
	});
	child.stderr.on("data", (d) => {
		err = (err + d).slice(-4000);
	});
	// ffmpeg may stop reading stdin early (it has enough): not an error
	child.stdin.on("error", () => null);
	child.on("error", (e) => {
		clearTimeout(timer);
		reject(new Error(cmd + ": " + e.message));
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		if (size > MAX_OUTPUT) {
			reject(new Error("output larger than " + MAX_OUTPUT / 1048576 + " MB"));
		} else if (code !== 0) {
			reject(new Error(cmd + " failed: " + (err.trim().split("\n").slice(-2).join(" ") || "exit " + code)));
		} else {
			resolve(Buffer.concat(chunks));
		}
	});
	child.stdin.end(stdin || undefined);
});

const ffmpeg = () => config.get("FFMPEG") || "ffmpeg";

const media = {
	roots: roots,
	checkPath: checkPath,

	/**
	 * Container, duration and streams (codec, rate, channels, size) via ffprobe.
	 */
	probe: (input) => {
		const i = inputArgs(input);
		const args = ["-v", "error", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_format", "-show_streams"].concat(i.args.slice(1));
		return run(config.get("FFPROBE") || "ffprobe", args, i.stdin).then((out) => {
			const info = JSON.parse(out.toString("utf8"));
			const f = info.format || {};
			return {
				format: f.format_name,
				duration: f.duration === undefined ? null : Number(f.duration),
				bytes: f.size === undefined ? null : Number(f.size),
				streams: (info.streams || []).map((s) => ({
					index: s.index, type: s.codec_type, codec: s.codec_name,
					rate: s.sample_rate ? Number(s.sample_rate) : undefined, channels: s.channels,
					width: s.width, height: s.height, fps: s.avg_frame_rate, frames: s.nb_frames ? Number(s.nb_frames) : undefined
				}))
			};
		});
	},

	/**
	 * Decode audio to raw PCM.
	 * @param {Object} input {path} or {data}
	 * @param {{rate: number, channels: number, format: string, start: number, duration: number, engine: string}} [options]
	 *   format s16le (default) | f32le | s32le | u8; engine ffmpeg (default) | sox (paths only)
	 * @returns {Promise<{pcm: Buffer, rate, channels, format, samples}>}
	 */
	decodeAudio: (input, options) => {
		const o = Object.assign({ rate: 48000, channels: 1, format: "s16le" }, options || {});
		if (!PCM_FORMATS[o.format]) {
			throw new Error("format: " + Object.keys(PCM_FORMATS).join(" | "));
		}
		const rate = Number(o.rate);
		const channels = Number(o.channels);
		if (!(rate >= 1000 && rate <= 384000) || !(channels >= 1 && channels <= 8)) {
			throw new Error("rate 1000…384000, channels 1…8");
		}
		const done = (pcm) => ({ pcm: pcm, rate: rate, channels: channels, format: o.format, samples: pcm.length / PCM_FORMATS[o.format] / channels });
		if (o.engine === "sox") {
			const file = checkPath(input && input.path);
			const enc = { s16le: ["-e", "signed", "-b", "16"], f32le: ["-e", "floating-point", "-b", "32"], s32le: ["-e", "signed", "-b", "32"], u8: ["-e", "unsigned", "-b", "8"] }[o.format];
			return run(config.get("SOX") || "sox", [file, "-t", "raw", "-r", String(rate), "-c", String(channels), "-L"].concat(enc, ["-"]), null).then(done);
		}
		const i = inputArgs(input);
		const trim = [].concat(o.start ? ["-ss", String(Number(o.start))] : [], o.duration ? ["-t", String(Number(o.duration))] : []);
		return run(ffmpeg(), SAFE.concat(trim, i.args, ["-vn", "-ac", String(channels), "-ar", String(rate), "-f", o.format, "pipe:1"]), i.stdin).then(done);
	},

	/**
	 * Encode raw PCM to a file format.
	 * @param {Buffer} pcm
	 * @param {{rate, channels, format, codec, bitrate}} options codec wav (default) | flac | mp3 | ogg | opus
	 */
	encodeAudio: (pcm, options) => {
		const o = Object.assign({ rate: 48000, channels: 1, format: "s16le", codec: "wav" }, options || {});
		if (!PCM_FORMATS[o.format] || !AUDIO_CODECS[o.codec]) {
			throw new Error("format: " + Object.keys(PCM_FORMATS).join("|") + ", codec: " + Object.keys(AUDIO_CODECS).join("|"));
		}
		const bitrate = o.bitrate ? ["-b:a", String(o.bitrate).replace(/[^0-9kK]/g, "")] : [];
		return run(ffmpeg(), SAFE.concat(["-f", o.format, "-ar", String(Number(o.rate)), "-ac", String(Number(o.channels)), "-i", "pipe:0"], AUDIO_CODECS[o.codec], bitrate, ["pipe:1"]), pcm);
	},

	/**
	 * Decode video frames to PNG images.
	 * @param {Object} input {path} or {data}
	 * @param {{fps: number, start: number, maxFrames: number, width: number}} [options]
	 * @returns {Promise<Buffer[]>} PNG files
	 */
	videoFrames: (input, options) => {
		const o = Object.assign({ fps: 1, maxFrames: 10 }, options || {});
		const maxFrames = Math.min(Math.max(1, Number(o.maxFrames) || 1), 200);
		const filters = ["fps=" + Number(o.fps)].concat(o.width ? ["scale=" + Number(o.width) + ":-2"] : []);
		const i = inputArgs(input);
		const start = o.start ? ["-ss", String(Number(o.start))] : [];
		return run(ffmpeg(), SAFE.concat(start, i.args, ["-an", "-vf", filters.join(","), "-frames:v", String(maxFrames), "-f", "image2pipe", "-c:v", "png", "pipe:1"]), i.stdin)
			.then(splitPngs);
	},

	/**
	 * Encode still images (PNG/JPEG buffers, one size) into a video.
	 * @param {Buffer[]} frames
	 * @param {{fps: number, format: string}} options format mp4 (default) | webm | gif
	 */
	encodeVideo: (frames, options) => {
		const o = Object.assign({ fps: 5, format: "mp4" }, options || {});
		if (!VIDEO_FORMATS[o.format]) {
			throw new Error("format: " + Object.keys(VIDEO_FORMATS).join(" | "));
		}
		if (!frames.length) {
			throw new Error("no frames");
		}
		const even = o.format === "gif" ? [] : ["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"];
		return run(ffmpeg(), SAFE.concat(["-f", "image2pipe", "-framerate", String(Number(o.fps)), "-i", "pipe:0"], even, VIDEO_FORMATS[o.format], ["pipe:1"]), Buffer.concat(frames));
	}
};

const PNG_END = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

// image2pipe output is PNG files back to back: split on IEND
const splitPngs = (buf) => {
	const out = [];
	let start = 0;
	let at = buf.indexOf(PNG_END, start);
	while (at !== -1) {
		out.push(buf.subarray(start, at + PNG_END.length));
		start = at + PNG_END.length;
		at = buf.indexOf(PNG_END, start);
	}
	return out;
};

media.splitPngs = splitPngs;
media.PCM_FORMATS = PCM_FORMATS;

module.exports = media;
