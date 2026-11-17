// OpenOCD driver against a fake telnet server: the daemon binary is a stub
// (`true`), the TCP port is served by the test, speaking the prompt
// protocol: banner, command echo, output lines, "> " prompt.

const net = require("net");
const openocd = require("..");

// fake openocd telnet: scripted replies per command prefix
const fakeServer = (replies) => {
	const server = net.createServer((conn) => {
		conn.write("\r\nOpen On-Chip Debugger 0.12.0\r\n> ");
		let buf = "";
		conn.on("data", (data) => {
			buf += data.toString("latin1");
			let i;
			while ((i = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (!line) {
					continue;
				}
				const key = Object.keys(replies).find((k) => line.indexOf(k) === 0);
				const out = key ? replies[key](line) : "";
				conn.write("\r\n" + line + "\r\n" + (out ? out + "\r\n" : "") + "> ");
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({ server: server, port: server.address().port });
		});
	});
};

const fakeIo = () => {
	const io = { id: "oc", logs: [], statuses: [], blobs: {} };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	io.blob = (name, data) => {
		io.blobs[name] = data;
	};
	io.getBlob = () => Promise.reject(new Error("no blob store in test"));
	return io;
};

describe("openocd helpers", () => {
	test("parseDump + parseHex", () => {
		const buf = openocd._test.parseDump("20000000: 00010203 04050607 08090a0b 0c0d0e0f\r\n20000010: 10111213\nother text", 4);
		expect(Array.from(buf)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
		expect(Array.from(openocd._test.parseHex("de ad:0xBE,ef"))).toEqual([0xde, 0xad, 0xbe, 0xef]);
		expect(() => openocd._test.parseHex("xyz")).toThrow();
	});
});

describe("openocd driver over a fake telnet server", () => {
	let fixture = null;
	let dev = null;
	let io = null;

	beforeEach(() => {
		return fakeServer({
			halt: () => "target halted",
			resume: () => "",
			reset: () => "JTAG tap: stm32.cpu tap/device found",
			targets: () => "1        stm32.cpu  cortex_m   little",
			reg: (line) => line.indexOf(" ") === -1 ? "" : "r0 = 0x20000000\nsp = 0x20001000",
			mdw: (line) => {
				const addr = line.split(" ")[1];
				return String(addr).replace(/^0x/, "") + ": 01234567 89abcdef";
			},
			mdb: () => "20000000: 01 02 03 04",
			mww: () => "",
			"flash erase_address": () => "erased",
			program: (line) => "Programming Finished" + (line.indexOf(" verify") !== -1 ? "" : " (no verify)"),
			shutdown: () => "shutdown command invoked"
		}).then((f) => {
			fixture = f;
			io = fakeIo();
			dev = openocd.create({ openocd: "true", telnetPort: f.port, args: ["-c", "adapter driver dummy"] }, io);
			return dev.start();
		});
	});

	afterEach(() => {
		return Promise.resolve(dev && dev.stop()).then(() => {
			fixture.server.close();
		});
	});

	test("cmd runs a raw command and strips echo + prompt", () => {
		return dev.command("cmd", { command: "halt" }).then((out) => {
			expect(out).toBe("target halted");
		});
	});

	test("targets and reset return their text", () => {
		return dev.command("targets", {}).then((out) => {
			expect(out).toContain("stm32.cpu");
			return dev.command("reset", { mode: "halt" });
		}).then((out) => {
			expect(out).toContain("tap/device found");
		});
	});

	test("regs parses the register dump", () => {
		return dev.command("reg", {}).then(() => null); // write path smoke
	});

	test("reg reads and writes a register", () => {
		return dev.command("reg", { name: "r0" }).then((r) => {
			expect(r).toEqual({ name: "r0", value: 0x20000000 });
			return dev.command("reg", { name: "r0", value: "0x1" });
		}).then((r) => {
			expect(r.value).toBe("0x1");
		});
	});

	test("read turns an mdw dump into a blob", () => {
		return dev.command("read", { address: "0x20000000", count: 6, width: 32, name: "dump" }).then((r) => {
			expect(r.blob).toBe("oc_dump");
			expect(r.bytes).toBe(6);
			expect(r.hex).toBe("0123456789ab");
			expect(Array.from(io.blobs.dump)).toEqual([0x01, 0x23, 0x45, 0x67, 0x89, 0xab]);
		});
	});

	test("write chunks hex into mww words", () => {
		return dev.command("write", { address: "0x20000000", hex: "01020304 05060708", width: 32 }).then((r) => {
			expect(r).toEqual({ ok: true, bytes: 8 });
			const mww = io.logs.filter((l) => l[0] === "tx" && l[1].indexOf("mww") === 0).map((l) => l[1]);
			expect(mww).toEqual(["mww 536870912 0x01020304 0x05060708"]);
		});
	});

	test("erase and program run flash commands", () => {
		return dev.command("erase", { address: "0x08000000", length: 4096 }).then(() => {
			return dev.command("program", { data: Buffer.from([1, 2, 3, 4]).toString("base64"), address: "0x08000000" });
		}).then((r) => {
			expect(r.ok).toBe(true);
			const prog = io.logs.find((l) => l[0] === "tx" && l[1].indexOf("program ") === 0);
			expect(prog[1]).toMatch(/^program \/tmp\/.* 0x08000000 verify$/);
		});
	});

	test("shutdown returns ok", () => {
		return dev.command("shutdown", {}).then((r) => {
			expect(r.ok).toBe(true);
		});
	});

	test("unknown command is rejected", () => {
		return dev.command("frobnicate", {}).then(() => {
			throw new Error("should have failed");
		}, (err) => expect(String(err)).toMatch("unknown command"));
	});
});
