// OpenOCD as a lab instrument: the daemon is spawned with configurable
// adapter/interface/target args and driven over its telnet port (line
// commands, "> " prompt). Handles targets without a config file, e.g.
// Tigard port B: args: ["-c", "adapter driver ftdi", "-c",
// "ftdi_device_desc Tigard", ...]. Memory reads return blobs; flash writes
// program lab blobs/files via OpenOCD's `program` command.

const net = require("net");
const fs = require("fs");
const path = require("path");
const spawn = require("child_process").spawn;
const tool = require("../../utils/tool");

const DEFAULT_PORT = 4444;
const START_TIMEOUT_MS = 15000;
const CMD_TIMEOUT_MS = 30000;

const parseHex = (hex) => {
	const clean = String(hex).replace(/0x/gi, "").replace(/[\s,:]/g, "");
	if (!/^([0-9a-f]{2})*$/i.test(clean)) {
		throw new Error("hex must be pairs of hex digits");
	}
	return Buffer.from(clean, "hex");
};

// mdb/mdh/mdw output lines: "01234567: 00 11 22 ..." -> bytes
const parseDump = (text, _widthBytes) => {
	const out = [];
	text.split(/\r?\n/).forEach((line) => {
		const m = /^[0-9a-fA-F]{8,16}:\s+((?:[0-9a-fA-F]{2,8}\s*)+)/.exec(line.trim());
		if (!m) {
			return;
		}
		const hex = m[1].replace(/\s/g, "");
		for (let i = 0; i + 2 <= hex.length; i += 2) {
			out.push(parseInt(hex.slice(i, i + 2), 16));
		}
	});
	return Buffer.from(out);
};

const create = (options, io) => {
	let proc = null;
	let sock = null;
	let stopped = false;
	let pending = "";
	let waiter = null; // {resolve, reject, lines, timer}
	let chain = Promise.resolve();
	const settings = {
		host: options.host || "127.0.0.1",
		port: Number(options.telnetPort) || DEFAULT_PORT,
		openocd: options.openocd || "openocd"
	};

	const exclusive = (fn) => {
		const job = chain.then(fn);
		chain = job.catch(() => null);
		return job;
	};

	const killProc = () => {
		if (proc) {
			proc.kill("SIGKILL");
			proc = null;
		}
		if (sock) {
			sock.destroy();
			sock = null;
		}
	};

	// one telnet command: send the line, collect output until the prompt
	const cmd = (command, timeoutMs) => {
		if (!sock) {
			return Promise.reject(new Error("openocd not connected"));
		}
		return new Promise((resolve, reject) => {
			waiter = {
				resolve: resolve,
				reject: reject,
				lines: [],
				command: command,
				timer: setTimeout(() => {
					waiter = null;
					reject(new Error("timeout waiting for openocd prompt after: " + command));
				}, timeoutMs || CMD_TIMEOUT_MS)
			};
			io.log(command, "tx");
			sock.write(command + "\n");
		});
	};

	const onData = (data) => {
		pending += data.toString("latin1");
		let i;
		while (waiter && (i = pending.indexOf("> ")) !== -1) {
			const chunk = pending.slice(0, i);
			pending = pending.slice(i + 2);
			const w = waiter;
			waiter = null;
			clearTimeout(w.timer);
			// drop the echoed command line and the prompt's own echo
			const lines = chunk.split(/\r?\n/).filter((l) => l.trim() && !/^>/.test(l));
			const echoed = lines.findIndex((l) => l.trim() === w.command);
			const out = (echoed === -1 ? lines : lines.slice(echoed + 1)).join("\n");
			io.log(out.slice(0, 500) || "(ok)", "rx");
			w.resolve(out);
		}
		if (!waiter && pending.length > 65536) {
			pending = pending.slice(-4096);
		}
	};

	const connectSock = () => {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("openocd telnet did not come up")), START_TIMEOUT_MS);
			const attempt = () => {
				if (stopped) {
					clearTimeout(timer);
					reject(new Error("stopped"));
					return;
				}
				const s = net.createConnection({ host: settings.host, port: settings.port }, () => {
					clearTimeout(timer);
					sock = s;
					pending = "";
					s.on("data", onData);
					s.on("error", (err) => {
						if (waiter) {
							const w = waiter;
							waiter = null;
							clearTimeout(w.timer);
							w.reject(err);
						}
						io.log("telnet error: " + err.message, "warn");
					});
					s.on("close", () => {
						sock = null;
						io.log("telnet closed", "warn");
					});
					// consume the banner up to the first prompt
					waiter = {
						resolve: () => resolve(),
						reject: reject,
						lines: [],
						command: "",
						timer: setTimeout(() => reject(new Error("banner timeout")), START_TIMEOUT_MS)
					};
				});
				s.on("error", () => {
					s.destroy();
					setTimeout(attempt, 250);
				});
			};
			attempt();
		});
	};

	const start = () => {
		stopped = false;
		const args = ["-c", "telnet_port " + settings.port].concat(options.args || []);
		io.log("openocd " + args.join(" "), "info");
		proc = spawn(settings.openocd, args);
		proc.stdout.on("data", (d) => io.log(d.toString().trim().slice(0, 500), "info"));
		proc.stderr.on("data", (d) => io.log(d.toString().trim().slice(0, 500), "warn"));
		proc.on("exit", (code) => {
			proc = null;
			io.log("openocd exited (" + code + ")", code === 0 ? "info" : "warn");
		});
		return connectSock().then(() => {
			io.status("running", "telnet " + settings.host + ":" + settings.port);
		});
	};

	const stop = () => {
		stopped = true;
		killProc();
		return Promise.resolve();
	};

	const commands = {
		cmd: (args) => exclusive(() => cmd(String(args.command))),

		halt: () => exclusive(() => cmd("halt")),
		resume: () => exclusive(() => cmd("resume")),
		reset: (args) => exclusive(() => cmd("reset " + (args.mode || "halt"))),
		targets: () => exclusive(() => cmd("targets")),

		regs: () => exclusive(() => {
			return cmd("reg").then((out) => {
				const regs = {};
				out.split(/\r?\n/).forEach((line) => {
					const m = /^\s*([a-zA-Z][\w]*)\s*=\s*(0x[0-9a-fA-F]+|\d+)/.exec(line);
					if (m) {
						regs[m[1]] = parseInt(m[2], m[2].toLowerCase().startsWith("0x") ? 16 : 10);
					}
				});
				return regs;
			});
		}),

		reg: (args) => exclusive(() => {
			if (args.value === undefined) {
				return cmd("reg " + args.name).then((out) => {
					const m = /=\s*(0x[0-9a-fA-F]+|\d+)/.exec(out);
					if (!m) {
						throw new Error("unexpected reg reply: " + out);
					}
					return { name: args.name, value: parseInt(m[1], m[1].toLowerCase().startsWith("0x") ? 16 : 10) };
				});
			}
			return cmd("reg " + args.name + " " + args.value).then(() => {
				return { name: args.name, value: args.value };
			});
		}),

		read: (args) => exclusive(() => {
			const width = Number(args.width) || 32;
			if ([8, 16, 32].indexOf(width) === -1) {
				throw new Error("width must be 8|16|32");
			}
			const count = Number(args.count) || 16;
			const op = { 8: "mdb", 16: "mdh", 32: "mdw" }[width];
			// md* count is in WORDS of the given width (8 per line of output)
			const words = Math.min(4096 / (width / 8), Math.ceil(count / (width / 8)));
			return cmd(op + " " + args.address + " " + words).then((out) => {
				const data = parseDump(out, width / 8);
				const buf = data.slice(0, count);
				const name = args.name || "mem";
				io.blob(name, buf);
				return { blob: io.id + "_" + name, bytes: buf.length, hex: buf.toString("hex") };
			});
		}),

		write: (args) => exclusive(() => {
			const width = Number(args.width) || 32;
			const data = parseHex(args.hex);
			if (data.length % (width / 8) !== 0) {
				throw new Error("hex length must be a multiple of " + width / 8 + " bytes");
			}
			const op = { 8: "mwb", 16: "mwh", 32: "mww" }[width];
			const chunks = [];
			for (let i = 0; i < data.length; i += 64) {
				chunks.push(data.slice(i, i + 64));
			}
			return chunks.reduce((p, chunk, n) => {
				return p.then(() => {
					const words = [];
					for (let i = 0; i + width / 8 <= chunk.length; i += width / 8) {
						words.push("0x" + chunk.slice(i, i + width / 8).toString("hex"));
					}
					const addr = Number(args.address) + n * 64;
					return cmd(op + " " + addr + " " + words.join(" "));
				});
			}, Promise.resolve()).then(() => ({ ok: true, bytes: data.length }));
		}),

		erase: (args) => exclusive(() => {
			return cmd("flash erase_address " + args.address + " " + args.length);
		}),

		// program a lab blob or file at an address (OpenOCD `program`);
		// imageFrom gives bytes, openocd needs a path
		program: (args) => exclusive(() => {
			return Promise.resolve(tool.imageFrom(args, io)).then((img) => {
				return tool.withTempDir((dir) => {
					const file = path.join(dir, "image.bin");
					fs.writeFileSync(file, img);
					return cmd("program " + file + " " + (args.address || "0") + " verify").then((out) => {
						return { ok: /Programming finished/i.test(out) || !/Error/i.test(out), out: out.slice(0, 1000) };
					});
				});
			});
		}),

		shutdown: () => exclusive(() => cmd("shutdown").then(() => ({ ok: true })))
	};

	return {
		start: start,
		stop: stop,
		command: (name, args) => {
			if (!commands[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		}
	};
};

module.exports = {
	name: "openocd",
	description: "OpenOCD daemon driven over its telnet port: targets, halt/resume/reset, register read/write, memory dumps -> blobs, writes, flash erase/program (lab blobs via `program`). Spawns openocd with free-form args (adapter/interface/target configs, e.g. Tigard port B)",
	options: {
		args: "extra openocd args, e.g. [\"-c\", \"adapter driver ftdi\", \"-f\", \"interface/tigard.cfg\"]",
		telnetPort: "telnet port (default 4444)",
		host: "telnet host (default 127.0.0.1)",
		openocd: "binary (default openocd)"
	},
	commands: {
		cmd: "{command} raw telnet command, returns the text output",
		halt: "{} halt target", resume: "{} resume target",
		reset: "{mode?: halt|run|init|none} reset target",
		targets: "{} list targets",
		regs: "{} all registers as {name: value}",
		reg: "{name, value?} read or write one register",
		read: "{address, count?, width?: 8|16|32, name?} memory -> blob + hex",
		write: "{address, hex, width?: 8|16|32} write memory",
		erase: "{address, length} flash erase_address",
		program: "{blob|file|data, address?} flash program with verify",
		shutdown: "{} quit openocd"
	},
	create: create,
	_test: { parseDump: parseDump, parseHex: parseHex }
};
