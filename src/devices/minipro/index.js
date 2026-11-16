// XGecu TL866A/CS, TL866II+, T48, T56, T76 universal programmers via minipro
// (EEPROM, flash, EPROM, MCUs, GALs). `read` lands the image in lab blob
// <id>_<name> (EEPROM / fuses alongside when the chip has them); `verify` /
// `write` take a lab blob, file or base64. write and erase need a person's
// approval (safety DEFAULT_POLICY).
// TODO: verify on hardware: only info/search/presence ran for real (no
// programmer attached); read_id/autodetect output parsing is from the sources.

const fs = require("fs");
const path = require("path");
const tool = require("../../utils/tool");
const serialize = require("../../utils/mutex").serialize;
const parse = require("./parse");

const DEFAULTS = { path: "minipro", programmer: "tl866ii", timeoutMs: 10 * 60 * 1000 };
const PROGRAMMERS = ["tl866a", "tl866ii", "t48", "t56", "t76"];
const PAGES = ["code", "data", "config", "user", "calibration"];

const checkProgrammer = (value) => {
	const s = String(value || "").toLowerCase();
	if (PROGRAMMERS.indexOf(s) === -1) {
		throw new Error("programmer must be one of " + PROGRAMMERS.join(", "));
	}
	return s;
};

/**
 * -p <chip> [-c <page>] for chip operations.
 * @param {{chip: string, page: string}} s
 */
const chipArgs = (s) => {
	if (!s.chip) {
		throw new Error("chip is required (minipro name, e.g. W25Q128JV@SOIC8; search finds it)");
	}
	const args = ["-p", tool.checkName(s.chip, "chip")];
	if (s.page) {
		if (PAGES.indexOf(s.page) === -1) {
			throw new Error("page must be one of " + PAGES.join(", "));
		}
		args.push("-c", s.page);
	}
	return args;
};

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);

	const exec = (args) => {
		io.log("minipro " + args.join(" "), "tx");
		return tool.run(settings.path, args, { timeoutMs: settings.timeoutMs }).then((res) => {
			res.output.split("\n").filter((l) => l.trim()).slice(-40).forEach((line) => {
				io.log(line, "rx");
			});
			return res;
		});
	};

	const checked = (res, what) => {
		if (res.code !== 0) {
			throw new Error("minipro " + what + " failed (exit " + res.code + "): " + parse.failureHint(res.output));
		}
		return res;
	};

	const opts = (a) => Object.assign({}, settings, a);

	const read = (a) => {
		const name = a.name || "rom";
		return tool.withTempDir((dir) => {
			const file = path.join(dir, "image.bin");
			return exec(chipArgs(opts(a)).concat(["-r", file])).then((res) => {
				checked(res, "read");
				// without a page, minipro also writes <file>.eeprom.bin / <file>.fuses.conf
				const result = { blobs: [] };
				fs.readdirSync(dir).sort().forEach((f) => {
					const full = path.join(dir, f);
					if (/fuses|\.conf$/.test(f)) {
						const text = fs.readFileSync(full, "utf8");
						io.value(name + "_fuses", text);
						result.fuses = text;
						return;
					}
					let blobName = name;
					if (/eeprom/i.test(f)) {
						blobName = name + "_eeprom";
					}
					const data = fs.readFileSync(full);
					io.blob(blobName, data);
					result.blobs.push({ blob: io.id + "_" + blobName, bytes: data.length, sha256: tool.sha256(data) });
				});
				return result;
			});
		});
	};

	const withImage = (a, flag, what) => {
		const data = tool.imageFrom(a, io);
		return tool.withTempDir((dir) => {
			const file = path.join(dir, "image.bin");
			fs.writeFileSync(file, data);
			const extra = [];
			if (flag === "-w" && a.unprotect === true) {
				extra.push("-u");
			}
			if (flag === "-w" && a.skipVerify === true) {
				extra.push("-v");
			}
			return exec(chipArgs(opts(a)).concat([flag, file], extra)).then((res) => {
				checked(res, what);
				return { ok: true, bytes: data.length, sha256: tool.sha256(data), output: res.output.trim().split("\n").slice(-5) };
			});
		});
	};

	const handlers = {
		presence: () => {
			return exec(["-k"]).then((res) => Object.assign(parse.presence(res.output), { output: res.output.trim() }));
		},
		info: (a) => {
			const chip = tool.checkName(a.chip || settings.chip, "chip");
			return exec(["-q", checkProgrammer(a.programmer || settings.programmer), "-d", chip]).then((res) => parse.info(res.output));
		},
		search: (a) => {
			const text = tool.checkName(a.text, "search text");
			return exec(["-q", checkProgrammer(a.programmer || settings.programmer), "-L", text]).then((res) => {
				const names = parse.search(res.output);
				return { count: names.length, names: names.slice(0, a.limit || 200) };
			});
		},
		read_id: (a) => {
			return exec(chipArgs(opts(a)).concat(["-D"])).then((res) => {
				return Object.assign({ exit: res.code }, parse.chipId(res.output), { output: res.output.trim().split("\n").slice(-5) });
			});
		},
		autodetect: (a) => {
			const bits = String(a.bits || 8);
			if (bits !== "8" && bits !== "16") {
				throw new Error("bits must be 8 or 16");
			}
			return exec(["-a", bits]).then((res) => {
				return Object.assign({ exit: res.code }, parse.chipId(res.output), { output: res.output.trim().split("\n").slice(-10) });
			});
		},
		read: read,
		verify: (a) => withImage(a, "-m", "verify"),
		write: (a) => withImage(a, "-w", "write"),
		erase: (a) => {
			return exec(chipArgs(opts(a)).concat(["-E"])).then((res) => {
				checked(res, "erase");
				return { ok: true };
			});
		},
		blank_check: (a) => {
			return exec(chipArgs(opts(a)).concat(["-b"])).then((res) => {
				return { blank: res.code === 0 && !/not blank|failed/i.test(res.output), output: res.output.trim().split("\n").slice(-5) };
			});
		},
		pin_check: (a) => {
			return exec(chipArgs(opts(a)).concat(["-z"])).then((res) => {
				return { ok: res.code === 0, output: res.output.trim().split("\n").slice(-20) };
			});
		}
	};

	// one minipro at a time: the programmer is a single USB device
	const runCommand = serialize((name, args) => {
		return Promise.resolve().then(() => handlers[name](args));
	});

	return {
		start: () => {
			return Promise.resolve().then(() => {
				checkProgrammer(settings.programmer);
				if (settings.chip) {
					tool.checkName(settings.chip, "chip");
				}
				return runCommand("presence", {});
			}).then((p) => {
				let text = "no programmer connected";
				if (p.connected) {
					text = "programmer: " + p.model;
				}
				io.log(text);
			});
		},

		stop: () => {
			return Promise.resolve();
		},

		command: (name, args) => {
			if (!handlers[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return runCommand(name, args || {});
		}
	};
};

module.exports = {
	name: "minipro",
	description: "XGecu TL866/T48/T56/T76 programmers via minipro: presence, info, search, read_id, read (→ blob <id>_rom), verify, write, erase (write/erase need approval)",
	options: {
		chip: "default chip name, e.g. W25Q128JV@SOIC8 or AT28C256 (search lists names)",
		programmer: "database for info/search without hardware: tl866a, tl866ii (default), t48, t56, t76",
		path: "minipro binary (default minipro on PATH)",
		timeoutMs: "per-operation timeout (default 600000)"
	},
	commands: {
		presence: "which programmer is connected (minipro -k)",
		info: "{chip, programmer} chip info: memory size, package, protocol (no hardware needed)",
		search: "{text, programmer, limit} chip names containing text (no hardware needed)",
		read_id: "{chip} read the chip ID and compare it with the expected one",
		autodetect: "{bits: 8|16} detect a 25xx SPI flash in the socket",
		read: "{chip, page, name: \"rom\"} dump into blob <id>_<name> (+ <id>_<name>_eeprom, value <id>_<name>_fuses)",
		verify: "{blob | file | data (base64), chip, page} compare the chip with an image",
		write: "{blob | file | data (base64), chip, page, unprotect, skipVerify} program the chip; needs approval",
		erase: "{chip} erase the chip; needs approval",
		blank_check: "{chip, page} is the chip blank",
		pin_check: "{chip} check socket pin contact"
	},
	create: create,
	_chipArgs: chipArgs
};
