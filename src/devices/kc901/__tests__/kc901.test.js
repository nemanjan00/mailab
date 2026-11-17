// KC901K (DeepAce framing) driver against a fake analyzer: a PTY pair
// (socat) with the test answering framed requests. Wire format unverified
// on hardware — no analyzer attached; built from the kc9531b vendor package.

const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const kc901 = require("..");
const deepace = require("../../../services/deepace");

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
	const io = { id: "kc1", logs: [], statuses: [], traces: [] };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	io.trace = (name, data) => io.traces.push([name, data]);
	return io;
};

// fake DeepAce analyzer on the far end of the PTY pair: answers framed
// requests via a second socat (stdio <-> pty), so the test talks pipes
const fakeAnalyzer = (slave, handler) => {
	const child = spawn("socat", ["-", slave + ",raw,echo=0"]);
	const dev = { child: child, buf: Buffer.alloc(0) };
	child.stdout.on("data", (data) => {
		dev.buf = Buffer.concat([dev.buf, data]);
		for (;;) {
			const head = dev.buf.indexOf(deepace.OUT_MAGIC);
			if (head === -1) {
				dev.buf = Buffer.alloc(0);
				return;
			}
			if (head > 0) {
				dev.buf = dev.buf.slice(head);
			}
			if (dev.buf.length < 5) {
				return;
			}
			const size = dev.buf.readUInt16LE(3);
			const total = 5 + size + 2;
			if (dev.buf.length < total) {
				return;
			}
			const frame = dev.buf.slice(0, total);
			dev.buf = dev.buf.slice(total);
			const sum = deepace.checksum(frame.slice(0, 5 + size));
			if (frame.readUInt16LE(5 + size) !== sum) {
				continue;
			}
			handler(frame[2], frame.slice(5, 5 + size), (body, ok) => {
				const reply = deepace.buildReply(frame[2], ok === false ? 0 : 1, body || Buffer.alloc(0));
				child.stdin.write(reply);
			});
		}
	});
	dev.close = () => child.kill();
	return dev;
};

describe("kc901 driver over a PTY pair", () => {
	if (!hasSocat) {
		test.skip("needs socat", () => {});
		return;
	}

	let socat = null;
	let dev = null;
	let io = null;
	let rig = null;

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

	afterEach(() => {
		const stop = dev ? dev.stop() : Promise.resolve();
		dev = null;
		return stop.then(() => {
			if (rig) {
				rig.close();
				rig = null;
			}
			if (socat) {
				socat.kill();
				socat = null;
			}
		});
	});

	const start = (handler) => openPair().then((pair) => {
		socat = pair.socat;
		io = fakeIo();
		rig = fakeAnalyzer(pair.slave, handler);
		dev = kc901.create({ path: pair.master }, io);
		return dev.start().then(() => waitFor(() => io.statuses.some((s) => s[0] === "running"), 3000));
	});

	test("request returns the reply body as hex", () => {
		return start((code, payload, reply) => {
			reply(Buffer.concat([Buffer.from([0x77]), payload]));
		}).then(() => dev.command("request", { hex: "de ad" })).then((res) => {
			expect(res.ok).toBe(true);
			expect(res.hex).toBe("77dead");
		});
	});

	test("device-side error (status 0) rejects", () => {
		return start((code, payload, reply) => {
			reply(Buffer.from([0]), false);
		}).then(() => dev.command("request", { hex: "01" })).then(() => {
			throw new Error("should have failed");
		}, (err) => expect(String(err)).toMatch("rejected"));
	});

	test("timeout when the analyzer stays silent", () => {
		return start(() => {}).then(() => dev.command("request", { hex: "01", timeoutMs: 300 })).then(() => {
			throw new Error("should have failed");
		}, (err) => expect(String(err)).toMatch("timeout"));
	});

	test("trace_f32 decodes a float sweep into a trace", () => {
		const body = Buffer.alloc(16);
		[1.5, -2.25, 3, 4.5].forEach((v, i) => body.writeFloatLE(v, i * 4));
		return start((code, payload, reply) => {
			reply(body);
		}).then(() => dev.command("trace_f32", { hex: "00", startHz: 100e6, stepHz: 25e3, unit: "dBm", name: "sa" })).then((res) => {
			expect(res.trace).toBe("sa");
			expect(res.points).toBe(4);
			expect(io.traces.length).toBe(1);
			const data = io.traces[0][1];
			expect(data.y).toEqual([1.5, -2.25, 3, 4.5]);
			expect(data.x).toEqual([100e6, 100e6 + 25e3, 100e6 + 50e3, 100e6 + 75e3]);
			expect(data.xUnit).toBe("Hz");
			expect(data.yUnit).toBe("dBm");
		});
	});

	test("trace_f32 refuses a non-multiple-of-4 body", () => {
		return start((code, payload, reply) => {
			reply(Buffer.from([1, 2, 3]));
		}).then(() => dev.command("trace_f32", { hex: "00" })).then(() => {
			throw new Error("should have failed");
		}, (err) => expect(String(err)).toMatch("float32"));
	});

	test("bad hex is rejected before any SCPI", () => {
		return start(() => {}).then(() => dev.command("request", { hex: "xyz" })).then(() => {
			throw new Error("should have failed");
		}, (err) => expect(String(err)).toMatch("hex"));
	});
});
