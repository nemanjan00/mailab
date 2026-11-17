// BMP driver against a fake probe: a PTY pair (socat) with the test playing
// a GDB RSP server. Hardware-untested: written against the BMP RSP docs [HW].

const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const bmp = require("..");

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
	const io = { id: "bmp1", logs: [], statuses: [], blobs: {} };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	io.blob = (name, data) => {
		io.blobs[name] = data;
	};
	return io;
};

const hexToText = (hex) => {
	let out = "";
	for (let i = 0; i + 2 <= hex.length; i += 2) {
		out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
	}
	return out;
};
const textToHex = (text) => Buffer.from(text, "latin1").toString("hex");
const rsp = (payload) => "$" + payload + "#" + (checksum(payload)).toString(16).padStart(2, "0");
const checksum = (payload) => {
	let sum = 0;
	for (let i = 0; i < payload.length; i++) {
		sum = (sum + payload.charCodeAt(i)) % 256;
	}
	return sum;
};

// fake RSP server on the far end of a socat PTY pair
const fakeProbe = (slave, script) => {
	const child = spawn("socat", ["-", slave + ",raw,echo=0"]);
	const probe = { child: child, buf: "" };
	const write = (payload) => probe.child.stdin.write(rsp(payload) + "+");
	probe.handler = script(probe, write, hexToText);
	child.stdout.on("data", (data) => {
		probe.buf += data.toString("latin1");
		// a bare Ctrl-C interrupt is not a packet
		const ictrl = probe.buf.indexOf("\u0003");
		if (ictrl !== -1) {
			probe.buf = probe.buf.slice(0, ictrl) + probe.buf.slice(ictrl + 1);
			probe.handler("__INTERRUPT__");
		}
		for (;;) {
			const dollar = probe.buf.indexOf("$");
			if (dollar === -1) {
				probe.buf = probe.buf.slice(-1); // keep a stray "-" maybe
				return;
			}
			if (probe.buf.length < dollar + 4) {
				probe.buf = probe.buf.slice(dollar);
				return;
			}
			const hash = probe.buf.indexOf("#", dollar);
			if (hash === -1 || probe.buf.length < hash + 3) {
				probe.buf = probe.buf.slice(dollar);
				return;
			}
			const payload = probe.buf.slice(dollar + 1, hash);
			probe.buf = probe.buf.slice(hash + 3);
			probe.handler(payload);
		}
	});
	probe.close = () => probe.child.kill();
	return probe;
};

describe("bmp driver over a PTY pair", () => {
	if (!hasSocat) {
		test.skip("needs socat", () => {});
		return;
	}

	let socat = null;
	let dev = null;
	let io = null;
	let probe = null;

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
		setTimeout(() => reject(new Error("socat did not report PTYs")), 5000);
	});

	afterEach(() => {
		if (dev) {
			return dev.stop().then(() => {
				dev = null;
				if (probe) {
					probe.close();
					probe = null;
				}
				if (socat) {
					socat.kill();
					socat = null;
				}
			});
		}
		if (probe) {
			probe.close();
			probe = null;
		}
		if (socat) {
			socat.kill();
			socat = null;
		}
		return undefined;
	});

	const start = (script) => openPair().then((pair) => {
		socat = pair.socat;
		io = fakeIo();
		probe = fakeProbe(pair.slave, script);
		dev = bmp.create({ path: pair.master }, io);
		return dev.start().then(() => waitFor(() => io.statuses.some((s) => s[0] === "running"), 3000));
	});

	test("monitor decodes qRcmd output records", () => {
		return start((probe, write, fromHex) => (payload) => {
			if (payload.indexOf("qRcmd,") === 0) {
				const text = fromHex(payload.slice(6));
				if (text === "swdp_scan") {
					write("O" + textToHex("Target voltage: 3.3V\n"));
					write("O" + textToHex("Available targets:\n 1   STM32F4\n"));
					write("OK");
				}
			}
		}).then(() => dev.command("scan_swd", {})).then((res) => {
			expect(res.ok).toBe(true);
			expect(io.logs.some((l) => l[1].indexOf("STM32F4") !== -1)).toBe(true);
		});
	});

	test("read returns memory as a blob", () => {
		return start((probe, write) => (payload) => {
			if (payload === "m20000000,4") {
				write("deadbeef");
			}
		}).then(() => dev.command("read", { address: 0x20000000, count: 4 })).then((res) => {
			expect(res.hex).toBe("deadbeef");
			expect(Array.from(io.blobs.mem)).toEqual([0xde, 0xad, 0xbe, 0xef]);
		});
	});

	test("write chunks and checks OK", () => {
		const got = [];
		return start((probe, write) => (payload) => {
			if (payload[0] === "M") {
				const m = /^M([0-9a-f]+),([0-9a-f]+):([0-9a-f]+)$/.exec(payload);
				got.push([parseInt(m[1], 16), Buffer.from(m[3], "hex")]);
				write("OK");
			}
		}).then(() => dev.command("write", { address: 0x08000000, hex: "00 01 02 03" })).then((res) => {
			expect(res).toEqual({ ok: true, bytes: 4 });
			expect(got.length).toBe(1);
			expect(got[0][0]).toBe(0x08000000);
			expect(Array.from(got[0][1])).toEqual([0, 1, 2, 3]);
		});
	});

	test("regs parses 32-bit words from g", () => {
		return start((probe, write) => (payload) => {
			if (payload === "g") {
				write("0000000520000000"); // r0=5, sp=0x20000000
			}
		}).then(() => dev.command("regs", {})).then((res) => {
			expect(res.regs).toEqual([5, 0x20000000]);
		});
	});

	test("halt catches the interrupt stop record", () => {
		return start((probe, write) => (payload) => {
			if (payload === "__INTERRUPT__") {
				setTimeout(() => write("T05"), 50);
			}
		}).then(() => dev.command("halt", {})).then((res) => {
			expect(res.stopped).toBe(true);
			expect(res.reason).toBe("T05");
		});
	});

	test("reset and attach go through the monitor", () => {
		const seen = [];
		return start((probe, write, fromHex) => (payload) => {
			if (payload.indexOf("qRcmd,") === 0) {
				seen.push(fromHex(payload.slice(6)));
				write("OK");
			}
		}).then(() => dev.command("reset", {})).then(() => dev.command("attach", { n: 2 })).then(() => {
			expect(seen).toEqual(["r", "attach 2"]);
		});
	});
});
