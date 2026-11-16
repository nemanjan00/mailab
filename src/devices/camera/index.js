// Webcams and other Linux video inputs (V4L2: USB cameras, HDMI capture
// boxes) through ffmpeg. Frames stream into image "<id>_frame"; `snapshot`
// saves a JPEG and returns it so the AI can look at the bench.

const fs = require("fs");
const path = require("path");
const spawn = require("child_process").spawn;
const execFile = require("child_process").execFile;
const config = require("../../config");

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const DEFAULTS = { device: "/dev/video0", fps: 5, width: 1280, height: 720, quality: 5 };

/**
 * ffmpeg input arguments. `input` overrides the V4L2 device, e.g.
 * "lavfi:testsrc=size=640x480:rate=5" for a test pattern.
 */
const inputArgs = (s) => {
	// -re: synthetic and file inputs would otherwise run as fast as possible
	if (s.input && s.input.startsWith("lavfi:")) {
		return ["-re", "-f", "lavfi", "-i", s.input.slice("lavfi:".length)];
	}
	if (s.input) {
		return ["-re", "-i", s.input];
	}
	const args = ["-f", "v4l2", "-framerate", String(s.fps), "-video_size", s.width + "x" + s.height];
	if (s.inputFormat) {
		args.push("-input_format", s.inputFormat);
	}
	return args.concat(["-i", s.device]);
};

// split a byte stream of concatenated JPEGs into frames
const jpegSplitter = (onFrame) => {
	let pending = Buffer.alloc(0);
	return (chunk) => {
		pending = Buffer.concat([pending, chunk]);
		let start = pending.indexOf(SOI);
		let end = pending.indexOf(EOI, start + 2);
		while (start !== -1 && end !== -1) {
			onFrame(pending.slice(start, end + 2));
			pending = pending.slice(end + 2);
			start = pending.indexOf(SOI);
			end = pending.indexOf(EOI, start + 2);
		}
		if (pending.length > MAX_PENDING_BYTES) {
			pending = Buffer.alloc(0);
		}
	};
};

const run = (cmd, args) => {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error((stderr || err.message).trim()));
				return;
			}
			resolve(stdout);
		});
	});
};

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	let proc = null;
	let latest = null;
	let frames = 0;
	let stopping = false;

	const launch = () => {
		const args = ["-hide_banner", "-loglevel", "error"].concat(inputArgs(settings), [
			"-vf", "fps=" + settings.fps,
			"-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", String(settings.quality), "-"
		]);
		io.log("ffmpeg " + args.join(" "), "tx");
		proc = spawn("ffmpeg", args);
		proc.stdout.on("data", jpegSplitter((frame) => {
			latest = frame;
			frames++;
			io.image("frame", frame, "image/jpeg");
		}));
		proc.stderr.on("data", (data) => {
			io.log(data.toString().trim(), "stderr");
		});
		proc.on("exit", (code) => {
			proc = null;
			if (!stopping) {
				io.status("error", "ffmpeg exited " + code);
			}
		});
	};

	const kill = () => {
		if (!proc) {
			return Promise.resolve();
		}
		const old = proc;
		return new Promise((resolve) => {
			old.once("exit", resolve);
			old.kill();
		});
	};

	const snapshot = (args) => {
		if (!latest) {
			return Promise.reject(new Error("no frame yet"));
		}
		const frame = latest;
		io.image("snapshot", frame, "image/jpeg");
		let saved = null;
		if (args.save !== false) {
			const dir = path.join(config.get("DATA_DIR"), "snapshots");
			fs.mkdirSync(dir, { recursive: true });
			saved = path.join(dir, io.id + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jpg");
			fs.writeFileSync(saved, frame);
		}
		return Promise.resolve({ path: saved, bytes: frame.length, _image: { data: frame.toString("base64"), mime: "image/jpeg" } });
	};

	return {
		start: () => {
			launch();
			return Promise.resolve();
		},

		stop: () => {
			stopping = true;
			return kill();
		},

		command: (name, args) => {
			const a = args || {};
			if (name === "snapshot") {
				return snapshot(a);
			}
			if (name === "configure") {
				Object.assign(settings, a);
				return kill().then(() => {
					launch();
					return settings;
				});
			}
			if (name === "status") {
				return Promise.resolve({ frames: frames, running: Boolean(proc), settings: settings });
			}
			if (name === "devices") {
				return run("v4l2-ctl", ["--list-devices"]).then((out) => {
					return { output: out };
				});
			}
			if (name === "formats") {
				return run("v4l2-ctl", ["-d", settings.device, "--list-formats-ext"]).then((out) => {
					return { output: out };
				});
			}
			if (name === "controls") {
				return run("v4l2-ctl", ["-d", settings.device, "--list-ctrls"]).then((out) => {
					return { output: out };
				});
			}
			if (name === "set_control") {
				return run("v4l2-ctl", ["-d", settings.device, "--set-ctrl=" + a.name + "=" + a.value]).then(() => {
					return { ok: true };
				});
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "camera",
	description: "Webcam / V4L2 video input (USB cameras, HDMI capture) via ffmpeg: image <id>_frame (live), snapshot",
	options: {
		device: "V4L2 device (default /dev/video0)",
		fps: "preview frames per second (default 5)",
		width: "default 1280",
		height: "default 720",
		inputFormat: "V4L2 input format, e.g. mjpeg or yuyv422",
		quality: "JPEG quality 2 (best) .. 31 (default 5)",
		input: "any ffmpeg input instead of the device; \"lavfi:testsrc=size=640x480:rate=5\" for a test pattern"
	},
	commands: {
		snapshot: "{save: true} latest frame as image <id>_snapshot, saved to DATA_DIR/snapshots, returned to the AI",
		configure: "{device, fps, width, height, inputFormat, quality, input} restarts capture",
		status: "frame count, settings",
		devices: "v4l2-ctl --list-devices",
		formats: "supported formats/sizes",
		controls: "camera controls (exposure, focus, ...)",
		set_control: "{name, value}"
	},
	create: create,
	_jpegSplitter: jpegSplitter
};
