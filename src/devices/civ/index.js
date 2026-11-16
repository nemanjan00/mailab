// Icom radios over CI-V (nemanjan00/ci-v, loaded from CIV_PATH since it is not
// on npm). Channels: freq, swr (while transmitting).

const config = require("../../config");
const tty = require("../../services/tty");

const DEFAULT_POLL_MS = 500;

// CI-V replies are BCD; "1512" (SWR) returns [0x12, hi, lo] -> 0..255 meter value
const bcd = (bytes) => {
	return Array.from(bytes).reduce((acc, b) => {
		return acc * 100 + ((b >> 4) * 10 + (b & 0x0f));
	}, 0);
};

const create = (options, io) => {
	const CIV = require(options.civPath || config.get("CIV_PATH"));
	let port = null;
	let radio = null;
	let timer = null;
	let stopped = false;

	const poll = () => {
		if (stopped) {
			return;
		}
		radio.getFrequency()
			.then((hz) => {
				io.sample("freq", hz, { unit: "Hz" });
			})
			.catch((err) => {
				io.log("poll failed: " + err, "warn");
			})
			.then(() => {
				timer = setTimeout(poll, options.pollMs || DEFAULT_POLL_MS);
			});
	};

	return {
		start: () => {
			port = tty.open(options.path, { baud: options.baud || 115200 });
			radio = CIV(port);
			if (options.radioAddress) {
				radio.civ.radioAddress = Buffer.from(options.radioAddress, "hex");
			}
			radio.on("waveform", (data) => {
				// TODO: decode scope waveform frames into a trace
				io.log("waveform frame " + Buffer.from(data).length + " bytes", "debug");
			});
			poll();
			return Promise.resolve();
		},

		stop: () => {
			stopped = true;
			clearTimeout(timer);
			if (!port) {
				return Promise.resolve();
			}
			return port.close();
		},

		command: (name, args) => {
			const actions = {
				get_frequency: () => {
					return radio.getFrequency().then((hz) => {
						return { hz: hz };
					});
				},
				set_frequency: () => {
					return radio.setFrequency(Math.round(Number(args.hz))).then(() => {
						return { ok: true };
					});
				},
				ptt: () => {
					if (args.on) {
						return radio.transmit();
					}
					return radio.endTransmit();
				},
				swr: () => {
					return radio.getSWR().then((reply) => {
						const meter = bcd(Buffer.from(reply).slice(1));
						io.sample("swr_meter", meter);
						return { meter: meter, raw: Buffer.from(reply).toString("hex") };
					});
				},
				raw: () => {
					return radio.civ.run(args.hex).then((reply) => {
						return { reply: Buffer.from(reply || []).toString("hex") };
					});
				}
			};
			if (!actions[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return actions[name]();
		}
	};
};

module.exports = {
	name: "civ",
	description: "Icom radio over CI-V (IC-705 etc.). Channels: freq, swr_meter",
	options: {
		path: "serial port (required)",
		baud: "default 115200",
		radioAddress: "CI-V address hex (default A4 = IC-705)",
		pollMs: "frequency poll period (default 500)",
		civPath: "path to the ci-v library (default CIV_PATH or ~/ci-v)"
	},
	commands: {
		get_frequency: "",
		set_frequency: "{hz}",
		ptt: "{on: bool} TRANSMITS — make sure a load/antenna is connected",
		swr: "read SWR meter (0-255 raw, only valid while transmitting)",
		raw: "{hex} raw CI-V command body, e.g. \"03\""
	},
	create: create
};
