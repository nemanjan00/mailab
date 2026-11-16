// Generic line-based serial instrument: parses each line into channels and
// lets the AI write/query raw text.

const tty = require("../../services/tty");
const lineparse = require("../../utils/lineparse");

const DEFAULT_QUERY_TIMEOUT_MS = 1000;

const create = (options, io) => {
	const parser = options.parser || "kv";
	let port = null;
	let pending = "";
	let capture = null;

	const onLine = (line) => {
		io.log(line, "rx");
		if (capture) {
			capture.push(line);
		}
		const values = lineparse.parse(parser, line, options.fields);
		const t = Date.now();
		Object.keys(values).forEach((field) => {
			io.sample(field, values[field], { t: t, unit: (options.units || {})[field] });
		});
	};

	const onData = (data) => {
		const text = pending + data.toString("utf8");
		const lines = text.split(/\r?\n/);
		pending = lines.pop();
		lines.map((line) => {
			return line.trim();
		}).filter(Boolean).forEach(onLine);
	};

	const write = (text) => {
		io.log(text, "tx");
		port.write(text + (options.eol || "\n"));
	};

	return {
		start: () => {
			port = tty.open(options.path, { baud: options.baud });
			port.on("data", onData);
			port.on("error", (err) => {
				io.status("error", err.message);
			});
			return Promise.resolve();
		},

		stop: () => {
			if (!port) {
				return Promise.resolve();
			}
			return port.close();
		},

		command: (name, args) => {
			if (name === "write") {
				write(args.text);
				return Promise.resolve({ ok: true });
			}
			if (name === "query") {
				capture = [];
				write(args.text);
				return new Promise((resolve) => {
					setTimeout(() => {
						const lines = capture;
						capture = null;
						resolve({ lines: lines });
					}, args.timeoutMs || DEFAULT_QUERY_TIMEOUT_MS);
				});
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "serial",
	description: "Line-based serial instrument (Arduino, custom firmware, anything printing readings)",
	options: {
		path: "serial device, e.g. /dev/ttyACM0 (required)",
		baud: "baud rate (default 115200)",
		parser: "kv (v=1.2 i=0.3) | csv | number | raw (default kv)",
		fields: "column names for csv parser",
		units: "{field: unit}",
		eol: "line ending for writes (default \\n)"
	},
	commands: {
		write: "{text} send a line",
		query: "{text, timeoutMs} send a line and return lines received within timeout"
	},
	create: create
};
