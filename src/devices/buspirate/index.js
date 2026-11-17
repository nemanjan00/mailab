// Bus Pirate binary mode (classic protocol, v3/4/5 and BPIO2's binary
// mode): entered by sending 0x00 until the unit answers "BBIO1". Mode
// switches (I2C/SPI/UART/1-Wire/raw-wire), peripheral config (power,
// pullups, AUX, CS), ADC, frequency counter, PWM, bulk transfers.
// Hardware-untested: written against the Dangerous Prototypes binary mode
// docs [HW]; extended opcodes may need tweaks on the bench.

const tty = require("../../services/tty");
const usb = require("../../services/usb");

const RETRY_MS = 1000;
const ENTER_ATTEMPTS = 20;
const MODE_BYTES = { spi: 0x01, i2c: 0x02, uart: 0x03, onewire: 0x04, raw: 0x05 };
const MODE_REPLIES = { spi: "SPI1", i2c: "I2C1", uart: "UART1", onewire: "OW1", raw: "RAW1" };

const create = (options, io) => {
	const settings = { baud: Number(options.baud) || 115200 };
	let path = null;
	let port = null;
	let stopped = false;
	let retry = null;
	const stats = { connects: 0 };

	const resolve = () => {
		if (options.path) {
			return options.path;
		}
		const found = usb.findPort(usb.serialPorts(usb.inventory().buses), options.match || {});
		return found ? found.node : null;
	};

	const send = (buf) => {
		if (!port) {
			throw new Error("not connected");
		}
		port.write(buf);
	};

	// one exchange at a time: the protocol is strictly command -> response
	let chain = Promise.resolve();
	const exclusive = (fn) => {
		const job = chain.then(fn);
		chain = job.catch(() => null);
		return job;
	};

	// send a byte, wait for `want` bytes back (or a fixed ack byte)
	const transact = (out, want, timeoutMs) => {
		return new Promise((done, fail) => {
			let buf = Buffer.alloc(0);
			const timer = setTimeout(() => {
				fail(new Error("timeout waiting for " + want + " byte(s) after 0x" + Buffer.from(out).toString("hex") + " (got " + buf.length + ")"));
			}, timeoutMs || 3000);
			const onData = (data) => {
				buf = Buffer.concat([buf, data]);
				if (buf.length >= want) {
					clearTimeout(timer);
					port.off("data", onData);
					done(buf.slice(0, want));
				}
			};
			port.on("data", onData);
			try {
				send(Buffer.from(out));
			} catch (err) {
				clearTimeout(timer);
				port.off("data", onData);
				fail(err);
			}
		});
	};

	const enterBinary = () => {
		// spam 0x00 until the unit reports "BBIO1" (max ENTER_ATTEMPTS)
		let attempt = 0;
		const tryEnter = () => {
			return transact([0x00], 5, 1000).then((reply) => {
				if (reply.toString("latin1") === "BBIO1") {
					return { ok: true };
				}
				attempt++;
				if (attempt >= ENTER_ATTEMPTS) {
					throw new Error("Bus Pirate did not enter binary mode (no BBIO1 after " + ENTER_ATTEMPTS + " attempts — is the terminal menu in HiZ?)");
				}
				return tryEnter();
			});
		};
		return tryEnter();
	};

	const disconnect = () => {
		if (!port) {
			return Promise.resolve();
		}
		port = null;
		return tty.release(path, io.id);
	};

	const connect = () => {
		retry = null;
		if (stopped) {
			return;
		}
		const next = resolve();
		if (!next) {
			io.status("waiting", "Bus Pirate not connected" + (options.match ? " (" + JSON.stringify(options.match) + ")" : ""));
			retry = setTimeout(connect, RETRY_MS);
			return;
		}
		try {
			path = next;
			port = tty.acquire(path, { baud: settings.baud, format: "8N1", flow: "none", owner: io.id });
		} catch (err) {
			port = null;
			io.status("waiting", err.message);
			retry = setTimeout(connect, RETRY_MS);
			return;
		}
		stats.connects++;
		port.on("error", (err) => {
			io.log("disconnected: " + err.message, "warn");
			disconnect().then(() => {
				if (!stopped && !retry) {
					retry = setTimeout(connect, RETRY_MS);
				}
			});
		});
		enterBinary()
			.then(() => {
				io.status("running", path + " binary mode");
				io.log("binary mode (BBIO1)", "info");
			})
			.catch((err) => {
				io.status("error", err.message);
				io.log(err.message, "error");
			});
	};

	const cleanHex = (hex) => {
		const clean = String(hex).replace(/0x/gi, "").replace(/[\s,:]/g, "");
		if (!/^([0-9a-f]{2})*$/i.test(clean) || !clean.length) {
			throw new Error("hex must be pairs of hex digits");
		}
		return clean;
	};

	const commands = {
		reset: () => exclusive(() => {
			return transact([0x0f], 5, 2000).then((reply) => {
				if (reply.toString("latin1") !== "BBIO1") {
					throw new Error("unexpected reset reply: " + reply.toString("hex"));
				}
				return { ok: true };
			});
		}),

		// switch binary sub-mode; the unit answers with its 4-char banner
		mode: (args) => {
			const name = String(args.name || "bitbang").toLowerCase();
			if (name === "bitbang") {
				return commands.reset();
			}
			const byte = MODE_BYTES[name];
			if (byte === undefined) {
				throw new Error("mode must be one of " + ["bitbang"].concat(Object.keys(MODE_BYTES)).join("|"));
			}
			return exclusive(() => {
				return transact([byte], 4, 2000).then((reply) => {
					if (reply.toString("latin1") !== MODE_REPLIES[name]) {
						throw new Error("unexpected mode reply: " + reply.toString("latin1"));
					}
					return { mode: name };
				});
			});
		},

		// peripherals: power (0x8), pullups (0x4), AUX (0x2), CS (0x1)
		peripheral: (args) => {
			const flags = (args.power ? 0x08 : 0) | (args.pullups ? 0x04 : 0) | (args.aux ? 0x02 : 0) | (args.cs ? 0x01 : 0);
			return exclusive(() => {
				return transact([0x40 | flags], 1, 1000).then((reply) => {
					if (reply[0] !== 0x01) {
						throw new Error("peripheral config not acked: 0x" + reply.toString("hex"));
					}
					return { ok: true, flags: flags };
				});
			});
		},

		// AUX pin ADC: 2 bytes big-endian (unit-dependent full scale [HW])
		adc: () => exclusive(() => {
			return transact([0x68], 2, 3000).then((reply) => {
				const raw = reply.readUInt16BE(0);
				io.sample("adc_raw", raw, { unit: "lsb" });
				return { raw: raw, v: raw * (options.adcFullScaleV || 6.6) / (options.adcMax || 1024) };
			});
		}),

		// frequency on AUX: 4 bytes big-endian Hz
		freq: () => exclusive(() => {
			return transact([0x6a], 4, 3000).then((reply) => {
				const hz = reply.readUInt32BE(0);
				io.sample("freq", hz, { unit: "Hz" });
				return { hz: hz };
			});
		}),

		// PWM on AUX: prescale(2B BE) period(2B BE) duty(2B BE)
		pwm: (args) => exclusive(() => {
			if (!args || args.on === false) {
				return transact([0x6c], 1, 1000).then((reply) => {
					if (reply[0] !== 0x01) {
						throw new Error("pwm off not acked");
					}
					return { pwm: false };
				});
			}
			const head = Buffer.from([0x6b]);
			const body = Buffer.alloc(6);
			body.writeUInt16BE(Number(args.prescale) || 1, 0);
			body.writeUInt16BE(Number(args.period) || 1000, 2);
			body.writeUInt16BE(Number(args.duty) || 500, 4);
			return transact(Buffer.concat([head, body]), 1, 1000).then((reply) => {
				if (reply[0] !== 0x01) {
					throw new Error("pwm on not acked");
				}
				return { pwm: true };
			});
		}),

		// bulk transfer: 0x80|(n-1) then n bytes out, n bytes back
		bulk: (args) => exclusive(() => {
			const data = Buffer.from(cleanHex(args.hex), "hex");
			if (data.length < 1 || data.length > 128) {
				throw new Error("bulk transfers are 1..128 bytes");
			}
			return transact(Buffer.concat([Buffer.from([0x80 | (data.length - 1)]), data]), data.length + 1, 5000).then((reply) => {
				if (reply[0] !== 0x01) {
					throw new Error("bulk not acked: 0x" + reply[0].toString(16));
				}
				return { rx: reply.slice(1).toString("hex") };
			});
		}),

		status: () => ({ path: path, connected: Boolean(port), settings: settings, stats: stats })
	};

	return {
		port: () => (port ? path : null),
		start: () => {
			connect();
			return Promise.resolve();
		},
		stop: () => {
			stopped = true;
			clearTimeout(retry);
			return disconnect();
		},
		command: (name, args) => {
			if (!commands[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		}
	};
};

module.exports = {
	name: "buspirate",
	description: "Bus Pirate classic binary mode (v3/4/5, BPIO2): I2C/SPI/UART/1-Wire/raw-wire sub-modes, power/pullups/AUX/CS, ADC + frequency channels, PWM, bulk transfers. Follows the adapter by identity and reconnects after replugs",
	options: {
		path: "fixed device node, e.g. /dev/ttyUSB0 (or use match)",
		match: "{vid, pid, serial, product, usbPath, interface, byId}: stable identity from uart_ports",
		baud: "baud rate (default 115200)",
		adcFullScaleV: "ADC full-scale voltage (default 6.6)",
		adcMax: "ADC full-scale raw count (default 1024)"
	},
	commands: {
		reset: "{} back to raw bitbang (BBIO1)",
		mode: "{name: bitbang|spi|i2c|uart|onewire|raw} switch binary sub-mode",
		peripheral: "{power?, pullups?, aux?, cs?} configure peripherals",
		adc: "{} AUX ADC reading (raw + V, adc_raw channel)",
		freq: "{} AUX frequency in Hz (freq channel)",
		pwm: "{on?, prescale?, period?, duty?} AUX PWM (on: false turns off)",
		bulk: "{hex} 1..128 byte raw transfer -> rx hex",
		status: "{} port, settings, counters"
	},
	create: create
};
