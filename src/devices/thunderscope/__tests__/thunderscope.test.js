// ThunderScope driver against a fake TS.NET: a control socket (SCPI-ish,
// raw 'C' mode request, 4-byte acks) and a data socket emitting one
// waveform frame in the libscopehal framing. Hardware-untested [HW].

const net = require("net");
const thunderscope = require("..");

const fakeIo = () => {
	const io = { id: "ts1", logs: [], statuses: [], traces: {} };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	io.trace = (name, data) => {
		io.traces[name] = data;
	};
	return io;
};

// one analog waveform frame: version 1, seq 7, 1 channel (0), 4 samples
const frame = () => {
	const parts = [];
	const head = Buffer.alloc(1 + 4 + 2 + 8 + 8 + 8);
	head[0] = 1;
	head.writeUInt32LE(7, 1);
	head.writeUInt16LE(1, 5);
	head.writeBigUInt64LE(1000n, 7);        // 1000 fs/sample = 1 ns
	head.writeBigInt64LE(2000n, 15);        // trigger at +2 ns
	head.writeDoubleLE(1000.0, 23);
	parts.push(head);
	parts.push(Buffer.from([0]));            // chnum 0
	const md = Buffer.alloc(4);
	md.writeUInt32LE(4, 0);                  // 4 samples
	parts.push(md);
	const cfg = Buffer.alloc(12);
	cfg.writeFloatLE(0.5, 0);                // scale
	cfg.writeFloatLE(0.1, 4);                // offset
	cfg.writeFloatLE(0, 8);                  // trigphase
	parts.push(cfg);
	parts.push(Buffer.from([0]));            // clipping
	parts.push(Buffer.from([2]));            // dataType i8
	parts.push(Buffer.from([0, 2, 254, 4])); // samples: 0,2,-2,4 -> y = x*0.5+0.1
	return Buffer.concat(parts);
};

const startFake = () => {
	const server = net.createServer();
	const state = { acks: [], modeC: false, queries: [] };
	let dataServer = null;
	const ready = new Promise((resolve, reject) => {
		server.on("connection", (sock) => {
			let buf = Buffer.alloc(0);
			sock.on("data", (d) => {
				buf = Buffer.concat([buf, d]);
				while (buf.length) {
					if (buf[0] === 0x43 && buf.length === 1) { // lone 'C'
						state.modeC = true;
						buf = buf.slice(1);
						continue;
					}
					if (state.modeC && buf.length >= 4 && buf.slice(0, 4).some((b) => b === 0)) {
						// 4-byte binary seq ack (real SCPI lines are printable)
						state.acks.push(buf.readUInt32LE(0));
						buf = buf.slice(4);
						continue;
					}
					const nl = buf.indexOf(0x0a);
					if (nl === -1) {
						break;
					}
					const line = buf.slice(0, nl).toString("latin1");
					buf = buf.slice(nl + 1);
					state.queries.push(line);
					if (line === "ACQ:RATE?") {
						sock.write("1000000000\n");
					}
				}
			});
		});
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			dataServer = net.createServer((sock) => {
				sock.on("error", () => {});
				sock.write(frame());
			});
			dataServer.listen(0, "127.0.0.1", () => {
				resolve({ port: port, dataPort: dataServer.address().port, state: state });
			});
		});
		server.on("error", reject);
	});
	return ready.then((fake) => ({ server: server, dataServer: dataServer, fake: fake }));
};

describe("thunderscope driver", () => {
	let env = null;
	let dev = null;
	let io = null;

	afterEach(() => {
		const d = dev;
		dev = null;
		return (d ? d.stop() : Promise.resolve()).then(() => {
			if (env) {
				env.server.close();
				env.dataServer.close();
				env = null;
			}
		});
	});

	const start = () => startFake().then((e) => {
		env = e;
		io = fakeIo();
		dev = thunderscope.create({ host: "127.0.0.1", port: e.fake.port, dataPort: e.fake.dataPort }, io);
		return dev.start();
	});

	test("connects both planes and requests credit mode", () => {
		return start().then(() => {
			expect(env.fake.state.modeC).toBe(true);
			expect(io.statuses.some((s) => s[0] === "running")).toBe(true);
		});
	});

	test("SCPI queries round-trip", () => {
		return start().then(() => {
			return dev.command("query", { command: "ACQ:RATE?" });
		}).then((r) => {
			expect(r.reply).toBe("1000000000");
			return dev.command("write", { command: "CHAN1:ON" });
		}).then((r) => {
			expect(r.ok).toBe(true);
			// writes are fire-and-forget: give the segment a tick to land
			return new Promise((resolve) => setTimeout(resolve, 150));
		}).then(() => {
			expect(env.fake.state.queries).toContain("CHAN1:ON");
		});
	});

	test("capture parses a waveform frame into a trace", () => {
		return start().then(() => {
			return dev.command("capture", { name: "wfm" });
		}).then((r) => {
			expect(r.seq).toBe(7);
			expect(r.channels).toBe(1);
			expect(r.points).toBe(4);
			const tr = io.traces.wfm;
			expect(tr.xUnit).toBe("s");
			expect(tr.yUnit).toBe("V");
			// y = sample * 0.5 + 0.1 for [0,2,-2,4]
			expect(tr.series[0].y.map((v) => Math.round(v * 100) / 100)).toEqual([0.1, 1.1, -0.9, 2.1]);
			// x = i*1ps - 2ps (fs_per_sample=1000 fs, trigger at 2000 fs)
			expect(tr.series[0].x.map((v) => Math.round(v * 1e12))).toEqual([-2, -1, 0, 1]);
			// the driver acked the waveform (fire-and-forget: wait for delivery)
			return new Promise((resolve) => setTimeout(resolve, 150));
		}).then(() => {
			expect(env.fake.state.acks).toContain(7);
		});
	});
});
