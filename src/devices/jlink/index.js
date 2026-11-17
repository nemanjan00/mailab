// SEGGER J-Link over the interactive JLinkExe CLI: spawned as a child
// process, driven through its "J-Link>" prompt. connect/halt/resume/reset,
// memory read -> blobs, writes, flash download, RTT into the log.
// Hardware-untested: written against the JLinkExe command set [HW].

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const tool = require("../../utils/tool");

const PROMPT = "J-Link>";

const create = (options, io) => {
	const settings = {
		exe: options.exe || "JLinkExe",
		device: options.device || "",
		iface: options.interface || "SWD",
		speed: Number(options.speed) || 4000,
		args: options.args || []
	};
	let child = null;
	let buf = "";
	let waiter = null; // {resolve, reject, timer}
	let chain = Promise.resolve();
	const exclusive = (fn) => {
		const job = chain.then(fn);
		chain = job.catch(() => null);
		return job;
	};

	// every line of J-Link output is console traffic
	const onLine = (line) => {
		const clean = line.trim();
		if (!clean) {
			return;
		}
		io.log(clean, clean.indexOf("error") !== -1 || clean.indexOf("ERROR") !== -1 ? "error" : "rx");
	};

	const onData = (data) => {
		buf += data.toString("latin1");
		let i;
		while ((i = buf.indexOf(PROMPT)) !== -1) {
			const chunk = buf.slice(0, i);
			buf = buf.slice(i + PROMPT.length);
			chunk.split(/\r?\n/).forEach(onLine);
			if (waiter) {
				const w = waiter;
				waiter = null;
				clearTimeout(w.timer);
				w.resolve(chunk);
			}
		}
		// line-buffer output while no command is running (RTT, info)
		const nl = buf.lastIndexOf("\n");
		if (nl !== -1 && !waiter) {
			buf.slice(0, nl).split(/\r?\n/).forEach(onLine);
			buf = buf.slice(nl + 1);
		}
	};

	const start = () => {
		const args = ["-Device", settings.device, "-If", settings.iface, "-Speed", String(settings.speed), "-NoGui", "1"]
			.concat(settings.args);
		child = spawn(settings.exe, args, { stdio: ["pipe", "pipe", "pipe"] });
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (err) => {
			io.status("error", err.message);
			if (waiter) {
				const w = waiter;
				waiter = null;
				clearTimeout(w.timer);
				w.reject(err);
			}
		});
		child.on("exit", (code) => {
			io.status("error", "JLinkExe exited " + code);
			if (waiter) {
				const w = waiter;
				waiter = null;
				clearTimeout(w.timer);
				w.reject(new Error("JLinkExe exited " + code));
			}
		});
		io.status("running", settings.exe + " " + settings.iface + " " + settings.speed + " kHz");
		// don't resolve until the CLI shows its first prompt: commands sent
		// before that would have their waiter resolved by the banner chunk
		// instead of the command's own response
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				waiter = null;
				reject(new Error("JLinkExe startup timeout (no prompt)"));
			}, 20000);
			waiter = {
				resolve: () => {
					clearTimeout(timer);
					resolve({ ok: true });
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
				timer: timer
			};
		});
	};

	const stop = () => {
		if (!child) {
			return Promise.resolve();
		}
		try {
			child.stdin.write("exit\n");
		} catch (_e) { /* already gone */ }
		child.kill();
		child = null;
		return Promise.resolve();
	};

	// one command at a time: the CLI answers at its next prompt
	const cmd = (command, timeoutMs) => {
		return exclusive(() => {
			return new Promise((resolve, reject) => {
				if (!child) {
					reject(new Error("JLinkExe not running"));
					return;
				}
				waiter = {
					resolve: resolve,
					reject: reject,
					timer: setTimeout(() => {
						waiter = null;
						reject(new Error("timeout waiting for J-Link> after: " + command));
					}, timeoutMs || 15000)
				};
				io.log(command, "tx");
				child.stdin.write(command + "\n");
			});
		});
	};

	const okOrThrow = (out, what) => {
		if (/error|failed/i.test(out)) {
			throw new Error(what + " failed: " + out.trim().split(/\r?\n/).pop());
		}
		return out;
	};

	// mem output: "01000000 = 20000400 20000800 ..." lines
	const parseMem = (out) => {
		const bytes = [];
		out.split(/\r?\n/).forEach((line) => {
			const m = /^\s*[0-9a-f]{8}\s*=\s*(.*)$/i.exec(line.trim());
			if (m) {
				m[1].trim().split(/\s+/).forEach((word) => {
					for (let i = word.length - 2; i >= 0; i -= 2) {
						bytes.push(parseInt(word.slice(i, i + 2), 16));
					}
				});
			}
		});
		return Buffer.from(bytes);
	};

	const commands = {
		connect: () => {
			return cmd("connect", 30000).then((out) => {
				return { ok: !/failed|error/i.test(out) };
			});
		},
		halt: () => cmd("halt").then((out) => okOrThrow(out, "halt")).then(() => ({ ok: true })),
		resume: () => cmd("go").then((out) => okOrThrow(out, "go")).then(() => ({ ok: true })),
		reset: () => cmd("r").then((out) => okOrThrow(out, "reset")).then(() => ({ ok: true })),

		read: (args) => {
			const addr = Number(args.address);
			const count = Number(args.count) || 16;
			const width = args.width === 8 ? 8 : 32;
			const per = width === 8 ? 1 : 4;
			const reads = [];
			for (let off = 0; off < count; off += 256 * per) {
				const n = Math.min(256, Math.ceil((count - off) / per));
				reads.push([addr + off, n]);
			}
			return reads.reduce((p, pair) => {
				return p.then((chunks) => {
					const c = width === 8 ? "mem8" : "mem32";
					return cmd(c + " 0x" + pair[0].toString(16) + " " + pair[1], 30000).then((out) => {
						okOrThrow(out, "read");
						return chunks.concat([parseMem(out).slice(0, Math.min(count - chunks.reduce((a, b) => a + b.length, 0), pair[1] * per))]);
					});
				});
			}, Promise.resolve([])).then((chunks) => {
				const data = Buffer.concat(chunks).slice(0, count);
				const name = args.name || "mem";
				io.blob(name, data);
				return { blob: io.id + "_" + name, bytes: data.length, hex: data.toString("hex") };
			});
		},

		write: (args) => {
			const clean = String(args.hex).replace(/0x/gi, "").replace(/[\s,:]/g, "");
			if (!/^([0-9a-f]{2})*$/i.test(clean) || !clean.length) {
				throw new Error("hex must be pairs of hex digits");
			}
			const addr = Number(args.address);
			// w4 words are 32-bit values: byte-reverse each group so the hex
			// (lowest address first) round-trips with mem32 reads
			const words = [];
			for (let i = 0; i + 8 <= clean.length; i += 8) {
				words.push(clean.slice(i, i + 8).match(/../g).reverse().join(""));
			}
			const tail = clean.length % 8;
			if (tail) {
				words.push(clean.slice(clean.length - tail).match(/../g).reverse().join("").padStart(8, "0"));
			}
			return cmd("w4 0x" + addr.toString(16) + " 0x" + words.join(" 0x"), 30000).then((out) => {
				okOrThrow(out, "write");
				return { ok: true, bytes: clean.length / 2 };
			});
		},

		// flash download: imageFrom resolves the blob, JLinkExe loads a file
		program: (args) => {
			return Promise.resolve(tool.imageFrom(args, io)).then((data) => {
				return tool.withTempDir((dir) => {
					const file = path.join(dir, "image.bin");
					fs.writeFileSync(file, data);
					const addr = args.address !== undefined ? " 0x" + Number(args.address).toString(16) : "";
					return cmd("loadfile " + file + addr, 120000).then((out) => {
						okOrThrow(out, "loadfile");
						return { ok: true, bytes: data.length };
					});
				});
			});
		},

		regs: () => {
			return cmd("regs").then((out) => {
				const regs = {};
				out.split(/\r?\n/).forEach((line) => {
					const m = /(R\d+|SP|LR|PC|xPSR)\s*=\s*(?:0x)?([0-9a-f]+)/i.exec(line);
					if (m) {
						regs[m[1].toUpperCase()] = parseInt(m[2], 16);
					}
				});
				return { regs: regs };
			});
		},

		// RTT: start the buffer viewer, lines land in the device log
		rtt: (args) => {
			if (args && args.on === false) {
				return cmd("rtt stop", 10000).then(() => ({ rtt: false }));
			}
			return cmd("rtt start", 10000).then((out) => {
				okOrThrow(out, "rtt start");
				return cmd("rtt server start " + (Number(args && args.port) || 19021), 10000).then(() => ({ rtt: true }));
			});
		},

		status: () => ({ running: Boolean(child), settings: settings })
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
	name: "jlink",
	description: "SEGGER J-Link probe via the interactive JLinkExe CLI: connect/halt/resume/reset, memory read -> blobs, writes, flash download, registers, RTT into the log",
	options: {
		exe: "JLinkExe binary (default from PATH)",
		device: "target device name, e.g. STM32F405RG",
		interface: "SWD (default) | JTAG",
		speed: "interface speed in kHz (default 4000)",
		args: "extra JLinkExe arguments"
	},
	commands: {
		connect: "{} connect to the target",
		halt: "{}", resume: "{}", reset: "{}",
		read: "{address, count?, width?: 8|32, name?} memory -> blob + hex",
		write: "{address, hex} write 32-bit words",
		program: "{blob|file|data, address?} flash download (imageFrom)",
		regs: "{} CPU registers",
		rtt: "{on?, port?} SEGGER RTT into the device log",
		status: "{} process state, settings"
	},
	create: create
};
