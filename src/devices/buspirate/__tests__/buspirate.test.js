// Bus Pirate driver against a fake unit: a PTY pair (socat) with the test
// playing the classic binary mode protocol. Hardware-untested [HW].

const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const buspirate = require("..");

const hasSocat = spawnSync("sh", ["-c", "command -v socat"]).status === 0;

const waitFor = (fn, ms) => new Promise((resolve, reject) => {
	const start = Date.now();
	const tick = () => {
		if (fn()) {
			resolve();
		} else if (Date.now() - start > ms) {
			reject(new Error("timeout"));
		} else {
			setTimeout(tick, 20);
		}
	};
	tick();
});

const fakeIo = () => {
	const io = { id: "bp1", logs: [], statuses: [], samples: [] };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	io.sample = (field, value, meta) => io.samples.push([field, value, meta]);
	return io;
};

// fake Bus Pirate on the far end of a PTY pair: a second socat attaches to
// the slave PTY (stdio <-> pty) so the test talks pipes, like esb.test.js
const fakePirate = (slave, handler) => {
	const child = spawn("socat", ["-", slave + ",raw,echo=0"]);
	const pirate = { child: child, buf: Buffer.alloc(0) };
	pirate.handler = handler(pirate, (bytes) => pirate.child.stdin.write(Buffer.from(bytes)));
	child.stdout.on("data", (data) => {
		pirate.buf = Buffer.concat([pirate.buf, data]);
		while (true) {
			const consumed = pirate.handler(pirate.buf);
			if (!consumed) {
				break;
			}
			pirate.buf = pirate.buf.slice(consumed);
		}
	});
	pirate.close = () => {
		pirate.child.kill();
	};
	return pirate;
};

describe("buspirate driver over a PTY pair", () => {
	if (!hasSocat) {
		test.skip("needs socat", () => {});
		return;
	}

	let socat = null;
	let dev = null;
	let io = null;
	let pirate = null;

	const openPair = () => new Promise((resolve, reject) => {
		const child = spawn("socat", ["-d", "-d", "pty,raw,echo=0", "pty,raw,echo=0"]);
		let out = "";
		child.stderr.on("data", (d) => {
			out += d.toString();
			const seen = out.split("\n").filter((l) => l.includes("PTY is"));
			if (seen.length >= 2) {
				resolve({ socat: child, master: seen[0].match(/PTY is (\/dev\/pts\/\d+)/)[1], slave: seen[1].match(/PTY is (\/dev\/pts\/\d+)/)[1] });
			}
		});
		child.on("error", reject);
		setTimeout(() => reject(new Error("socat did not report PTYs: " + out)), 5000);
	});

	afterEach(() => {
		if (dev) {
			return dev.stop().then(() => {
				dev = null;
				if (pirate) {
					pirate.close();
					pirate = null;
				}
				if (socat) {
					socat.kill();
					socat = null;
				}
			});
		}
		if (pirate) {
			pirate.close();
			pirate = null;
		}
		if (socat) {
			socat.kill();
			socat = null;
		}
		return undefined;
	});

	const start = (handler) => openPair().then((pair) => {
		socat = pair.socat;
		io = fakeIo();
		pirate = fakePirate(pair.slave, handler);
		dev = buspirate.create({ path: pair.master }, io);
		return dev.start().then(() => waitFor(() => io.statuses.some((s) => s[0] === "running"), 3000));
	});

	// a basic fake: answers 0x00 with BBIO1, 0x0f with BBIO1, mode bytes
	// with their banners; ADC 0x68 -> 0x01 0x80; freq 0x6a -> 0x00 0x01 0x86 0xa0 (100000)
	const basicHandler = (pirate, write) => (buf) => {
		if (!buf.length) {
			return 0;
		}
		const b = buf[0];
		if (b === 0x00 || b === 0x0f) {
			write([0x42, 0x42, 0x49, 0x4f, 0x31]); // "BBIO1"
			return 1;
		}
		if (b === 0x01) {
			write([0x53, 0x50, 0x49, 0x31]); // "SPI1"
			return 1;
		}
		if (b === 0x02) {
			write([0x49, 0x32, 0x43, 0x31]); // "I2C1"
			return 1;
		}
		if (b === 0x68) {
			write([0x01, 0x80]);
			return 1;
		}
		if (b === 0x6a) {
			write([0x00, 0x01, 0x86, 0xa0]);
			return 1;
		}
		if (b >= 0x40 && b <= 0x4f) {
			write([0x01]);
			return 1;
		}
		if (b >= 0x80) {
			// bulk: echo the payload back, prefixed with ack
			const n = (b & 0x7f) + 1;
			if (buf.length < 1 + n) {
				return 0; // wait for the payload
			}
			write([0x01].concat(Array.from(buf.slice(1, 1 + n))));
			return 1 + n;
		}
		if (b === 0x6b || b === 0x6c) {
			write([0x01]);
			return b === 0x6b ? 7 : 1; // pwm on takes a 6-byte body
		}
		return 1;
	};

	test("start enters binary mode (BBIO1)", () => {
		return start(basicHandler).then(() => {
			expect(io.statuses.some((s) => s[0] === "running")).toBe(true);
			expect(io.logs.some((l) => l[1].indexOf("BBIO1") !== -1)).toBe(true);
		});
	});

	test("mode switches answer with the sub-mode banner", () => {
		return start(basicHandler).then(() => {
			return dev.command("mode", { name: "i2c" });
		}).then((r) => {
			expect(r.mode).toBe("i2c");
			return dev.command("mode", { name: "spi" });
		}).then((r) => {
			expect(r.mode).toBe("spi");
			expect(dev.command("mode", { name: "bogus" })).rejects.toThrow("mode must be");
		});
	});

	test("peripheral config is acked", () => {
		return start(basicHandler).then(() => {
			return dev.command("peripheral", { power: true, aux: true });
		}).then((r) => {
			expect(r).toEqual({ ok: true, flags: 0x0a });
		});
	});

	test("adc and freq readings sample channels", () => {
		return start(basicHandler).then(() => {
			return dev.command("adc", {});
		}).then((r) => {
			expect(r.raw).toBe(0x0180);
			expect(r.v).toBeCloseTo(0x180 * 6.6 / 1024, 3);
			return dev.command("freq", {});
		}).then((r) => {
			expect(r.hz).toBe(100000);
			expect(io.samples.some((s) => s[0] === "freq" && s[1] === 100000)).toBe(true);
		});
	});

	test("pwm on/off", () => {
		return start(basicHandler).then(() => {
			return dev.command("pwm", { on: true, prescale: 1, period: 1000, duty: 250 });
		}).then((r) => {
			expect(r.pwm).toBe(true);
			return dev.command("pwm", { on: false });
		}).then((r) => {
			expect(r.pwm).toBe(false);
		});
	});

	test("bulk transfers round-trip", () => {
		return start(basicHandler).then(() => {
			return dev.command("bulk", { hex: "de ad be ef" });
		}).then((r) => {
			expect(r.rx).toBe("deadbeef");
			expect(dev.command("bulk", { hex: "00".repeat(129) })).rejects.toThrow("1..128");
		});
	});
});
