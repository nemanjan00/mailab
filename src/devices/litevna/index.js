// LiteVNA / NanoVNA-V2 over the V2 binary register protocol.
// Traces "s11" and "s21" (uncalibrated magnitude in dB + phase).
// TODO: verify on hardware; add SOL(T) calibration

const tty = require("../../services/tty");

const OP = { NOP: 0x00, READ: 0x10, READFIFO: 0x18, WRITE: 0x20, WRITE2: 0x21, WRITE8: 0x23 };
const REG = {
	SWEEP_START: 0x00,
	SWEEP_STEP: 0x10,
	SWEEP_POINTS: 0x20,
	VALUES_PER_FREQ: 0x22,
	FIFO: 0x30,
	DEVICE_VARIANT: 0xf0,
	PROTOCOL_VERSION: 0xf1
};
const RECORD_SIZE = 32;
const MAX_FIFO_READ = 255;
const DEFAULTS = { start: 50e3, stop: 1.5e9, points: 201 };

const write8 = (addr, value) => {
	const buf = Buffer.alloc(10);
	buf[0] = OP.WRITE8;
	buf[1] = addr;
	buf.writeBigUInt64LE(BigInt(Math.round(value)), 2);
	return buf;
};

const write2 = (addr, value) => {
	return Buffer.from([OP.WRITE2, addr, value & 0xff, (value >> 8) & 0xff]);
};

const db = (re, im) => {
	return 10 * Math.log10(re * re + im * im + 1e-30);
};

const deg = (re, im) => {
	return Math.atan2(im, re) * 180 / Math.PI;
};

// complex a / b
const div = (are, aim, bre, bim) => {
	const d = bre * bre + bim * bim || 1e-30;
	return [(are * bre + aim * bim) / d, (aim * bre - are * bim) / d];
};

const create = (options, io) => {
	const settings = Object.assign({}, DEFAULTS, options);
	let port = null;
	let running = false;
	let busy = Promise.resolve();

	const exchange = (buf, replyBytes, timeoutMs) => {
		const run = busy.then(() => {
			if (!replyBytes) {
				port.write(buf);
				return Buffer.alloc(0);
			}
			const reply = tty.collect(port, (acc) => {
				return acc.length >= replyBytes;
			}, timeoutMs || 2000);
			port.write(buf);
			return reply;
		});
		busy = run.catch(() => {
			return null;
		});
		return run;
	};

	const readFifo = (count, acc) => {
		if (count <= 0) {
			return Promise.resolve(acc);
		}
		const n = Math.min(count, MAX_FIFO_READ);
		return exchange(Buffer.from([OP.READFIFO, REG.FIFO, n]), n * RECORD_SIZE, 5000).then((buf) => {
			return readFifo(count - n, Buffer.concat([acc, buf.slice(0, n * RECORD_SIZE)]));
		});
	};

	const sweep = (args) => {
		const s = Object.assign({}, settings, args);
		const step = (s.stop - s.start) / Math.max(1, s.points - 1);
		return exchange(Buffer.concat([
			write8(REG.SWEEP_START, s.start),
			write8(REG.SWEEP_STEP, step),
			write2(REG.SWEEP_POINTS, s.points),
			write2(REG.VALUES_PER_FREQ, 1),
			// any write to FIFO clears it
			Buffer.from([OP.WRITE, REG.FIFO, 0])
		]), 0)
			.then(() => {
				return readFifo(s.points, Buffer.alloc(0));
			})
			.then((data) => {
				const count = data.length / RECORD_SIZE;
				const records = Array.from({ length: count }, (_, i) => {
					const r = data.slice(i * RECORD_SIZE, (i + 1) * RECORD_SIZE);
					return {
						fwd: [r.readInt32LE(0), r.readInt32LE(4)],
						rev0: [r.readInt32LE(8), r.readInt32LE(12)],
						rev1: [r.readInt32LE(16), r.readInt32LE(20)],
						index: r.readUInt16LE(24)
					};
				}).sort((a, b) => {
					return a.index - b.index;
				});
				const x = records.map((r) => {
					return s.start + r.index * step;
				});
				const s11 = records.map((r) => {
					return div(r.rev0[0], r.rev0[1], r.fwd[0], r.fwd[1]);
				});
				const s21 = records.map((r) => {
					return div(r.rev1[0], r.rev1[1], r.fwd[0], r.fwd[1]);
				});
				const traceOf = (name, values) => {
					io.trace(name, {
						x: x,
						xUnit: "Hz",
						yUnit: "dB",
						series: [
							{ label: "|" + name + "| dB", y: values.map((c) => {
								return db(c[0], c[1]);
							}) },
							{ label: "∠" + name + " °", y: values.map((c) => {
								return deg(c[0], c[1]);
							}), axis: "right" }
						]
					});
				};
				traceOf("s11", s11);
				traceOf("s21", s21);
				return { points: count, start: s.start, stop: s.stop };
			});
	};

	const loop = () => {
		if (!running) {
			return;
		}
		sweep({})
			.catch((err) => {
				io.log("sweep failed: " + err.message, "warn");
			})
			.then(() => {
				setTimeout(loop, settings.intervalMs || 100);
			});
	};

	return {
		start: () => {
			port = tty.open(options.path, { baud: 115200 });
			// a burst of NOPs resyncs the command parser
			return exchange(Buffer.alloc(8, OP.NOP), 0)
				.then(() => {
					return exchange(Buffer.from([OP.READ, REG.DEVICE_VARIANT, OP.READ, REG.PROTOCOL_VERSION]), 2);
				})
				.then((reply) => {
					io.log("V2 device variant " + reply[0] + ", protocol " + reply[1]);
					running = options.continuous !== false;
					loop();
				});
		},

		stop: () => {
			running = false;
			if (!port) {
				return Promise.resolve();
			}
			return port.close();
		},

		command: (name, args) => {
			if (name === "sweep") {
				return sweep(args || {});
			}
			if (name === "configure") {
				Object.assign(settings, args);
				return Promise.resolve(settings);
			}
			if (name === "continuous") {
				running = Boolean(args.on);
				loop();
				return Promise.resolve({ running: running });
			}
			return Promise.reject(new Error("unknown command: " + name));
		}
	};
};

module.exports = {
	name: "litevna",
	description: "LiteVNA / NanoVNA-V2 (V2 binary protocol): traces s11, s21 (uncalibrated)",
	options: {
		path: "serial port (required)",
		start: "Hz (default 50e3)",
		stop: "Hz (default 1.5e9)",
		points: "default 201",
		continuous: "sweep continuously (default true)",
		intervalMs: "pause between sweeps (default 100)"
	},
	commands: {
		sweep: "{start, stop, points}",
		configure: "{start, stop, points}",
		continuous: "{on: bool}"
	},
	create: create
};
