// InfiRay P2 Pro thermal camera (and generic UVC webcams) via ffmpeg's
// v4l2 input: single frames and a streaming image feed. Radiometric
// min/max/centre temperatures need the vendor UVC extension protocol and
// stay pending on hardware [HW]; `v4l2` passthrough commands are provided
// for manual probing.

const { execFile } = require("child_process");
const tool = require("../../utils/tool");

const DEFAULTS = { device: "/dev/video0", width: 256, height: 192, fps: 25, timeoutMs: 15000 };

const create = (options, io) => {
	const settings = {
		exe: options.exe || "ffmpeg",
		device: options.device || DEFAULTS.device,
		input: options.input || null, // test seam: e.g. "testsrc=size=160x120:rate=1" (lavfi)
		width: Number(options.width) || DEFAULTS.width,
		height: Number(options.height) || DEFAULTS.height,
		fps: Number(options.fps) || DEFAULTS.fps,
		timeoutMs: Number(options.timeoutMs) || DEFAULTS.timeoutMs
	};
	let streamTimer = null;
	const stats = { frames: 0 };

	// ffmpeg argv for one frame from the (or a fake) capture source
	const frameArgs = () => {
		if (settings.input) {
			return ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", settings.input, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-"];
		}
		return ["-hide_banner", "-loglevel", "error", "-f", "v4l2", "-video_size", settings.width + "x" + settings.height,
			"-framerate", String(settings.fps), "-i", settings.device, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-"];
	};

	const grab = () => {
		return new Promise((resolve, reject) => {
			const child = execFile(settings.exe, frameArgs(), { timeout: settings.timeoutMs, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
				if (err) {
					reject(new Error(settings.exe + ": " + String(stderr || err.message).trim().split("\n").pop()));
					return;
				}
				if (!stdout || stdout.length < 100) {
					reject(new Error("no frame captured (device missing or not a UVC camera?)"));
					return;
				}
				resolve(stdout);
			});
			child.stdin.end();
		});
	};

	const commands = {
		// one JPEG frame -> image <id>_frame (also returned)
		frame: (args) => {
			return grab().then((jpg) => {
				stats.frames++;
				const name = args.name || "frame";
				io.image(name, jpg, "image/jpeg");
				return { _image: { data: jpg.toString("base64"), mime: "image/jpeg" }, image: io.id + "_" + name, bytes: jpg.length };
			});
		},

		// periodic frames into the image stream (like a watch)
		stream: (args) => {
			if (streamTimer) {
				clearInterval(streamTimer);
				streamTimer = null;
			}
			if (!args || args.on === false) {
				return { streaming: false };
			}
			const intervalMs = Math.max(200, Number(args.intervalMs) || 1000);
			streamTimer = setInterval(() => {
				grab().then((jpg) => {
					stats.frames++;
					io.image("frame", jpg, "image/jpeg");
				}).catch((err) => io.log("frame grab failed: " + err.message, "warn"));
			}, intervalMs);
			return { streaming: true, intervalMs: intervalMs };
		},

		// passthrough to v4l2-ctl for UVC extension probing (radiometric data [HW])
		v4l2: (args) => {
			const cli = (args.args || []).map((a) => String(a));
			return tool.run("v4l2-ctl", cli.concat(["-d", settings.device]), { timeoutMs: settings.timeoutMs }).then((r) => {
				r.output.trim().split("\n").slice(0, 80).forEach((line) => io.log(line, "rx"));
				return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
			});
		},

		status: () => ({ settings: settings, streaming: Boolean(streamTimer), frames: stats.frames })
	};

	return {
		start: () => Promise.resolve(),
		stop: () => {
			if (streamTimer) {
				clearInterval(streamTimer);
				streamTimer = null;
			}
			return Promise.resolve();
		},
		command: (name, args) => {
			if (!commands[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		}
	};
};

module.exports = {
	name: "infray",
	description: "InfiRay P2 Pro thermal camera / generic UVC webcam via ffmpeg: single frames and streamed image feed; v4l2-ctl passthrough for UVC extension probing (radiometric temperatures pending on hardware [HW])",
	options: {
		device: "v4l2 device (default /dev/video0)",
		width: "capture width (default 256)", height: "capture height (default 192)", fps: "framerate (default 25)",
		exe: "ffmpeg binary (default from PATH)",
		input: "TEST SEAM: lavfi source instead of the v4l2 device, e.g. testsrc=size=160x120:rate=1",
		timeoutMs: "per-frame timeout (default 15000)"
	},
	commands: {
		frame: "{name?} one JPEG frame -> image <id>_<name> (returned too)",
		stream: "{on: false, intervalMs?} periodic frames into the image stream",
		v4l2: "{args: []} v4l2-ctl passthrough (-d <device> appended)",
		status: "{} settings, stream state, frame count"
	},
	create: create
};
