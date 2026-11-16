// Proxmark3 (RRG/Iceman client) via node-proxmark3. Runs raw client commands;
// for the full typed command set, use node-proxmark3's own pm3-mcp server.
// Several Proxmarks: one device each with its own `port`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const pm3 = require("node-proxmark3");
const config = require("../../config");

// node-proxmark3 spawns the client with fixed arguments, so a per-device
// wrapper script adds the port
const clientFor = (options, id) => {
	const client = options.client || config.get("PM3_CLIENT");
	if (!options.port) {
		return client;
	}
	const script = path.join(os.tmpdir(), "mailab-pm3-" + id + ".sh");
	fs.writeFileSync(script, "#!/bin/sh\nexec " + JSON.stringify(client) + " " + JSON.stringify(options.port) + " \"$@\"\n", { mode: 0o755 });
	return script;
};

const create = (options, io) => {
	let prox = null;

	const run = (text) => {
		io.log(text, "tx");
		// node-proxmark3 builds commands from a property chain: hw.version.exec()
		const node = text.trim().split(/\s+/).reduce((acc, word) => {
			return acc[word];
		}, prox.command);
		return node.exec([]).then((output) => {
			output.split("\n").slice(0, 100).forEach((line) => {
				io.log(line, "rx");
			});
			return output;
		});
	};

	return {
		start: () => {
			return pm3.client(clientFor(options, io.id)).then((client) => {
				prox = client;
				return run("hw version");
			}).then(() => {
				return undefined;
			});
		},

		stop: () => {
			if (prox && prox.client && prox.client._child) {
				prox.client._child.kill();
			}
			return Promise.resolve();
		},

		command: (name, args) => {
			if (name === "run") {
				return run(args.command).then((output) => {
					return { output: output };
				});
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "proxmark3",
	description: "Proxmark3 RFID tool (RRG client via node-proxmark3)",
	options: {
		client: "path to the proxmark3 client binary (default PM3_CLIENT)",
		port: "serial port, e.g. /dev/ttyACM0 (needed with several Proxmarks)"
	},
	commands: {
		run: "{command} any client command, e.g. \"hf search\", \"lf search\", \"hw tune\""
	},
	create: create
};
