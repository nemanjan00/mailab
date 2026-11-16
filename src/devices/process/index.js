// Generic helper-process instrument. Any program speaking JSON lines on stdio
// becomes a lab device, which is how Python libraries (pymp305, findus, ...)
// plug in. See python/mailab_bridge.py for the helper side.
//
// helper -> lab (stdout, one JSON object per line):
//   {"type": "sample", "field": "v", "value": 3.3, "unit": "V", "t": <ms>}
//   {"type": "samples", "field": "v", "t": [...], "v": [...], "unit": "V"}
//   {"type": "trace", "name": "s11", "x": [...], "series": [{"label": "dB", "y": [...]}], "xUnit": "Hz", "yUnit": "dB"}
//   {"type": "point", "dataset": "glitch", "x": 100, "y": 20, "class": "success", "info": "..."}
//   {"type": "image", "name": "screen", "mime": "image/png", "data": "<base64>"}
//   {"type": "log", "text": "...", "level": "info"}
//   {"type": "status", "state": "running", "detail": "..."}
//   {"type": "value", "name": "graph", "value": {...}}      any JSON document
//   {"type": "audio", "name": "out", "rate": 24000, "data": "<base64 int16 LE>"}
//   {"type": "options", "options": {...}}                    merged into the device options (persisted)
//   {"type": "blob", "name": "dump", "data": "<base64>"}     binary data (dumps, frames)
//   {"type": "event", "name": "burst", "data": {...}}         notify subscribers (triggers, detections)
//   {"type": "panel", "name": "control", "layout": {...}}     publish a custom pane (python/mailab_ui.py)
//   {"type": "result", "id": 1, "result": {...}} | {"type": "result", "id": 1, "error": "..."}
// lab -> helper (stdin):
//   {"id": 1, "command": "set_voltage", "args": {...}}

const spawn = require("child_process").spawn;
const readline = require("readline");

const COMMAND_TIMEOUT_MS = 120000;
const STOP_GRACE_MS = 2000;

const create = (options, io) => {
	let child = null;
	let nextId = 1;
	let lastError = "";
	const pending = {};

	const handlers = {
		sample: (msg) => {
			io.sample(msg.field, msg.value, { unit: msg.unit, t: msg.t });
		},
		samples: (msg) => {
			io.samples(msg.field, msg.t, msg.v, msg.unit);
		},
		trace: (msg) => {
			io.trace(msg.name, msg);
		},
		point: (msg) => {
			io.point(msg.dataset, msg);
		},
		image: (msg) => {
			io.image(msg.name, Buffer.from(msg.data, "base64"), msg.mime);
		},
		log: (msg) => {
			io.log(msg.text, msg.level);
		},
		status: (msg) => {
			io.status(msg.state, msg.detail);
		},
		value: (msg) => {
			io.value(msg.name, msg.value);
		},
		audio: (msg) => {
			io.audio(msg.name, msg.rate, msg.data);
		},
		panel: (msg) => {
			io.panel(msg.name, msg.layout, { title: msg.title, w: msg.w, h: msg.h });
		},
		event: (msg) => {
			io.event(msg.name, msg.data);
		},
		blob: (msg) => {
			io.blob(msg.name, Buffer.from(msg.data, "base64"));
		},
		options: (msg) => {
			io.setOptions(msg.options);
		},
		result: (msg) => {
			const waiter = pending[msg.id];
			if (!waiter) {
				return;
			}
			delete pending[msg.id];
			clearTimeout(waiter.timer);
			if (msg.error) {
				waiter.reject(new Error(msg.error));
			} else {
				waiter.resolve(msg.result);
			}
		}
	};

	const onLine = (line) => {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch (_err) {
			io.log(line, "stdout");
			return;
		}
		const handler = handlers[msg.type];
		if (!handler) {
			io.log("unknown message type: " + msg.type, "warn");
			return;
		}
		handler(msg);
	};

	const rejectAll = (err) => {
		Object.keys(pending).forEach((id) => {
			clearTimeout(pending[id].timer);
			pending[id].reject(err);
			delete pending[id];
		});
	};

	return {
		start: () => {
			child = spawn(options.command, options.args || [], {
				cwd: options.cwd,
				env: Object.assign({}, process.env, { PYTHONUNBUFFERED: "1" }, options.env || {}),
				stdio: ["pipe", "pipe", "pipe"]
			});
			readline.createInterface({ input: child.stdout }).on("line", onLine);
			readline.createInterface({ input: child.stderr }).on("line", (line) => {
				io.log(line, "stderr");
				if (line.trim()) {
					lastError = line.trim();
				}
			});
			child.on("error", (err) => {
				io.status("error", err.message);
			});
			child.on("exit", (code, signal) => {
				const err = new Error("helper exited (" + (signal || code) + ")" + (code ? ": " + lastError : ""));
				rejectAll(err);
				child = null;
				// a crash is an error with its reason; a clean exit (or our stop) is just stopped
				io.status(code ? "error" : "stopped", code ? lastError || err.message : err.message);
			});
			return Promise.resolve();
		},

		stop: () => {
			if (!child) {
				return Promise.resolve();
			}
			const proc = child;
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					proc.kill("SIGKILL");
				}, STOP_GRACE_MS);
				proc.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
				proc.kill("SIGTERM");
			});
		},

		command: (name, args) => {
			if (!child) {
				return Promise.reject(new Error("helper is not running"));
			}
			const id = nextId++;
			return new Promise((resolve, reject) => {
				pending[id] = {
					resolve: resolve,
					reject: reject,
					timer: setTimeout(() => {
						delete pending[id];
						reject(new Error("helper command timeout: " + name));
					}, (args && args.timeoutMs) || COMMAND_TIMEOUT_MS)
				};
				child.stdin.write(JSON.stringify({ id: id, command: name, args: args || {} }) + "\n");
			});
		}
	};
};

/**
 * Build a driver that runs one of the bundled python bridges.
 * @param {{name: string, description: string, script: string, options: Object, commands: Object, args: function(Object): string[]}} spec
 *   args maps device options to the bridge's command-line arguments
 */
const pythonPreset = (spec) => {
	const path = require("path");
	const pyenv = require("../../services/pyenv");
	const media = require("../../services/media");
	return {
		name: spec.name,
		description: spec.description,
		options: spec.options,
		commands: spec.commands,
		requires: spec.requires || [],
		create: (options, io) => {
			let inner = null;
			return {
				// the mailab-managed venv gets the driver's pip requirements first
				start: () => pyenv.ensure(spec.requires || [], (line) => io.log(line, "setup")).then((python) => {
					inner = create({
						command: python,
						args: [path.join(__dirname, "..", "..", "..", "python", spec.script)].concat(spec.args(options)),
						// set last: device options can't widen where bridges may read media
						env: Object.assign({}, options.env || {}, { MAILAB_MEDIA_ROOTS: media.roots().join(":") })
					}, io);
					return inner.start();
				}),
				stop: () => (inner ? inner.stop() : Promise.resolve()),
				command: (name, args) => (inner ? inner.command(name, args) : Promise.reject(new Error("not started")))
			};
		}
	};
};

/**
 * Turn {fooBar: 1, baz: "x"} into ["--foo-bar", "1", "--baz", "x"] for the given keys.
 */
const toFlags = (options, keys) => {
	return keys
		.filter((key) => {
			return options[key] !== undefined && options[key] !== null;
		})
		.reduce((acc, key) => {
			const flag = "--" + key.replace(/[A-Z]/g, (c) => {
				return "-" + c.toLowerCase();
			});
			return acc.concat([flag, String(options[key])]);
		}, []);
};

module.exports = {
	pythonPreset: pythonPreset,
	toFlags: toFlags,
	name: "process",
	description: "Any helper program speaking mailab JSON lines on stdio (see python/mailab_bridge.py)",
	options: {
		command: "executable (required)",
		args: "argument list",
		cwd: "working directory",
		env: "extra environment variables"
	},
	commands: {
		"*": "forwarded to the helper; run command \"help\" to list what it supports"
	},
	create: create
};
