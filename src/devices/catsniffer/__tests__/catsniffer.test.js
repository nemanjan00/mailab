// CatSniffer driver against a fake bridge: the sniff bridge is a node
// script emitting canned packet lines; flash uses a fake flasher.
// Hardware-untested [HW].

const fs = require("fs");
const os = require("os");
const path = require("path");
const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const catsniffer = require("..");

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
	const io = { id: "cs1", logs: [], statuses: [], samples: [], events: [], blobs: {} };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	io.sample = (field, value, meta) => io.samples.push([field, value, meta]);
	io.event = (name, data) => io.events.push([name, data]);
	io.blob = (name, data) => {
		io.blobs[name] = Buffer.from(data);
	};
	io.getBlob = (name) => io.blobs[name.replace(/^cs1_/, "")];
	return io;
};

// fake bridge binary: prints canned packet lines, then idles
const makeBridge = (lines) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-bridge-"));
	const exe = path.join(dir, "bridge");
	fs.writeFileSync(exe, "#!/usr/bin/env node\n"
		+ "const lines = " + JSON.stringify(lines) + ";\n"
		+ "let i = 0;\n"
		+ "const t = setInterval(() => {\n"
		+ "\tif (i >= lines.length) { clearInterval(t); return; }\n"
		+ "\tprocess.stdout.write(lines[i++] + '\\n');\n"
		+ "}, 30);\n");
	fs.chmodSync(exe, 0o755);
	return exe;
};

// fake flasher: writes a marker file so the test can verify args
const makeFlasher = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-flasher-"));
	const marker = path.join(dir, "args.txt");
	const exe = path.join(dir, "flasher");
	fs.writeFileSync(exe, "#!/usr/bin/env node\n"
		+ "require('fs').writeFileSync(" + JSON.stringify(marker) + ", process.argv.slice(2).join(' '));\n"
		+ "process.stdout.write('CC1352P7 detected\\nVerifying flash... OK\\n');\n");
	fs.chmodSync(exe, 0o755);
	return { exe: exe, marker: marker, dir: dir };
};

describe("catsniffer driver", () => {
	if (!hasSocat) {
		test.skip("needs socat", () => {});
		return;
	}

	let socat = null;
	let dev = null;
	let io = null;
	const dirs = [];

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
		const d = dev;
		dev = null;
		return (d ? d.stop() : Promise.resolve()).then(() => {
			if (socat) {
				socat.kill();
				socat = null;
			}
			dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
		});
	});

	const start = (options) => openPair().then((pair) => {
		socat = pair.socat;
		io = fakeIo();
		dev = catsniffer.create(Object.assign({ path: pair.master }, options || {}), io);
		return dev.start().then(() => waitFor(() => io.statuses.some((s) => s[0] === "running"), 3000));
	});

	test("sniff bridge: packets -> events, rssi channel, pcap blob", () => {
		const bridge = makeBridge([
			"JSON {\"ts\": 1700000000000, \"rssi\": -42, \"hex\": \"aabbcc\"}",
			"HEX deadbeef -87",
			"not a packet line"
		]);
		dirs.push(path.dirname(bridge));
		return start({ bridge: bridge }).then(() => {
			return dev.command("sniff", {});
		}).then((r) => {
			expect(r.sniffing).toBe(true);
			return waitFor(() => io.events.length >= 2, 3000);
		}).then(() => {
			return dev.command("sniff", { on: false });
		}).then((r) => {
			expect(r.sniffing).toBe(false);
			expect(r.packets).toBe(2);
			expect(io.events[0][1].hex).toBe("aabbcc");
			expect(io.events[0][1].rssi).toBe(-42);
			expect(io.events[1][1].rssi).toBe(-87);
			expect(io.samples.some((s) => s[0] === "rssi" && s[1] === -42)).toBe(true);
			// pcap blob: header + 2 records
			const pcap = io.blobs.capture;
			expect(pcap.readUInt32LE(0)).toBe(0xa1b2c3d4);
			expect(pcap.readUInt32LE(20)).toBe(195);
			expect(pcap.length).toBe(24 + (16 + 3) + (16 + 4));
		});
	});

	test("flash writes firmware through the flasher", () => {
		const flasher = makeFlasher();
		dirs.push(flasher.dir);
		return start({ flasher: flasher.exe, flasherArgs: [] }).then(() => {
			io.blobs.fw = Buffer.from([1, 2, 3, 4]);
			return dev.command("flash", { blob: "cs1_fw" });
		}).then((r) => {
			expect(r.ok).toBe(true);
			const args = fs.readFileSync(flasher.marker, "utf8");
			expect(args).toMatch(/-e -w \S+firmware\.bin -r/);
			expect(args).toMatch(/-p \/dev\/pts\/\d+/);
		});
	});

	test("write_hex sends raw bytes", () => {
		return start().then(() => {
			return dev.command("write_hex", { hex: "de ad be ef" });
		}).then((r) => {
			expect(r).toEqual({ ok: true, bytes: 4 });
			expect(dev.command("write_hex", { hex: "zz" })).rejects.toThrow("hex");
		});
	});
});
