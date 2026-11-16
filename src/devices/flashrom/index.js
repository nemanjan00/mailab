// SPI/parallel flash chips via flashrom (CH341A, FT2232, Bus Pirate,
// linux_spi, ...). `read` lands the image in lab blob <id>_<name> (blob
// analysis, kaitai, diff); `verify`/`write` take a lab blob, file or base64.
// write and erase need a person's approval (safety DEFAULT_POLICY).
// Tested against flashrom's dummy programmer (dummy:emulate=W25Q128FV),
// not yet against a real programmer.

const fs = require("fs");
const path = require("path");
const tool = require("../../utils/tool");
const serialize = require("../../utils/mutex").serialize;
const parse = require("./parse");

const DEFAULTS = { path: "flashrom", timeoutMs: 10 * 60 * 1000 };
const PROGRAMMER_RE = /^[a-z0-9_]+(:[A-Za-z0-9_=,./:-]*)?$/;

/**
 * "ch341a_spi", "linux_spi:dev=/dev/spidev0.0,spispeed=4000", "dummy:emulate=W25Q128FV"
 */
const checkProgrammer = (value) => {
	const s = String(value === undefined || value === null ? "" : value);
	if (!PROGRAMMER_RE.test(s)) {
		throw new Error("programmer " + JSON.stringify(value) + " is not valid (e.g. ch341a_spi, linux_spi:dev=/dev/spidev0.0)");
	}
	return s;
};

/**
 * Base arguments: -p <programmer> [-c <chip>].
 * @param {{programmer: string, chip: string}} s
 */
const baseArgs = (s) => {
	const args = ["-p", checkProgrammer(s.programmer)];
	if (s.chip) {
		args.push("-c", tool.checkName(s.chip, "chip"));
	}
	return args;
};

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	let lastProbe = null;

	const exec = (args) => {
		io.log("flashrom " + args.join(" "), "tx");
		return tool.run(settings.path, args, { timeoutMs: settings.timeoutMs }).then((res) => {
			res.output.split("\n").filter((l) => l.trim()).slice(-40).forEach((line) => {
				io.log(line, "rx");
			});
			return res;
		});
	};

	// a result with the parsed detection, failing on a non-zero exit
	const checked = (res, what) => {
		const det = parse.detection(res.output);
		if (res.code !== 0) {
			const hint = parse.failureHint(res.output, det);
			throw new Error("flashrom " + what + " failed (exit " + res.code + ")" + (hint ? ": " + hint : ""));
		}
		return det;
	};

	const opts = (a) => Object.assign({}, settings, a.chip ? { chip: a.chip } : {});

	const probe = (a) => {
		return exec(baseArgs(opts(a))).then((res) => {
			const det = parse.detection(res.output);
			lastProbe = det;
			return Object.assign({ exit: res.code }, det);
		});
	};

	const read = (a) => {
		const name = a.name || "flash";
		return tool.withTempDir((dir) => {
			const file = path.join(dir, "image.bin");
			return exec(baseArgs(opts(a)).concat(["-r", file])).then((res) => {
				const det = checked(res, "read");
				const data = fs.readFileSync(file);
				io.blob(name, data);
				return { blob: io.id + "_" + name, bytes: data.length, sha256: tool.sha256(data), chips: det.chips };
			});
		});
	};

	// write/verify an image through a temp file
	const withImage = (a, flag, what) => {
		const data = tool.imageFrom(a, io);
		return tool.withTempDir((dir) => {
			const file = path.join(dir, "image.bin");
			fs.writeFileSync(file, data);
			const extra = [];
			if (flag === "-w" && a.noverify === true) {
				extra.push("-n");
			}
			return exec(baseArgs(opts(a)).concat([flag, file], extra)).then((res) => {
				const det = checked(res, what);
				return { ok: true, bytes: data.length, sha256: tool.sha256(data), verified: parse.verified(res.output), chips: det.chips };
			});
		});
	};

	const erase = (a) => {
		return exec(baseArgs(opts(a)).concat(["-E"])).then((res) => {
			const det = checked(res, "erase");
			return { ok: true, chips: det.chips };
		});
	};

	const handlers = {
		probe: probe,
		read: read,
		verify: (a) => withImage(a, "-v", "verify"),
		write: (a) => withImage(a, "-w", "write"),
		erase: erase,
		status: () => Promise.resolve({ programmer: settings.programmer, chip: settings.chip || null, lastProbe: lastProbe })
	};

	// one flashrom at a time: two on the same programmer would fight
	const runCommand = serialize((name, args) => {
		return handlers[name](args);
	});

	return {
		start: () => {
			return Promise.resolve().then(() => {
				checkProgrammer(settings.programmer);
				if (settings.chip) {
					tool.checkName(settings.chip, "chip");
				}
				return tool.run(settings.path, ["--version"], { timeoutMs: 10000 });
			}).then((res) => {
				io.log(res.output.split("\n")[0].trim());
				if (settings.probeOnStart) {
					return runCommand("probe", {}).then((det) => {
						io.log("probe: " + parse.summary(det));
					});
				}
				return null;
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
	name: "flashrom",
	description: "SPI/parallel flash chips via flashrom: probe, read (→ blob <id>_flash), verify, write, erase (write/erase need approval)",
	options: {
		programmer: "flashrom -p value, e.g. ch341a_spi, linux_spi:dev=/dev/spidev0.0,spispeed=4000, dummy:emulate=W25Q128FV (required)",
		chip: "flashrom -c chip name when several definitions match, e.g. \"MX25L6436E/MX25L6445E/MX25L6465E\"",
		path: "flashrom binary (default flashrom on PATH)",
		timeoutMs: "per-operation timeout (default 600000)",
		probeOnStart: "probe when the device starts (default false)"
	},
	commands: {
		probe: "{chip} detect the chip: [{vendor, name, sizeKb, bus}], multiple-match candidates",
		read: "{chip, name: \"flash\"} dump the chip into blob <id>_<name>; returns bytes, sha256",
		verify: "{blob | file | data (base64), chip} compare the chip with an image",
		write: "{blob | file | data (base64), chip, noverify} program the chip (erases as needed); needs approval",
		erase: "{chip} erase the whole chip; needs approval",
		status: "settings and last probe result"
	},
	create: create,
	_checkProgrammer: checkProgrammer,
	_baseArgs: baseArgs
};
