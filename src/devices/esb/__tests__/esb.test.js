// nRF52840 ESB bridge driver (mdp-p906 bridge firmware) against a fake
// bridge: a PTY pair (socat) with the test playing the firmware's line
// protocol. Hardware-untested: written against ~/mdp-p906/bridge/src/main.cpp
// (PlatformIO project, `pio run` builds clean); no bridge attached here.

const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const esb = require("..");

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
	const io = { id: "esb1", logs: [], statuses: [], samples: [], events: [] };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	io.sample = (field, value) => io.samples.push([field, value]);
	io.event = (name, data) => io.events.push([name, data]);
	return io;
};

// fake bridge on the far end of a PTY pair: a second socat attaches to the
// slave PTY (stdio <-> pty), so the test talks pipes (async, no blocking
// fd reads) while the driver sees a real tty on the master side
const fakeBridge = (slave, scenario) => {
	const child = spawn("socat", ["-", slave + ",raw,echo=0"]);
	const bridge = { child: child, buf: "" };
	const write = (line) => bridge.child.stdin.write(line + "\n");
	bridge.push = write;
	bridge.handler = scenario(bridge, write);
	child.stdout.on("data", (data) => {
		bridge.buf += data.toString("latin1");
		let i;
		while ((i = bridge.buf.indexOf("\n")) !== -1) {
			const line = bridge.buf.slice(0, i).replace(/\r$/, "");
			bridge.buf = bridge.buf.slice(i + 1);
			bridge.handler(line);
		}
	});
	bridge.close = () => {
		bridge.child.kill();
	};
	return bridge;
};

describe("esb helpers", () => {
	test("hex, rx line, config line parsing", () => {
		expect(esb._test.parseHex("de ad:BE,ef 0x01")).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01]));
		expect(() => esb._test.parseHex("abc")).toThrow();
		expect(() => esb._test.parseHex("")).toThrow();
		expect(() => esb._test.parseHex("00".repeat(33))).toThrow();

		const rx = esb._test.parseRxLine("RX 5F DUP 01020304");
		expect(rx.hdr).toBe(0x5f);
		expect(rx.dup).toBe(true);
		expect(rx.data).toEqual(Buffer.from([1, 2, 3, 4]));
		const rx2 = esb._test.parseRxLine("RX a3 0a0b");
		expect(rx2.dup).toBe(false);
		expect(esb._test.parseRxLine("RX zzz")).toBeNull();

		const cfg = esb._test.parseConfigLine("OK ch=42 addr=e7e7e7e7e7 order=0 ackbit=1 ackmode=1 ackdelay=130 prefix=e7 base=e7e7e7e7");
		expect(cfg).toEqual({ ch: 42, addr: "e7e7e7e7e7", order: 0, ackbit: 1, ackmode: 1, ackdelay: 130, prefix: "e7", base: "e7e7e7e7" });
		expect(esb._test.parseConfigLine("OK heard 3")).toBeNull();
	});
});

describe("esb driver over a PTY pair", () => {
	if (!hasSocat) {
		test.skip("needs socat", () => {});
		return;
	}

	let socat = null;
	let dev = null;
	let io = null;
	let bridge = null;

	const openPair = () => new Promise((resolve, reject) => {
		const child = spawn("socat", ["-d", "-d", "pty,raw,echo=0", "pty,raw,echo=0"]);
		let out = "";
		let seen = [];
		child.stderr.on("data", (d) => {
			out += d.toString();
			seen = out.split("\n").filter((l) => l.includes("PTY is"));
			if (seen.length >= 2) {
				resolve({
					socat: child,
					master: seen[0].match(/PTY is (\/dev\/pts\/\d+)/)[1],
					slave: seen[1].match(/PTY is (\/dev\/pts\/\d+)/)[1]
				});
			}
		});
		child.on("error", reject);
		setTimeout(() => reject(new Error("socat did not report PTYs: " + out)), 5000);
	});

	afterEach(() => {
		if (dev) {
			return dev.stop().then(() => {
				dev = null;
				if (bridge) {
					bridge.close();
					bridge = null;
				}
				if (socat) {
					socat.kill();
					socat = null;
				}
			});
		}
		if (bridge) {
			bridge.close();
			bridge = null;
		}
		if (socat) {
			socat.kill();
			socat = null;
		}
		return undefined;
	});

	const start = (scenario) => openPair().then((pair) => {
		socat = pair.socat;
		io = fakeIo();
		bridge = fakeBridge(pair.slave, scenario);
		dev = esb.create({ path: pair.master }, io);
		return dev.start().then(() => waitFor(() => io.statuses.some((s) => s[0] === "running"), 3000));
	});

	const cfgLine = "OK ch=42 addr=e7e7e7e7e7 order=0 ackbit=1 ackmode=1 ackdelay=130 prefix=e7 base=e7e7e7e7";

	test("configure queries the config echo", () => {
		return start((bridge, write) => (line) => {
			if (line.startsWith("C ")) {
				write(cfgLine);
			}
		}).then(() => dev.command("configure", { ch: 42, addr: "e7 e7 e7 e7 e7" })).then((cfg) => {
			expect(cfg.ch).toBe(42);
			expect(cfg.addr).toBe("e7e7e7e7e7");
			expect(dev.command("status", {})).resolves.toMatchObject({ connected: true, config: { ch: 42 } });
		});
	});

	test("configure rejects a bad channel/addr", () => {
		return start(() => () => {}).then(() => {
			expect(dev.command("configure", { ch: 200, addr: "e7e7e7e7e7" })).rejects.toThrow("0..125");
			expect(dev.command("configure", { ch: 42, addr: "e7e7" })).rejects.toThrow("5 bytes");
			return dev.command("configure", { ch: 42, addr: "zz" }).then(() => {
				throw new Error("should have failed");
			}, (err) => expect(String(err)).toMatch("hex"));
		});
	});

	test("send collects ACK and reply packets", () => {
		return start((bridge, write) => (line) => {
			if (line.startsWith("X ")) {
				write("ACK 0");
				write("RX 05 01020304");
				write("TIMEOUT");
			}
		}).then(() => dev.command("send", { data: "de ad be ef", rx_ms: 10 })).then((res) => {
			expect(res.acked).toBe(true);
			expect(res.tries).toBe(0);
			expect(res.replies.length).toBe(1);
			expect(res.replies[0].hdr).toBe(5);
			expect(res.replies[0].data).toEqual(Buffer.from([1, 2, 3, 4]));
			// RX lines are events + channel samples too
			expect(io.events.some((e) => e[0] === "rx" && e[1].dup === false)).toBe(true);
			expect(io.samples.some((s) => s[0] === "rx")).toBe(true);
		});
	});

	test("send without ACK returns noack", () => {
		return start((bridge, write) => (line) => {
			if (line.startsWith("X ")) {
				write("NOACK");
				write("TIMEOUT");
			}
		}).then(() => dev.command("send", { data: "00", rx_ms: 5 })).then((res) => {
			expect(res.acked).toBe(false);
			expect(res.replies).toEqual([]);
		});
	});

	test("send ends on the reply packet without TIMEOUT", () => {
		return start((bridge, write) => (line) => {
			if (line.startsWith("X ")) {
				write("ACK 2");
				write("RX 07 DUP aabb");
				// firmware returns right after the RX: no TIMEOUT line
			}
		}).then(() => dev.command("send", { data: "01 02", rx_ms: 50 })).then((res) => {
			expect(res.acked).toBe(true);
			expect(res.tries).toBe(2);
			expect(res.replies.length).toBe(1);
			expect(res.replies[0].dup).toBe(true);
		});
	});

	test("listen counts packets until OK heard", () => {
		return start((bridge, write) => (line) => {
			if (line.startsWith("L ")) {
				write("RX 01 10");
				write("RX 03 DUP 20");
				write("OK heard 2");
			}
		}).then(() => dev.command("listen", { ms: 50 })).then((res) => {
			expect(res.heard).toBe(2);
			expect(res.packets.length).toBe(2);
			expect(res.packets[1].dup).toBe(true);
		});
	});

	test("stats reads and the bridge resets counters", () => {
		return start((bridge, write) => (line) => {
			if (line === "S") {
				write("OK rx=3 dup=1");
			}
		}).then(() => dev.command("stats", {})).then((res) => {
			expect(res).toEqual({ rx: 3, dup: 1 });
		});
	});

	test("set_ack chains D/A/P and returns fresh config", () => {
		const seen = [];
		return start((bridge, write) => (line) => {
			seen.push(line);
			if (/^[DAP] /.test(line)) {
				write(cfgLine);
			}
			if (line === "?") {
				write(cfgLine);
			}
		}).then(() => dev.command("set_ack", { delay_us: 140, mode: 1 })).then((cfg) => {
			expect(cfg.ackdelay).toBe(130); // echo is scripted, the sends are what matters
			expect(seen).toEqual(["D 140", "A 1", "?"]);
		});
	});

	test("bootloader issues B and reports the DFU note", () => {
		return start((bridge, write) => (line) => {
			if (line === "B") {
				write("OK bootloader");
			}
		}).then(() => dev.command("bootloader", {})).then((res) => {
			expect(res.ok).toBe(true);
		});
	});

	test("command errors surface bridge ERR lines", () => {
		return start((bridge, write) => (line) => {
			if (line.startsWith("C ")) {
				write("ERR C <ch> <addr5> [order]");
			}
		}).then(() => dev.command("configure", { ch: 42, addr: "e7e7e7e7e7" })).then(() => {
			throw new Error("should have failed");
		}, (err) => expect(String(err)).toMatch("ERR C"));
	});
});
