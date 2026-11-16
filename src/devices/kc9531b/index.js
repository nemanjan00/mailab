// DeepAce KC9531B RF power meter (nemanjan00/kc9531b). Channels: dbm, mw.

const kc9531b = require("kc9531b");
const tty = require("../../services/tty");

const DEFAULT_POLL_MS = 200;

const create = (options, io) => {
	let port = null;
	let device = null;
	let timer = null;
	let stopped = false;

	const poll = () => {
		if (stopped) {
			return;
		}
		const t = Date.now();
		device.getPowerdBm()
			.then((dbm) => {
				io.sample("dbm", dbm, { unit: "dBm", t: t });
				io.sample("mw", Math.pow(10, dbm / 10), { unit: "mW", t: t });
			})
			.catch((err) => {
				io.log("poll failed: " + err, "warn");
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
			port = tty.acquire(options.path, { baud: options.baud || 115200, owner: io.id });
			device = kc9531b(port);
			let ready = Promise.resolve();
			if (options.frequency) {
				ready = device.setFrequency(Number(options.frequency));
			}
			return ready
				.then(() => {
					return device.getDeviceModel();
				})
				.then((model) => {
					io.log("connected: " + model);
					poll();
				});
		},

		stop: () => {
			stopped = true;
			clearTimeout(timer);
			if (device) {
				device.close();
			}
			if (!port) {
				return Promise.resolve();
			}
			return tty.release(options.path, io.id);
		},

		command: (name, args) => {
			const actions = {
				info: () => {
					return Promise.all([
						device.getDeviceModel(),
						device.getHardwareVersion(),
						device.getSoftwareVersion(),
						device.getFrequency(),
						device.getTemperature()
					]).then((r) => {
						return { model: r[0], hardware: r[1], software: r[2], frequency: r[3], temperature: r[4] };
					});
				},
				set_frequency: () => {
					// correction frequency, in the unit the meter expects (see kc9531b docs)
					return device.setFrequency(Number(args.frequency)).then(() => {
						return { ok: true };
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
	name: "kc9531b",
	description: "DeepAce KC9531B RF power meter. Channels: dbm, mw",
	options: {
		path: "serial port (required)",
		baud: "default 115200",
		frequency: "correction frequency set on start",
		pollMs: "default 200"
	},
	commands: {
		info: "model, versions, frequency, temperature",
		set_frequency: "{frequency} correction frequency"
	},
	create: create
};
