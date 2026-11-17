// Generic SCPI instrument (LAN raw socket or usbtmc), with optional polled
// queries feeding channels. Presets (dm858, mho900) add their own commands.

const scpi = require("../../services/scpi");

const DEFAULT_POLL_MS = 500;

/**
 * @param {Object} options device options
 * @param {Object} io lab sink
 * @param {{init: string[], poll: Object[], commands: function(Object, Object, Object): Object}} [preset]
 *   commands(client, io, options) returns extra {name: fn(args)} handlers
 */
const create = (options, io, preset) => {
	const p = preset || {};
	let client = null;
	let timer = null;
	let stopped = false;
	let extra = {};
	let polls = options.poll || p.poll || [];

	const pollOnce = () => {
		const t = Date.now();
		return polls.reduce((chain, item) => {
			return chain.then(() => {
				return client.query(item.query).then((reply) => {
					// multi-value replies ("1.0,1.1,...") -> last value
					const value = Number(reply.split(",").pop());
					if (!Number.isNaN(value) && Math.abs(value) < 9.9e37) {
						io.sample(item.field, value, { unit: item.unit, t: t });
					}
				});
			});
		}, Promise.resolve());
	};

	const loop = () => {
		if (stopped) {
			return;
		}
		pollOnce()
			.catch((err) => {
				io.log("poll failed: " + err.message, "warn");
			})
			.then(() => {
				// stop() may have run while this poll was in flight
				if (!stopped) {
					timer = setTimeout(loop, options.pollMs || DEFAULT_POLL_MS);
				}
			});
	};

	const base = {
		idn: () => {
			return client.query("*IDN?").then((idn) => {
				return { idn: idn };
			});
		},
		write: (args) => {
			io.log(args.command, "tx");
			return client.write(args.command).then(() => {
				return { ok: true };
			});
		},
		query: (args) => {
			io.log(args.command, "tx");
			return client.query(args.command).then((reply) => {
				io.log(reply.slice(0, 500), "rx");
				return { reply: reply };
			});
		},
		poll: (args) => {
			polls = args.items;
			return Promise.resolve({ poll: polls });
		}
	};

	return {
		start: () => {
			// options._open: test seam replacing scpi.open (returns client promise)
			return (options._open || scpi.open)(options)
				.then((opened) => {
					client = opened;
					extra = (p.commands && p.commands(client, io, options)) || {};
					return client.query("*IDN?");
				})
				.then((idn) => {
					io.log("connected: " + idn);
					return (options.init || p.init || []).reduce((chain, command) => {
						return chain.then(() => {
							return client.write(command);
						});
					}, Promise.resolve());
				})
				.then(() => {
					if (polls.length) {
						loop();
					}
				});
		},

		stop: () => {
			stopped = true;
			clearTimeout(timer);
			if (!client) {
				return Promise.resolve();
			}
			return client.close();
		},

		command: (name, args) => {
			const handler = extra[name] || base[name];
			if (!handler) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return handler(args || {});
		}
	};
};

const OPTIONS = {
	transport: "tcp (default) | usbtmc",
	host: "instrument IP (tcp)",
	port: "TCP port (default 5555)",
	path: "/dev/usbtmcN (usbtmc)",
	poll: "[{field, query, unit}] queries polled into channels",
	pollMs: "poll period (default 500)",
	init: "SCPI commands sent after connect"
};

const COMMANDS = {
	idn: "*IDN?",
	write: "{command}",
	query: "{command}",
	poll: "{items: [{field, query, unit}]} replace polled queries"
};

/**
 * Build a preset driver on top of the generic SCPI one.
 */
const preset = (spec) => {
	return {
		name: spec.name,
		description: spec.description,
		options: Object.assign({}, OPTIONS, spec.options),
		commands: Object.assign({}, COMMANDS, spec.commandDocs),
		create: (options, io) => {
			return create(options, io, spec);
		}
	};
};

module.exports = {
	name: "scpi",
	description: "Generic SCPI instrument over LAN (raw socket) or usbtmc",
	options: OPTIONS,
	commands: COMMANDS,
	create: (options, io) => {
		return create(options, io);
	},
	preset: preset
};
