// Miniware MDP-P906 power modules over the nRF52840 radio bridge, using the
// host library from mdp-p906 (path from MDP_HOST_PATH, default ~/mdp-p906/host).
// Several modules (one device each, own address) can share one bridge: the
// bridge is opened once per port and every exchange re-targets its radio link.

const path = require("path");
const serialize = require("../../utils/mutex").serialize;
const config = require("../../config");
const args = require("../../utils/args");
const bypass = require("../../utils/bypass");

const DEFAULT_PORT = "/dev/ttyACM0";
const DEFAULT_POLL_MS = 300;
const HANDSHAKE_TRIES = 10;
// P906 ratings: 30000 mV / 10000 mA fit the setpoint fields [INF, mdp-p906 PROTOCOL.md];
// per-device maxVolts/maxAmps can only lower these
const HW_MAX_VOLTS = 30;
const HW_MAX_AMPS = 10;
const ID_HELP = "the module's radio ID (hex4), printed by `mdp pair` and kept in mdp-p906 p906_backups/radio_id.txt";

const loadHost = (hostPath) => {
	const base = hostPath || config.get("MDP_HOST_PATH");
	return {
		bridge: require(path.join(base, "src", "services", "bridge")),
		psu: require(path.join(base, "src", "psu"))
	};
};

// port -> {opening: Promise<bridge>, owners: [], lock, linkKey}
const bridges = {};

const acquireBridge = (host, port, owner) => {
	if (!bridges[port]) {
		const entry = {
			opening: host.bridge.open(port),
			owners: [],
			lock: serialize(),
			linkKey: null
		};
		entry.opening.catch(() => {
			delete bridges[port];
		});
		bridges[port] = entry;
	}
	bridges[port].owners.push(owner);
	return bridges[port];
};

const releaseBridge = (port, owner) => {
	const entry = bridges[port];
	if (!entry) {
		return Promise.resolve();
	}
	entry.owners = entry.owners.filter((o) => {
		return o !== owner;
	});
	if (entry.owners.length) {
		return Promise.resolve();
	}
	delete bridges[port];
	return entry.opening.then((bridge) => {
		return bridge.close();
	}, () => {
		return null;
	});
};

const parseHex = (hex, fallback) => {
	if (!hex) {
		return fallback;
	}
	return Array.from(Buffer.from(hex, "hex"));
};

const average = (values) => {
	return values.reduce((sum, v) => {
		return sum + v;
	}, 0) / values.length;
};

/**
 * Resolve the per-device limit, which can only be stricter than the hardware's.
 */
const limit = (value, hardware, name) => {
	if (value === undefined) {
		return hardware;
	}
	return args.parseNumber(value, name, { min: 0, max: hardware });
};

/**
 * Effective V/I cap for this device. Chamber / unsafe bypass (env-only,
 * src/utils/bypass) lifts the per-device limit; the hardware cap stays unless
 * the independent MAILAB_UNSAFE_PSU opt-out is set too (a typo can then fry
 * a board — that flag is for throwaway benches only).
 */
const deviceLimit = (options, name, hardware, io) => {
	if (!bypass.active()) {
		return limit(options[name], hardware, name);
	}
	if (bypass.psuUnsafe()) {
		io.log("SAFETY BYPASSED (" + (config.get("MAILAB_UNSAFE") ? "MAILAB_UNSAFE" : "MAILAB_RF_CHAMBER") + " + MAILAB_UNSAFE_PSU): " + name + " hardware cap lifted", "warn");
		return Infinity;
	}
	io.log("SAFETY BYPASSED: " + name + " device limit lifted, hardware cap " + hardware + " kept", "warn");
	return hardware;
};

const create = (options, io) => {
	const host = loadHost(options.hostPath);
	const maxVolts = deviceLimit(options, "maxVolts", HW_MAX_VOLTS, io);
	const maxAmps = deviceLimit(options, "maxAmps", HW_MAX_AMPS, io);
	const link = {
		channel: options.channel || host.psu.DEFAULT_CHANNEL,
		address: parseHex(options.address, host.psu.DEFAULT_ADDRESS),
		order: options.order || 0,
		slot: options.slot || 0,
		id: parseHex(options.id, null),
		model: options.model || 2
	};
	const port = options.port || DEFAULT_PORT;
	const linkKey = [link.channel, Buffer.from(link.address).toString("hex"), link.order].join(":");
	let shared = null;
	let psu = null;
	let timer = null;
	let stopped = false;

	// run op on this module: serialized with other modules on the same bridge,
	// re-targeting the radio link only when another module used it last
	const withLink = (op) => {
		return shared.lock(() => {
			let ready = Promise.resolve();
			if (shared.linkKey !== linkKey) {
				ready = psu.useLink().then(() => {
					shared.linkKey = linkKey;
				});
			}
			return ready.then(op);
		});
	};

	const handshake = (triesLeft) => {
		return withLink(psu.handshake).then((hs) => {
			if (hs || triesLeft <= 1) {
				return hs;
			}
			return handshake(triesLeft - 1);
		});
	};

	const poll = () => {
		if (stopped) {
			return;
		}
		withLink(psu.status)
			.then((status) => {
				if (!status) {
					return;
				}
				const t = Date.now();
				io.sample("temp", status.temperatureC, { unit: "°C", t: t });
				io.sample("vin", status.inputMv / 1000, { unit: "V", t: t });
				io.sample("output", status.outputOn ? 1 : 0, { t: t });
				if (status.measured) {
					// TODO: the poll carries several samples; their spacing is
					// unknown, so they are averaged into one reading for now
					const v = average(status.measured.map((m) => {
						return m.mV;
					})) / 1000;
					const i = average(status.measured.map((m) => {
						return m.mA;
					})) / 1000;
					io.sample("v", v, { unit: "V", t: t });
					io.sample("i", i, { unit: "A", t: t });
					io.sample("p", v * i, { unit: "W", t: t });
				}
			})
			.catch((err) => {
				io.log("poll failed: " + err.message, "warn");
			})
			.then(() => {
				// stop() may have run while this poll was in flight
				if (!stopped) {
					timer = setTimeout(poll, options.pollMs || DEFAULT_POLL_MS);
				}
			});
	};

	return {
		start: () => {
			if (!link.id || link.id.length !== 4) {
				return Promise.reject(new Error("option id is required: " + ID_HELP));
			}
			if (link.id.every((b) => {
				return b === 0;
			})) {
				// mdp-p906 STATE.md: the firmware suggests polls accept it [INF], never tried on hardware
				io.log("using all-zero module ID; this is unverified on hardware. If the module doesn't answer, set " + ID_HELP, "warn");
			}
			shared = acquireBridge(host, port, io.id);
			return shared.opening
				.then((bridge) => {
					psu = host.psu.create(bridge, link);
					return handshake(HANDSHAKE_TRIES);
				})
				.then((hs) => {
					if (!hs) {
						throw new Error("no handshake reply (paired? see mdp-p906 README)");
					}
					io.log("handshake ok, model " + link.model);
					poll();
				});
		},

		stop: () => {
			stopped = true;
			clearTimeout(timer);
			if (!shared) {
				return Promise.resolve();
			}
			return releaseBridge(port, io.id);
		},

		command: (name, params) => {
			// validate everything before anything reaches the radio
			const prepare = {
				status: () => {
					return psu.status;
				},
				set_voltage: () => {
					const volts = args.parseNumber(params.volts, "volts", { min: 0, max: maxVolts, unit: "V" });
					const millivolts = Math.round(volts * 1000);
					return () => {
						return psu.setVoltage(millivolts);
					};
				},
				set_current: () => {
					// mdp-p906 STATE.md: the setpoint unit is still open (mA, mA/2, 10 mA or 100 mA)
					if (!options.allowSetCurrent) {
						throw new Error("set_current is disabled until its unit is confirmed on hardware (mdp-p906 STATE.md); set device option allowSetCurrent: true to send it as mA anyway");
					}
					const amps = args.parseNumber(params.amps, "amps", { min: 0, max: maxAmps, unit: "A" });
					const milliamps = Math.round(amps * 1000);
					io.log("set_current " + milliamps + " mA: unit unconfirmed, check the module's screen", "warn");
					return () => {
						return psu.setCurrent(milliamps);
					};
				},
				output: () => {
					const on = args.parseSwitch(params.on, "on");
					return () => {
						return psu.setOutput(on);
					};
				}
			};
			if (!prepare[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			let op;
			try {
				op = prepare[name]();
			} catch (err) {
				return Promise.reject(err);
			}
			return withLink(op).then((reply) => {
				return { ok: reply !== null, reply: reply };
			});
		}
	};
};

module.exports = {
	name: "mdp",
	description: "Miniware MDP-P906 power module via nRF52840 radio bridge (mdp-p906), several modules per bridge (one device per address). Channels: v, i, p, vin, temp, output",
	options: {
		port: "bridge serial port (default /dev/ttyACM0); modules on one bridge share it",
		address: "radio address hex5 (default e0d3c2b1a0)",
		channel: "radio channel (default 78)",
		id: "module radio ID hex4 (required): " + ID_HELP,
		maxVolts: "voltage limit for this device, ≤ 30 V (default 30)",
		maxAmps: "current limit for this device, ≤ 10 A (default 10)",
		allowSetCurrent: "enable set_current although its unit is unconfirmed (default false)",
		model: "model code (default 2)",
		pollMs: "status poll period (default 300)",
		hostPath: "path to mdp-p906/host (default MDP_HOST_PATH)"
	},
	commands: {
		status: "raw status",
		set_voltage: "{volts} 0..maxVolts",
		set_current: "{amps} 0..maxAmps; disabled unless allowSetCurrent (unit unconfirmed on hardware)",
		output: "{on: true|false|\"on\"|\"off\"} anything else is rejected"
	},
	create: create
};
