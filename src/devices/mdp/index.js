// Miniware MDP-P906 power modules over the nRF52840 radio bridge, using the
// host library from mdp-p906 (path from MDP_HOST_PATH, default ~/mdp-p906/host).
// Several modules (one device each, own address) can share one bridge: the
// bridge is opened once per port and every exchange re-targets its radio link.

const path = require("path");
const wrapper = require("queue-promised").wrapper;
const config = require("../../config");

const DEFAULT_PORT = "/dev/ttyACM0";
const DEFAULT_POLL_MS = 300;
const HANDSHAKE_TRIES = 10;

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
			lock: wrapper((fn) => {
				return fn();
			}, 1),
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

const create = (options, io) => {
	const host = loadHost(options.hostPath);
	const link = {
		channel: options.channel || host.psu.DEFAULT_CHANNEL,
		address: parseHex(options.address, host.psu.DEFAULT_ADDRESS),
		order: options.order || 0,
		slot: options.slot || 0,
		id: parseHex(options.id, [0, 0, 0, 0]),
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
				timer = setTimeout(poll, options.pollMs || DEFAULT_POLL_MS);
			});
	};

	return {
		start: () => {
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

		command: (name, args) => {
			const actions = {
				status: () => {
					return psu.status();
				},
				set_voltage: () => {
					return psu.setVoltage(Math.round(Number(args.volts) * 1000));
				},
				set_current: () => {
					// unit not yet confirmed on hardware (mdp-p906 STATE.md)
					return psu.setCurrent(Math.round(Number(args.amps) * 1000));
				},
				output: () => {
					return psu.setOutput(Boolean(args.on));
				}
			};
			if (!actions[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return withLink(actions[name]).then((reply) => {
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
		id: "module radio id hex4",
		model: "model code (default 2)",
		pollMs: "status poll period (default 300)",
		hostPath: "path to mdp-p906/host (default MDP_HOST_PATH)"
	},
	commands: {
		status: "raw status",
		set_voltage: "{volts}",
		set_current: "{amps} (unit unconfirmed on hardware)",
		output: "{on: bool}"
	},
	create: create
};
