// Othernet Morfeus / moRFeus RF signal generator driver (Node-side).
//
// Request: a 2-channel 23.5 MHz-6 GHz siggen with two MAX2871 PLLs, "USB-serial
// controlled". RESEARCH OUTCOME (what the sources actually say):
//
//   * The shipping Othernet *moRFeus* is a SINGLE-channel 30 MHz-6 GHz
//     frequency-converter / signal-generator with ONE MAX2871, and it is a USB
//     *HID* device (VID 0x10C4 / PID 0xEAC9), NOT an ASCII CDC serial port.
//     No public source documents a 2-channel / two-MAX2871 / ASCII-serial
//     Morfeus, so that framing is treated as UNVERIFIED and NOT invented here.
//
//   * The HID register protocol below is VERIFIED - it is identical in two
//     independent community tools:
//       - tai/morfeus        morfeus/device.py   (https://github.com/tai/morfeus)
//       - Psynosaur/moRFeusQt moRFeusQt/mrf.py   (https://github.com/Psynosaur/moRFeusQt)
//       both citing the Othernet forum thread:
//       https://forums.othernet.is/t/rf-product-morfeus-frequency-converter-and-signal-generator/5025
//
//   Verified register map (16-byte reports, big-endian 8-byte values):
//     mode byte : 0x72 = GET (read),   0x77 = SET (write)      [verified]
//     reg 0x81  : frequency, Hz                                [verified]
//     reg 0x82  : function, 0 = MIXER, 1 = GENERATOR           [verified]
//     reg 0x83  : "current" / output level, 0..7               [verified, both tools]
//     reg 0x84  : bias-tee enable, 0/1                         [verified]
//
//   UNVERIFIED pieces, flagged in docstrings and the HW note:
//     - second channel: no documented protocol. A real 2-channel unit would
//       expose a SECOND HID node; this driver talks the identical verified
//       protocol to options.path1. No register offset is fabricated.
//     - "output on/off": the moRFeus has no hard RF-kill register. "on" selects
//       GENERATOR (reg 0x82=1) + applies the level; "off" selects MIXER
//       (0x82=0) and level 0 - the quietest documented state. Whether that
//       fully mutes the port is UNVERIFIED.
//     - "sweep" is NOT a firmware feature; moRFeusQt sweeps by host-driven
//       re-tuning. This driver does the same (set-freq + dwell per step).
//     - hidraw response byte offset (value at bytes [2:10]) follows tai/morfeus;
//       moRFeusQt reads [3:11]. HARDWARE-UNTESTED here either way.
//
// SAFETY: this is a transmitter. Enabling output and sweeping are approval-gated
// (src/safety DEFAULT_POLICY, driver "morfeus"), and the channel frequency must
// sit inside the lab's allowed RF bands (region from MAILAB_RF_REGION, bypass
// via MAILAB_RF_CHAMBER / MAILAB_UNSAFE) unless chamber/bypass mode is on. The
// band policy is the lab's, read from config here - never a device option.

const config = require("../../config");
const rfbands = require("../../utils/rfbands");
const hidraw = require("./transport");
const serialize = require("../../utils/mutex").serialize;
const parseSwitch = require("../../utils/args").parseSwitch;
const parseNumber = require("../../utils/args").parseNumber;

// verified protocol constants (tai/morfeus, moRFeusQt)
const REPORT_ID = 0x00;
const CMD_GET = 0x72;
const CMD_SET = 0x77;
const REG = { freq: 0x81, func: 0x82, current: 0x83, bias: 0x84 };
const FUNC = { mixer: 0, generator: 1 };
const REPORT_LEN = 17; // REPORT_ID + 16-byte payload
const VALUE_OFFSET = 2; // response value is 8 big-endian bytes at [2:10] (tai/morfeus)

// device capability limits (Crowd Supply Othernet Morfeus spec, request)
const FREQ_MIN_HZ = 23500000;
const FREQ_MAX_HZ = 6000000000;
// "current" / output level is a 0..7 field (verified in both community tools)
const LEVEL_MIN = 0;
const LEVEL_MAX = 7;

const READ_TIMEOUT_MS = 1000;
const MAX_SWEEP_STEPS = 10000;

/**
 * Build a 17-byte HID report: REPORT_ID, mode, register, 8-byte big-endian
 * value, then zero padding to REPORT_LEN.
 * @param {number} mode CMD_GET or CMD_SET
 * @param {number} reg register byte
 * @param {number} value 0..2^53 (fits frequency and small fields)
 * @returns {Buffer}
 */
const buildReport = (mode, reg, value) => {
	const buffer = Buffer.alloc(REPORT_LEN);
	buffer[0] = REPORT_ID;
	buffer[1] = mode;
	buffer[2] = reg;
	buffer.writeBigUInt64BE(BigInt(Math.round(value || 0)), 3);
	return buffer;
};

/**
 * Parse the 8-byte big-endian value out of a response report.
 * @param {Buffer} response
 * @returns {number}
 */
const parseValue = (response) => {
	if (!response || response.length < VALUE_OFFSET + 8) {
		throw new Error("short Morfeus response: " + (response ? response.length : 0) + " bytes");
	}
	return Number(response.readBigUInt64BE(VALUE_OFFSET));
};

/**
 * Normalise a channel argument to a 0-based index. Accepts 0/1, "0"/"1",
 * "A"/"B" (A=0, B=1), case-insensitive.
 * @param {*} value
 * @param {number} count number of configured channels
 * @returns {number}
 */
const parseChannel = (value, count) => {
	let index = null;
	if (typeof value === "number" && Number.isInteger(value)) {
		index = value;
	} else if (typeof value === "string") {
		const key = value.trim().toLowerCase();
		if (key === "a") {
			index = 0;
		} else if (key === "b") {
			index = 1;
		} else if (/^\d+$/.test(key)) {
			index = Number(key);
		}
	}
	if (index === null) {
		throw new Error("channel must be 0/1 or A/B, got " + JSON.stringify(value));
	}
	if (index < 0 || index >= count) {
		throw new Error("channel " + index + " out of range (this device has " + count + " channel" + (count === 1 ? "" : "s") + ")");
	}
	return index;
};

const create = (options, io) => {
	// injected fake transport for tests; real hidraw otherwise
	const openTransport = (typeof options._openTransport === "function") ? options._openTransport : hidraw.open;
	const paths = [options.path, options.path1].filter((p) => p !== undefined && p !== null && p !== "");
	if (!paths.length) {
		throw new Error("morfeus needs a `path` (hidraw node, e.g. /dev/hidraw0)");
	}

	const defaultLevel = (options.level === undefined) ? LEVEL_MIN
		: parseNumber(options.level, "level", { min: LEVEL_MIN, max: LEVEL_MAX });

	// per-channel runtime state (device is single-channel in reality; a second
	// channel, when configured, is a second HID node talking the same protocol)
	const channels = paths.map((path, index) => {
		return {
			index: index,
			path: path,
			transport: null,
			lock: serialize(),
			state: {
				freq: (options.freq === undefined) ? null : parseNumber(options.freq, "freq", { min: FREQ_MIN_HZ, max: FREQ_MAX_HZ }),
				level: defaultLevel,
				on: false
			}
		};
	});

	const channel = (args) => {
		return channels[parseChannel((args || {}).channel === undefined ? 0 : args.channel, channels.length)];
	};

	// --- transport helpers (serialized per channel) -----------------------

	const writeReg = (ch, reg, value) => {
		return ch.lock(() => {
			ch.transport.write(buildReport(CMD_SET, reg, value));
			// drain the device's ack if any; a SET need not be acknowledged, so
			// a read timeout here is not an error
			return ch.transport.read(REPORT_LEN - 1, READ_TIMEOUT_MS).then(() => null, () => null);
		});
	};

	const readReg = (ch, reg) => {
		return ch.lock(() => {
			ch.transport.write(buildReport(CMD_GET, reg));
			return ch.transport.read(REPORT_LEN - 1, READ_TIMEOUT_MS).then(parseValue);
		});
	};

	// --- safety ------------------------------------------------------------

	const rfEnv = () => rfbands.fromConfig(config);

	/**
	 * Refuse an on-air frequency that is out of band (unless chamber/bypass).
	 * @param {number} hz
	 * @param {string} what phrase for the error ("enable output", "sweep step")
	 */
	const guardOnAir = (hz, what) => {
		const verdict = rfbands.check(hz, rfEnv());
		if (!verdict.ok) {
			throw new Error("refusing to " + what + ": " + verdict.reason);
		}
	};

	// --- reporting ---------------------------------------------------------

	const report = (ch) => {
		io.sample("ch" + ch.index + "_freq", ch.state.freq, { unit: "Hz" });
		io.sample("ch" + ch.index + "_level", ch.state.level);
		io.sample("ch" + ch.index + "_on", ch.state.on ? 1 : 0);
		io.value("ch" + ch.index + "_on", ch.state.on);
	};

	const channelInfo = (ch) => {
		return { channel: ch.index, path: ch.path, freq: ch.state.freq, level: ch.state.level, on: ch.state.on };
	};

	const publishStatus = () => {
		io.value("status", { channels: channels.map(channelInfo), rf: rfEnv() });
	};

	// --- commands ----------------------------------------------------------

	const setFreq = (args) => {
		const ch = channel(args);
		const hz = Math.round(parseNumber(args.hz, "hz", { min: FREQ_MIN_HZ, max: FREQ_MAX_HZ, unit: "Hz" }));
		// a live output must not be walked out of band
		if (ch.state.on) {
			guardOnAir(hz, "retune a live output");
		}
		return writeReg(ch, REG.freq, hz).then(() => {
			ch.state.freq = hz;
			report(ch);
			publishStatus();
			return { channel: ch.index, hz: hz };
		});
	};

	const setLevel = (args) => {
		const ch = channel(args);
		const level = Math.round(parseNumber(args.level, "level", { min: LEVEL_MIN, max: LEVEL_MAX }));
		return writeReg(ch, REG.current, level).then(() => {
			ch.state.level = level;
			report(ch);
			publishStatus();
			return { channel: ch.index, level: level };
		});
	};

	const output = (args) => {
		const ch = channel(args);
		const on = parseSwitch(args.on, "on");
		if (on) {
			if (ch.state.freq === null) {
				throw new Error("set a frequency on channel " + ch.index + " before enabling output");
			}
			guardOnAir(ch.state.freq, "enable output");
			// GENERATOR drives the port; re-apply the stored level so it actually outputs
			return writeReg(ch, REG.func, FUNC.generator)
				.then(() => writeReg(ch, REG.current, ch.state.level))
				.then(() => {
					ch.state.on = true;
					report(ch);
					publishStatus();
					return { channel: ch.index, on: true };
				});
		}
		// no hard RF-kill exists: fall back to MIXER + level 0 (quietest documented state)
		return writeReg(ch, REG.func, FUNC.mixer)
			.then(() => writeReg(ch, REG.current, LEVEL_MIN))
			.then(() => {
				ch.state.on = false;
				report(ch);
				publishStatus();
				return { channel: ch.index, on: false };
			});
	};

	/**
	 * Host-driven sweep (the firmware has no sweep command). Steps frequency
	 * from start to stop and dwells at each point; every point must be in band
	 * (unless chamber) or the whole sweep is refused before any RF. Output is
	 * enabled for the sweep and returned to off afterwards.
	 */
	const sweep = (args) => {
		const ch = channel(args);
		const start = Math.round(parseNumber(args.start, "start", { min: FREQ_MIN_HZ, max: FREQ_MAX_HZ, unit: "Hz" }));
		const stop = Math.round(parseNumber(args.stop, "stop", { min: FREQ_MIN_HZ, max: FREQ_MAX_HZ, unit: "Hz" }));
		if (stop < start) {
			throw new Error("sweep stop " + stop + " Hz is below start " + start + " Hz");
		}
		const dwellMs = (args.dwell_ms === undefined) ? 0 : parseNumber(args.dwell_ms, "dwell_ms", { min: 0 });

		let points = [];
		if (args.points !== undefined) {
			const count = Math.round(parseNumber(args.points, "points", { min: 1, max: MAX_SWEEP_STEPS }));
			const span = stop - start;
			points = Array.from({ length: count }, (_v, i) => {
				return Math.round(count === 1 ? start : start + (span * i) / (count - 1));
			});
		} else {
			const step = Math.round(parseNumber(args.step, "step", { min: 1 }));
			const count = Math.floor((stop - start) / step) + 1;
			if (count > MAX_SWEEP_STEPS) {
				throw new Error("sweep has " + count + " steps (max " + MAX_SWEEP_STEPS + "); use a larger step or `points`");
			}
			points = Array.from({ length: count }, (_v, i) => start + i * step);
		}

		// refuse the WHOLE sweep up front if any step is out of band
		points.forEach((hz) => {
			guardOnAir(hz, "sweep");
		});

		const dwell = () => new Promise((resolve) => {
			setTimeout(resolve, dwellMs);
		});

		return writeReg(ch, REG.func, FUNC.generator)
			.then(() => writeReg(ch, REG.current, ch.state.level))
			.then(() => {
				ch.state.on = true;
				report(ch);
				return points.reduce((chain, hz) => {
					return chain
						.then(() => writeReg(ch, REG.freq, hz))
						.then(() => {
							ch.state.freq = hz;
							io.sample("ch" + ch.index + "_freq", hz, { unit: "Hz" });
							return dwell();
						});
				}, Promise.resolve());
			})
			// leave the transmitter off after a sweep (safe default)
			.then(() => output({ channel: ch.index, on: false }))
			.then(() => {
				return { channel: ch.index, start: start, stop: stop, count: points.length, dwell_ms: dwellMs };
			});
	};

	const status = () => {
		return channels.reduce((chain, ch) => {
			return chain
				.then(() => readReg(ch, REG.freq))
				.then((hz) => {
					ch.state.freq = hz;
					return readReg(ch, REG.current);
				})
				.then((level) => {
					ch.state.level = level;
					report(ch);
				});
		}, Promise.resolve()).then(() => {
			publishStatus();
			return { channels: channels.map(channelInfo), rf: rfEnv() };
		});
	};

	const info = () => {
		return status().then((s) => {
			return Object.assign({
				driver: "morfeus",
				protocol: "USB HID register map (verified: tai/morfeus, moRFeusQt)",
				note: "no firmware-version register is documented for the moRFeus (unverified)"
			}, s);
		});
	};

	const commands = {
		info: info,
		version: info,
		status: status,
		set_freq: setFreq,
		set_level: setLevel,
		output: output,
		sweep: sweep
	};

	return {
		start: () => {
			channels.forEach((ch) => {
				ch.transport = openTransport(ch.path);
			});
			publishStatus();
			return Promise.resolve();
		},

		stop: () => {
			channels.forEach((ch) => {
				if (ch.transport && ch.transport.close) {
					ch.transport.close();
				}
				ch.transport = null;
			});
			return Promise.resolve();
		},

		command: (name, args) => {
			if (!commands[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			// keep thrown validation errors inside the promise chain
			return Promise.resolve().then(() => commands[name](args || {}));
		}
	};
};

module.exports = {
	name: "morfeus",
	description: "Othernet Morfeus / moRFeus RF signal generator (23.5 MHz-6 GHz, USB HID). "
		+ "Per-channel set_freq / set_level / output / sweep. Enabling output and sweeping need approval "
		+ "and must stay in the lab's RF bands (MAILAB_RF_REGION; MAILAB_RF_CHAMBER/MAILAB_UNSAFE bypass). "
		+ "Channels: <id>_ch<N>_freq, <id>_ch<N>_level, <id>_ch<N>_on",
	options: {
		path: "hidraw node for channel 0, e.g. /dev/hidraw0 (required)",
		path1: "hidraw node for channel 1 (optional; only if your unit exposes a second HID synthesizer - UNVERIFIED 2-channel support)",
		freq: "default frequency, Hz (23.5 MHz - 6 GHz)",
		level: "default output level, 0-7 (0 = lowest)"
	},
	commands: {
		info: "firmware/driver info + live per-channel freq/level/output (alias: version)",
		version: "same as info (no firmware-version register exists)",
		status: "live per-channel freq/level/output -> channels + values",
		set_freq: "{channel (0/1|A/B), hz} tune a channel (23.5 MHz - 6 GHz)",
		set_level: "{channel, level} output level 0-7 (level 7 needs approval)",
		output: "{channel, on: bool} enable/disable RF output - TRANSMITS; on needs approval and must be in band",
		sweep: "{channel, start, stop, step|points, dwell_ms} host-driven RF sweep - TRANSMITS; needs approval, every step must be in band"
	},
	create: create,
	// exported for tests
	_buildReport: buildReport,
	_parseValue: parseValue,
	_parseChannel: parseChannel
};
