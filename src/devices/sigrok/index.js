// sigrok-cli backed devices: logic analyzers (Sipeed SLogic via the
// nemanjan00/libsigrok fork, DSLogic, ...), and sigrok-supported meters.
//  - capture: one-shot acquisition -> traces (x = seconds)
//  - decode:  run protocol decoders, return annotations
//  - stream:  continuous analog readings -> channels (meters)

const spawn = require("child_process").spawn;
const execFile = require("child_process").execFile;
const readline = require("readline");
const config = require("../../config");

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_TRACE_POINTS = 200000;
const UNIT_SCALE = { "": 1, k: 1e3, M: 1e6, G: 1e9 };
// "P1: 3.300000 V DC" / "A0: -1.5 mV"
const ANALOG_RE = /^([^:]+):\s*(-?[0-9.]+(?:e[-+]?[0-9]+)?)\s*(.*)$/i;

const deviceSpec = (options) => {
	if (options.conn) {
		return options.driver + ":conn=" + options.conn;
	}
	return options.driver;
};

const configArgs = (settings) => {
	return Object.keys(settings || {}).reduce((acc, key) => {
		return acc.concat(["--config", key + "=" + settings[key]]);
	}, []);
};

const parseSamplerate = (text) => {
	const match = /([0-9.]+)\s*([kMG]?)Hz/.exec(text);
	if (!match) {
		return null;
	}
	return Number(match[1]) * UNIT_SCALE[match[2]];
};

// stride-decimate so huge captures stay displayable
const decimate = (values, max) => {
	if (values.length <= max) {
		return values;
	}
	const stride = Math.ceil(values.length / max);
	return values.filter((_, i) => {
		return i % stride === 0;
	});
};

/**
 * Parse sigrok csv output (with ";" comment header) into columns.
 */
const parseCsv = (text) => {
	const lines = text.split("\n");
	const comments = lines.filter((line) => {
		return line.startsWith(";");
	});
	const rows = lines.filter((line) => {
		return line && !line.startsWith(";");
	});
	const channelLine = comments.find((line) => {
		return line.startsWith("; Channels");
	}) || "";
	const names = channelLine.replace(/^; Channels \([^)]*\):\s*/, "").split(",").map((name) => {
		return name.trim();
	});
	const rateLine = comments.find((line) => {
		return line.startsWith("; Samplerate");
	}) || "";
	const units = rows[0].split(",");
	const data = rows.slice(1).map((row) => {
		return row.split(",").map(Number);
	});
	return {
		samplerate: parseSamplerate(rateLine),
		columns: names.map((name, i) => {
			return {
				name: name,
				unit: units[i],
				values: data.map((row) => {
					return row[i];
				})
			};
		})
	};
};

const create = (options, io) => {
	const cli = options.cli || config.get("SIGROK_CLI");
	let streamProc = null;

	// encoding "buffer" for binary output (-O binary)
	const run = (args, encoding) => {
		io.log(cli + " " + args.join(" "), "tx");
		return new Promise((resolve, reject) => {
			execFile(cli, args, { maxBuffer: MAX_OUTPUT_BYTES, encoding: encoding || "utf8" }, (err, stdout, stderr) => {
				if (err) {
					reject(new Error((String(stderr || "") || err.message).trim()));
					return;
				}
				resolve(stdout);
			});
		});
	};

	const baseArgs = (args) => {
		const settings = Object.assign({}, options.config, args.config);
		if (args.samplerate) {
			settings.samplerate = args.samplerate;
		}
		const out = ["-d", deviceSpec(options)].concat(configArgs(settings));
		const channels = args.channels || options.channels;
		if (channels) {
			return out.concat(["-C", channels]);
		}
		return out;
	};

	const acquisition = (args) => {
		if (args.time) {
			return ["--time", String(args.time)];
		}
		return ["--samples", String(args.samples || 10000)];
	};

	const startStream = () => {
		const args = baseArgs({}).concat(["--continuous", "-O", "analog"]);
		streamProc = spawn("stdbuf", ["-oL", cli].concat(args));
		readline.createInterface({ input: streamProc.stdout }).on("line", (line) => {
			const match = ANALOG_RE.exec(line.trim());
			if (!match) {
				return;
			}
			const unit = match[3].trim();
			io.sample(match[1].trim(), Number(match[2]), { unit: unit });
		});
		readline.createInterface({ input: streamProc.stderr }).on("line", (line) => {
			io.log(line, "stderr");
		});
		streamProc.on("exit", (code) => {
			io.status("stopped", "sigrok-cli exited " + code);
		});
	};

	return {
		start: () => {
			if (options.mode === "stream") {
				startStream();
			}
			return Promise.resolve();
		},

		stop: () => {
			if (streamProc) {
				streamProc.kill();
			}
			return Promise.resolve();
		},

		command: (name, args) => {
			const a = args || {};
			if (name === "scan") {
				return run(["--scan"]).then((out) => {
					return { output: out };
				});
			}
			if (name === "show") {
				return run(["-d", deviceSpec(options), "--show"]).then((out) => {
					return { output: out };
				});
			}
			if (name === "capture") {
				return run(baseArgs(a).concat(acquisition(a), ["-O", "csv"])).then((out) => {
					const parsed = parseCsv(out);
					const rate = parsed.samplerate || 1;
					const count = parsed.columns[0].values.length;
					const x = decimate(Array.from({ length: count }, (_, i) => {
						return i / rate;
					}), MAX_TRACE_POINTS);
					io.trace(a.name || "capture", {
						x: x,
						xUnit: "s",
						yUnit: "",
						mode: "step",
						series: parsed.columns.map((column, index) => {
							// logic channels are stacked so they don't overlap
							let offset = 0;
							if (column.unit === "logic") {
								offset = index * 1.5;
							}
							return {
								label: column.name + " (" + column.unit + ")",
								y: decimate(column.values, MAX_TRACE_POINTS).map((v) => {
									return v + offset;
								})
							};
						})
					});
					return {
						samplerate: rate,
						samples: count,
						channels: parsed.columns.map((column) => {
							return column.name;
						}),
						trace: a.name || "capture"
					};
				});
			}
			if (name === "capture_blob") {
				// raw logic (one byte per sample per 8 channels) for the flowgraph decode command / block
				const blobName = a.name || "logic";
				return run(baseArgs(a).concat(acquisition(a), ["-O", "binary"]), "buffer").then((out) => {
					io.blob(blobName, out);
					return { blob: io.id + "_" + blobName, bytes: out.length, samplerate: a.samplerate || (options.config || {}).samplerate || null };
				});
			}
			if (name === "decode") {
				// e.g. decoders: ["uart:rx=D0:baudrate=115200"], annotations: "uart=rx-data"
				const decoders = [].concat(a.decoders || []).reduce((acc, d) => {
					return acc.concat(["-P", d]);
				}, []);
				let annotations = [];
				if (a.annotations) {
					annotations = ["-A", a.annotations];
				}
				return run(baseArgs(a).concat(acquisition(a), decoders, annotations)).then((out) => {
					const lines = out.split("\n").filter(Boolean);
					lines.slice(0, 200).forEach((line) => {
						io.log(line, "decode");
					});
					return { count: lines.length, annotations: lines.slice(0, 2000) };
				});
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "sigrok",
	description: "sigrok-cli devices: logic analyzers (Sipeed SLogic, DSLogic, demo), sigrok meters",
	options: {
		driver: "sigrok driver, e.g. sipeed-slogic-analyzer, dreamsourcelab-dslogic, demo (required)",
		conn: "connection spec if needed (e.g. /dev/ttyUSB0)",
		channels: "default channel list, e.g. D0,D1",
		config: "{samplerate: \"10m\", ...} default --config pairs",
		mode: "\"stream\" to read continuous analog values into channels (meters)",
		cli: "sigrok-cli binary (default SIGROK_CLI)"
	},
	commands: {
		scan: "list connected sigrok devices",
		show: "device options",
		capture: "{samples | time, samplerate, channels, name} -> trace (x = seconds, logic channels stacked)",
		capture_blob: "{samples | time, samplerate, channels, name} -> raw logic blob <device>_<name> (u8 per sample up to 8 channels, u16 above) for flowgraph decode {blob}",
		decode: "{samples | time, samplerate, channels, decoders: [\"uart:rx=D0:baudrate=115200\"], annotations: \"uart=rx-data\"}"
	},
	create: create,
	_parseCsv: parseCsv
};
