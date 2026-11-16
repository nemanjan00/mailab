// Simulated signal generator, for trying the lab without hardware.

const DEFAULT_RATE_HZ = 50;
const DEFAULT_SIGNALS = [
	{ name: "sine", shape: "sine", freq: 0.5, amp: 1, offset: 0, noise: 0.02, unit: "V" },
	{ name: "noise", shape: "noise", amp: 0.2, offset: 1, unit: "V" }
];

const SHAPES = {
	sine: (phase) => {
		return Math.sin(2 * Math.PI * phase);
	},
	square: (phase) => {
		if (phase % 1 < 0.5) {
			return 1;
		}
		return -1;
	},
	ramp: (phase) => {
		return 2 * (phase % 1) - 1;
	},
	noise: () => {
		return 0;
	}
};

const value = (signal, seconds) => {
	const shape = SHAPES[signal.shape] || SHAPES.sine;
	const base = shape(seconds * (signal.freq || 1));
	let noise = signal.noise || 0;
	if (signal.shape === "noise") {
		noise = 1;
	}
	return (signal.offset || 0) + (signal.amp || 1) * (base + noise * (Math.random() * 2 - 1));
};

const create = (options, io) => {
	const rateHz = options.rateHz || DEFAULT_RATE_HZ;
	const signals = (options.signals || DEFAULT_SIGNALS).map((signal) => {
		return Object.assign({}, signal);
	});
	let timer = null;

	const tick = () => {
		const t = Date.now();
		signals.forEach((signal) => {
			io.sample(signal.name, value(signal, t / 1000), { unit: signal.unit, t: t });
		});
	};

	return {
		start: () => {
			timer = setInterval(tick, 1000 / rateHz);
			io.log("simulating " + signals.length + " signals at " + rateHz + " Hz");
			return Promise.resolve();
		},

		stop: () => {
			clearInterval(timer);
			return Promise.resolve();
		},

		command: (name, args) => {
			if (name === "set") {
				const signal = signals.find((s) => {
					return s.name === args.signal;
				});
				if (!signal) {
					return Promise.reject(new Error("unknown signal: " + args.signal));
				}
				signal[args.key] = args.value;
				return Promise.resolve(signal);
			}
			if (name === "signals") {
				return Promise.resolve(signals);
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "sim",
	description: "Simulated signal generator (sine/square/ramp/noise), no hardware needed",
	options: {
		rateHz: "samples per second (default 50)",
		signals: "[{name, shape: sine|square|ramp|noise, freq, amp, offset, noise, unit}]"
	},
	commands: {
		signals: "list signal definitions",
		set: "{signal, key, value} change a signal parameter, e.g. {signal: \"sine\", key: \"freq\", value: 2}"
	},
	create: create
};
