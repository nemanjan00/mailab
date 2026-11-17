// JTAGulator driver against a fake unit: a PTY pair (socat) with the test
// playing the interactive menu (banner, per-line replies, idle gaps).
// Hardware-untested: menu letters are best-effort [HW].

const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const jtagulator = require("..");

const hasSocat = spawnSync("sh", ["-c", "command -v socat"]).status === 0;

const fakeIo = () => {
	const io = { id: "jt", logs: [], statuses: [] };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	return io;
};

// PTY pair; the test writes the unit's side through a second socat (pipes,
// no blocking fd reads)
const openPair = () => new Promise((resolve, reject) => {
	const child = spawn("socat", ["-d", "-d", "pty,raw,echo=0", "pty,raw,echo=0"]);
	let out = "";
	child.stderr.on("data", (d) => {
		out += d.toString();
		const lines = out.split("\n").filter((l) => l.includes("PTY is"));
		if (lines.length >= 2) {
			resolve({
				socat: child,
				master: lines[0].match(/PTY is (\/dev\/pts\/\d+)/)[1],
				slave: lines[1].match(/PTY is (\/dev\/pts\/\d+)/)[1]
			});
		}
	});
	child.on("error", reject);
	setTimeout(() => reject(new Error("socat did not report PTYs: " + out)), 5000);
});

describe("jtagulator driver over a PTY pair", () => {
	if (!hasSocat) {
		test.skip("needs socat", () => {});
		return;
	}

	let socat = null;
	let unit = null;
	let dev = null;
	let io = null;
	let unitBuf = "";

	const startUnit = (slave, script) => {
		const child = spawn("socat", ["-", slave + ",raw,echo=0"]);
		const unit = { child: child };
		child.stdout.on("data", (data) => {
			unitBuf += data.toString("latin1");
			let i;
			while ((i = unitBuf.indexOf("\r\n")) !== -1 || (i = unitBuf.indexOf("\n")) !== -1) {
				const line = unitBuf.slice(0, i).replace(/^\r/, "");
				unitBuf = unitBuf.slice(i + 1);
				script(line.trim(), (text, delayMs) => {
					setTimeout(() => child.stdin.write(text), delayMs || 10);
				});
			}
		});
		unit.close = () => child.kill();
		return unit;
	};

	afterEach(() => {
		return Promise.resolve(dev && dev.stop()).then(() => {
			dev = null;
			if (unit) {
				unit.close();
				unit = null;
			}
			if (socat) {
				socat.kill();
				socat = null;
			}
		});
	});

	test("menu sends lines and returns the idle transcript", () => {
		return openPair().then((pair) => {
			socat = pair.socat;
			unit = startUnit(pair.slave, (line, reply) => {
				if (line === "V") {
					reply("\r\nCurrent target voltage: 3.27 V\r\n\r\n>");
				}
			});
			io = fakeIo();
			dev = jtagulator.create({ path: pair.master }, io);
			return dev.start().then(() => new Promise((r) => setTimeout(r, 300)));
		}).then(() => {
			return dev.command("menu", { lines: ["V"] });
		}).then((out) => {
			expect(out).toContain("Current target voltage");
			expect(out).toContain("3.27");
		});
	});

	test("voltage parses the readout", () => {
		return openPair().then((pair) => {
			socat = pair.socat;
			unit = startUnit(pair.slave, (line, reply) => {
				if (line === "V") {
					reply("\r\nCurrent target voltage: 1.80 V\r\n\r\n>");
				}
			});
			io = fakeIo();
			dev = jtagulator.create({ path: pair.master }, io);
			return dev.start().then(() => new Promise((r) => setTimeout(r, 300)));
		}).then(() => {
			return dev.command("voltage", {});
		}).then((r) => {
			expect(r.volts).toBe(1.8);
			expect(r.text).toContain("1.80");
		});
	});

	test("idcode_scan extracts 8-digit idcodes", () => {
		return openPair().then((pair) => {
			socat = pair.socat;
			unit = startUnit(pair.slave, (line, reply) => {
				if (line === "I") {
					reply("\r\nChannels to scan? >");
				} else if (/^\d+-\d+$/.test(line)) {
					reply("\r\nPossible IDCODE: 4ba00477\r\nPossible IDCODE: 0b900477\r\n\r\n>");
				}
			});
			io = fakeIo();
			dev = jtagulator.create({ path: pair.master }, io);
			return dev.start().then(() => new Promise((r) => setTimeout(r, 300)));
		}).then(() => {
			return dev.command("idcode_scan", { from: 1, to: 8 });
		}).then((r) => {
			expect(r.idcodes).toContain("4ba00477");
			expect(r.idcodes).toContain("0b900477");
		});
	});

	test("concurrent menu sessions are refused", () => {
		return openPair().then((pair) => {
			socat = pair.socat;
			unit = startUnit(pair.slave, () => {});
			io = fakeIo();
			dev = jtagulator.create({ path: pair.master }, io);
			return dev.start().then(() => new Promise((r) => setTimeout(r, 300)));
		}).then(() => {
			const first = dev.command("menu", { lines: ["X"] });
			return dev.command("menu", { lines: ["Y"] }).then(() => {
				throw new Error("should have failed");
			}, (err) => {
				expect(String(err)).toMatch("already running");
				return first.catch(() => null);
			});
		});
	});
});
