// Proxmark3 (RRG/Iceman client) via node-proxmark3. Runs raw client commands;
// for the full typed command set, use node-proxmark3's own pm3-mcp server.

const pm3 = require("node-proxmark3");
const config = require("../../config");

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
			return pm3.client(options.client || config.get("PM3_CLIENT")).then((client) => {
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
		client: "path to the proxmark3 client binary (default PM3_CLIENT)"
	},
	commands: {
		run: "{command} any client command, e.g. \"hf search\", \"lf search\", \"hw tune\""
	},
	create: create
};
