// NanoVNA driver against a fake unit: a PTY pair (socat) with the test
// playing the ch> shell. Hardware-untested [HW].

const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const nanovna = require("..");

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
	const io = { id: "vna1", logs: [], statuses: [] };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	io.trace = (name, data) => io.traces.push({ name: name, data: data });
	io.traces = [];
	return io;
};

// fake NanoVNA shell on the far end of a PTY pair: answers "ch> "-prompted
// commands with canned output
const fakeVna = (slave, handler) => {
	const child = spawn("socat", ["-", slave + ",raw,echo=0"]);
	const vna = { child: child, buf: "" };
	vna.handler = handler(vna, (text) => vna.child.stdin.write(text));
	child.stdout.on("data", (data) => {
		vna.buf += data.toString("latin1");
		let i;
		while ((i = vna.buf.indexOf("\n")) !== -1) {
			const line = vna.buf.slice(0, i).replace(/\r$/, "");
			vna.buf = vna.buf.slice(i + 1);
			if (line.trim()) {
				vna.handler(line.trim());
			}
		}
	});
	vna.close = () => {
		vna.child.kill();
	};
	return vna;
};

describe("nanovna driver over a PTY pair", () => {
	if (!hasSocat) {
		test.skip("needs socat", () => {});
		return;
	}

	let socat = null;
	let dev = null;
	let io = null;
	let vna = null;

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
				if (vna) {
					vna.close();
					vna = null;
				}
				if (socat) {
					socat.kill();
					socat = null;
				}
			});
		}
		if (vna) {
			vna.close();
			vna = null;
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
		vna = fakeVna(pair.slave, handler);
		dev = nanovna.create({ path: pair.master }, io);
		return dev.start().then(() => waitFor(() => io.statuses.some((s) => s[0] === "running"), 3000));
	});

	// a basic fake shell: info/cal/sweep/scan/data with canned answers
	const shellHandler = (vna, write) => {
		const lines = {
			info: ["NanoVNA-H 1.2.3", "board: nanoVNA-H"],
			cal: ["calibration: off"]
		};
		return (line) => {
			const parts = line.split(" ");
			if (lines[line]) {
				write(lines[line].concat(["ch> "]).join("\n") + "\n");
				return;
			}
			if (line.startsWith("scan")) {
				const n = parseInt(parts[3], 10) || 3;
				const out = [];
				for (let i = 0; i < n; i++) {
					// S11 (data 0) then S21 (data 1) are fetched separately;
					// scan just sweeps
					out.push("ok");
				}
				write(out.join("\n") + "\nch> \n");
				return;
			}
			if (line.startsWith("data 0")) {
				write("0.5 0.1\n0.4 0.2\n0.3 0.3\nch> \n");
				return;
			}
			if (line.startsWith("data 1")) {
				write("0.8 0.0\n0.7 0.1\n0.6 0.2\nch> \n");
				return;
			}
			if (line.startsWith("sweep")) {
				write("ch> \n");
				return;
			}
			write("ch> \n");
		};
	};

	test("info and cal query the shell", () => {
		return start(shellHandler).then(() => dev.command("info", {})).then((r) => {
			expect(r.version).toBe("NanoVNA-H 1.2.3");
			expect(r.lines).toContain("board: nanoVNA-H");
			return dev.command("cal", {});
		}).then((r) => {
			expect(r.calibrated).toBe(false);
		});
	});

	test("sweep programs the plan", () => {
		return start(shellHandler).then(() => dev.command("sweep", { start: 1e6, stop: 100e6, points: 201 })).then((r) => {
			expect(r).toEqual({ start: 1e6, stop: 100e6, points: 201 });
		});
	});

	test("scan publishes S11/S21 traces with logmag + phase", () => {
		return start(shellHandler).then(() => {
			return dev.command("sweep", { start: 100e6, stop: 200e6, points: 3 });
		}).then(() => dev.command("scan", {})).then((r) => {
			expect(r.points).toBe(3);
			expect(r.traces).toEqual(["s11", "s21"]);
			const s11 = io.traces.find((t) => t.name === "s11");
			expect(s11.data.x).toEqual([100, 150, 200]);
			expect(s11.data.xUnit).toBe("MHz");
			expect(s11.data.series.map((s) => s.label)).toEqual(["S11 dB", "S11 phase"]);
			// |0.5+0.1i| -> 10*log10(0.26) ~= -5.85 dB
			expect(s11.data.series[0].y[0]).toBeCloseTo(-5.85, 1);
			expect(s11.data.series[1].y[0]).toBeCloseTo(11.3, 0);
		});
	});

	test("data returns raw complex pairs", () => {
		return start(shellHandler).then(() => dev.command("data", { channel: 0 })).then((r) => {
			expect(r.channel).toBe(0);
			expect(r.points).toBe(3);
			expect(r.re[0]).toBeCloseTo(0.5, 6);
			expect(r.im[2]).toBeCloseTo(0.3, 6);
		});
	});
});
