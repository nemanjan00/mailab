// Proxmark3 (RRG/Iceman client) via node-proxmark3. Runs raw client commands;
// for the full typed command set, use node-proxmark3's own pm3-mcp server.
// Several Proxmarks: one device each with its own `port`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const pm3 = require("node-proxmark3");
const config = require("../../config");
const usb = require("../../services/usb");

// RRG/Iceman firmware enumerates as 9ac4:4b8f (PM3 RDV4, Easy, PM5)
const PM3_USB = { vid: "9ac4", pid: "4b8f" };

// port from options.port, or found by identity (serial number survives replugs)
const portFor = (options) => {
	if (options.port || !options.match) {
		return options.port;
	}
	const found = usb.findPort(usb.serialPorts(usb.inventory().buses), Object.assign({}, PM3_USB, options.match));
	if (!found) {
		throw new Error("no Proxmark matching " + JSON.stringify(options.match));
	}
	return found.node;
};

const START_TIMEOUT_MS = 30000;

// node-proxmark3's interpreter.lua does require("json"), but the published
// package lacks json.lua (empty libs/json submodule); the client ships
// dkjson with the same API, so a shim on LUA_PATH provides it
const luaShim = () => {
	const dir = path.join(os.tmpdir(), "mailab-pm3-lua");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "json.lua"), "return require('dkjson')\n");
	return dir;
};

const quote = (text) => "'" + String(text).replace(/'/g, "'\\''") + "'";

// node-proxmark3 spawns the client with fixed arguments, so a per-device
// wrapper script adds the port and LUA_PATH, and records the client's pid
// (exec keeps it) so a client that never starts can be killed
const clientFor = (options, id) => {
	const client = options.client || config.get("PM3_CLIENT");
	const port = portFor(options);
	const base = path.join(os.tmpdir(), "mailab-pm3-" + id);
	const lines = [
		"#!/bin/sh",
		"echo $$ > " + quote(base + ".pid"),
		"export LUA_PATH=" + quote(path.join(luaShim(), "?.lua") + ";;"),
		"exec " + quote(client) + (port ? " " + quote(port) : "") + " \"$@\""
	];
	fs.writeFileSync(base + ".sh", lines.join("\n") + "\n", { mode: 0o755 });
	return { script: base + ".sh", pidFile: base + ".pid", port: port };
};

const killPidFile = (file) => {
	try {
		process.kill(Number(fs.readFileSync(file, "utf8").trim()));
	} catch (_err) {
		// already gone
	}
};

const create = (options, io) => {
	let prox = null;
	let port = null;

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
		// resolved serial port, for the USB tree / uart_ports
		port: () => (prox ? port : null),

		start: () => {
			let wrapper = null;
			let timer = null;
			return Promise.resolve().then(() => {
				wrapper = clientFor(options, io.id);
				port = wrapper.port || null;
				return Promise.race([
					pm3.client(wrapper.script),
					new Promise((_resolve, reject) => {
						timer = setTimeout(() => {
							killPidFile(wrapper.pidFile);
							reject(new Error("proxmark3 client did not start within " + START_TIMEOUT_MS / 1000 + " s (port busy, or the client's lua interpreter failed)"));
						}, START_TIMEOUT_MS);
					})
				]);
			}).then((client) => {
				clearTimeout(timer);
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
	description: "Proxmark3 / Proxmark5 RFID tool (RRG/Iceman client via node-proxmark3)",
	options: {
		client: "path to the proxmark3 client binary (default PM3_CLIENT)",
		port: "serial port, e.g. /dev/ttyACM0 (needed with several Proxmarks)",
		match: "{serial}: pick the Proxmark by USB serial instead of a port (see uart_ports); survives re-enumeration"
	},
	commands: {
		run: "{command} any client command, e.g. \"hf search\", \"lf search\", \"hw tune\""
	},
	create: create
};
