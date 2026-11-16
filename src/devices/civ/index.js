// Icom radios over CI-V (nemanjan00/ci-v, npm "icom-ci-v"). Several radios can
// share one CI-V bus/port: give each device the same path and its own
// radioAddress (replies are routed by address). Channels: freq, squelch, swr_meter.

const EventEmitter = require("events");
const config = require("../../config");
const tty = require("../../services/tty");
const parseSwitch = require("../../utils/args").parseSwitch;
const parseNumber = require("../../utils/args").parseNumber;

const DEFAULT_POLL_MS = 500;

// npm package when installed, else a local clone (CIV_PATH)
const loadCiv = (civPath) => {
	if (civPath) {
		return require(civPath);
	}
	try {
		return require("icom-ci-v");
	} catch (_err) {
		return require(config.get("CIV_PATH"));
	}
};

// Per-radio view of a shared port. ci-v has no close(), so on stop the proxy
// goes silent: its RX poll timer then writes nowhere and hears nothing.
const proxy = (port) => {
	const socket = new EventEmitter();
	let active = true;
	const onData = (data) => {
		socket.emit("data", data);
	};
	port.on("data", onData);
	socket.opening = false;
	socket.write = (data) => {
		if (active) {
			port.write(data);
		}
		return active;
	};
	socket.detach = () => {
		active = false;
		port.off("data", onData);
	};
	return socket;
};

// CI-V replies are BCD; "1512" (SWR) returns [0x12, hi, lo] -> 0..255 meter value
const bcd = (bytes) => {
	return Array.from(bytes).reduce((acc, b) => {
		return acc * 100 + ((b >> 4) * 10 + (b & 0x0f));
	}, 0);
};

const create = (options, io) => {
	const CIV = loadCiv(options.civPath);
	let port = null;
	let socket = null;
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
			port = tty.acquire(options.path, { baud: options.baud || 115200, owner: io.id, shared: true });
			socket = proxy(port);
			radio = CIV(socket);
			if (options.radioAddress) {
				radio.civ.radioAddress = Buffer.from(options.radioAddress, "hex");
			}
			radio.on("rx", () => {
				io.sample("squelch", 1);
			});
			radio.on("rx_end", () => {
				io.sample("squelch", 0);
			});
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
			socket.detach();
			return tty.release(options.path, io.id);
		},

		command: (name, args) => {
			const actions = {
				get_frequency: () => {
					return radio.getFrequency().then((hz) => {
						return { hz: hz };
					});
				},
				set_frequency: () => {
					return radio.setFrequency(Math.round(parseNumber(args.hz, "hz", { min: 0, unit: "Hz" }))).then(() => {
						return { ok: true };
					});
				},
				ptt: () => {
					// "false" must never key the transmitter
					if (parseSwitch(args.on, "on")) {
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
	description: "Icom radio over CI-V (IC-705 etc.), several radios per bus. Channels: freq, squelch, swr_meter",
	options: {
		path: "serial port (required); radios on one CI-V bus share it",
		baud: "default 115200",
		radioAddress: "CI-V address hex (default A4 = IC-705)",
		pollMs: "frequency poll period (default 500)",
		civPath: "path to a ci-v checkout (default: npm icom-ci-v, else CIV_PATH)"
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
