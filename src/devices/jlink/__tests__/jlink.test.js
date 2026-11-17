// J-Link driver against a fake JLinkExe: the exe option points at a node
// script that answers the interactive CLI protocol. Hardware-untested [HW].

const fs = require("fs");
const os = require("os");
const path = require("path");
const jlink = require("..");

const fakeIo = () => {
	const io = { id: "jl1", logs: [], statuses: [], blobs: {} };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	io.blob = (name, data) => {
		io.blobs[name] = data;
	};
	io.getBlob = (name) => io.blobs[name.replace(/^jl1_/, "")];
	return io;
};

// a fake JLinkExe: reads command lines, prints a response then the prompt
const makeStub = (handler) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-jlink-"));
	const exe = path.join(dir, "JLinkExe");
	fs.writeFileSync(exe, "#!/usr/bin/env node\n"
		+ "let buf = '';\n"
		+ "process.stdin.on('data', (d) => {\n"
		+ "\tbuf += d.toString();\n"
		+ "\tlet i;\n"
		+ "\twhile ((i = buf.indexOf('\\n')) !== -1) {\n"
		+ "\t\tconst cmd = buf.slice(0, i).trim();\n"
		+ "\t\tbuf = buf.slice(i + 1);\n"
		+ "\t\tif (!cmd) continue;\n"
		+ "\t\tconst out = (" + handler.toString() + ")(cmd);\n"
		+ "\t\tif (out) process.stdout.write(out + '\\n');\n"
		+ "\t\tprocess.stdout.write('J-Link>');\n"
		+ "\t}\n"
		+ "});\n"
		+ "process.stdout.write('SEGGER J-Link Commander V7.00\\nJ-Link>');\n");
	fs.chmodSync(exe, 0o755);
	return { exe: exe, dir: dir };
};

describe("jlink driver", () => {
	const drivers = [];
	const ioOf = [];
	const dirs = [];

	const make = (handler) => {
		const stub = makeStub(handler);
		dirs.push(stub.dir);
		const io = fakeIo();
		ioOf.push(io);
		const dev = jlink.create({ exe: stub.exe, device: "STM32F405RG" }, io);
		drivers.push(dev);
		return dev.start().then(() => dev);
	};

	afterEach(() => {
		return Promise.all(drivers.splice(0).map((d) => d.stop())).then(() => {
			dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
		});
	});

	test("connect/halt/resume/reset issue the right CLI commands", () => {
		let dev = null;
		let io = null;
		return make((cmd) => {
			// must be self-contained: the handler is inlined into the stub
			if (cmd === "halt") {
				return "PC = 080001F0";
			}
			return "";
		}).then((d) => {
			dev = d;
			io = ioOf[ioOf.length - 1];
			return dev.command("connect", {});
		}).then((r) => {
			expect(r.ok).toBe(true);
			return dev.command("halt", {});
		}).then((r) => {
			expect(r.ok).toBe(true);
			return dev.command("resume", {});
		}).then(() => dev.command("reset", {})).then(() => {
			expect(io.logs.filter((l) => l[0] === "tx").map((l) => l[1])).toEqual(["connect", "halt", "go", "r"]);
		});
	});

	test("read parses mem32 output into a blob", () => {
		return make((cmd) => {
			if (cmd.indexOf("mem32 0x20000000") === 0) {
				return "20000000 = 20000400 20000800 DEADBEEF 00000000";
			}
			return "";
		}).then((dev) => dev.command("read", { address: 0x20000000, count: 12 })).then((res) => {
			expect(res.bytes).toBe(12);
			expect(res.hex).toBe("0004002000080020efbeadde");
			expect(Array.from(ioOf[ioOf.length - 1].blobs.mem)).toEqual([0x00, 0x04, 0x00, 0x20, 0x00, 0x08, 0x00, 0x20, 0xef, 0xbe, 0xad, 0xde]);
		});
	});

	test("write packs words and checks for errors", () => {
		return make(() => "").then((dev) => dev.command("write", { address: 0x08000000, hex: "01 02 03 04 ff" })).then((res) => {
			expect(res).toEqual({ ok: true, bytes: 5 });
			const io = ioOf[ioOf.length - 1];
			expect(io.logs.filter((l) => l[0] === "tx").map((l) => l[1])).toContain("w4 0x8000000 0x04030201 0x000000ff");
		});
	});

	test("regs parses register lines", () => {
		return make((cmd) => {
			if (cmd === "regs") {
				return "R0 = 00000001\nR1 = 00000002\nSP = 20002000\nPC = 080001F0\nxPSR = 01000000";
			}
			return "";
		}).then((dev) => dev.command("regs", {})).then((res) => {
			expect(res.regs).toEqual({ R0: 1, R1: 2, SP: 0x20002000, PC: 0x080001f0, XPSR: 0x01000000 });
		});
	});

	test("program downloads a blob via loadfile", () => {
		const io = fakeIo();
		ioOf.push(io);
		io.blobs.fw = Buffer.from([1, 2, 3, 4, 5]);
		io.getBlob = (name) => io.blobs[name.replace(/^jl1_/, "")];
		const stub = makeStub(() => "");
		dirs.push(stub.dir);
		const dev = jlink.create({ exe: stub.exe, device: "X" }, io);
		drivers.push(dev);
		return dev.start().then(() => dev.command("program", { blob: "jl1_fw", address: 0x08000000 })).then((res) => {
			expect(res.ok).toBe(true);
			expect(io.logs.filter((l) => l[0] === "tx").map((l) => l[1]).some((c) => c.indexOf("loadfile ") === 0)).toBe(true);
		});
	});

	test("surface errors from the CLI", () => {
		return make((cmd) => {
			if (cmd === "halt") {
				return "ERROR: Could not halt the target";
			}
			return "";
		}).then((dev) => dev.command("halt", {})).then(() => {
			throw new Error("should have failed");
		}, (err) => {
			expect(String(err)).toMatch("halt failed");
		});
	});
});
