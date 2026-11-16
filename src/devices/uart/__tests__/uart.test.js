const fs = require("fs");
const os = require("os");
const path = require("path");
const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const uart = require("..");
const tty = require("../../../services/tty");

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
	const io = { id: "u", logs: [], blobs: {}, statuses: [], options: {} };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = (state, detail) => io.statuses.push([state, detail]);
	io.blob = (name, data) => {
		io.blobs[name] = data;
	};
	io.setOptions = (o) => Object.assign(io.options, o);
	io.sample = () => null;
	return io;
};

describe("uart helpers", () => {
	test("ansi, hex, lines, stty format", () => {
		expect(uart._test.stripAnsi("\x1b[1;31mERR\x1b[0m x")).toBe("ERR x");
		expect(uart._test.parseHex("de ad:BE,ef 0x01")).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01]));
		expect(() => uart._test.parseHex("abc")).toThrow();
		expect(uart._test.splitLines("a\r\nb\rc\nrest")).toEqual({ lines: ["a", "b", "c"], rest: "rest" });
		expect(tty.sttyArgs({ baud: 9600, format: "7E1" })).toEqual(["9600", "cs7", "parenb", "-parodd", "-cstopb", "-crtscts", "-ixon", "-ixoff"]);
		expect(tty.sttyArgs({ format: "8O2", flow: "rtscts" }).slice(1, 5)).toEqual(["cs8", "parenb", "parodd", "cstopb"]);
		expect(() => tty.sttyArgs({ format: "9X1" })).toThrow();
		expect(() => tty.sttyArgs({ baud: "fast" })).toThrow();
	});

	test("waits for a missing adapter instead of failing", () => {
		const io = fakeIo();
		const dev = uart.create({ match: { vid: "ffff", pid: "ffff", serial: "nope" } }, io);
		return dev.start().then(() => {
			expect(io.statuses[0][0]).toBe("waiting");
			return dev.stop();
		});
	});
});

(hasSocat ? describe : describe.skip)("uart over a pty pair", () => {
	let socat;
	let dir;
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-uart-"));
		socat = spawn("socat", ["pty,raw,echo=0,link=" + path.join(dir, "a"), "pty,raw,echo=0,link=" + path.join(dir, "b")]);
		return waitFor(() => fs.existsSync(path.join(dir, "a")) && fs.existsSync(path.join(dir, "b")), 3000);
	});
	afterAll(() => {
		socat.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("lines, partial prompt, write, query, hex, capture, set", () => {
		const io = fakeIo();
		const dev = uart.create({ path: path.join(dir, "a"), baud: 115200 }, io);
		const other = tty.open(path.join(dir, "b"), { baud: 115200 });
		let peer = "";
		other.on("data", (d) => {
			peer += d.toString("latin1");
		});
		const rx = () => io.logs.filter((l) => l[0] === "rx").map((l) => l[1]);
		return dev.start()
			.then(() => dev.command("capture_start", {}))
			.then(() => {
				other.write("U-Boot 2024\r\n\x1b[32mok\x1b[0m\nlogin: ");
				// the prompt has no newline: flushed after idle
				return waitFor(() => rx().indexOf("login: ") !== -1, 2000);
			})
			.then(() => {
				expect(rx()).toEqual(["U-Boot 2024", "ok", "login: "]);
				return dev.command("write", { text: "root", eol: "crlf" });
			})
			.then(() => waitFor(() => peer === "root\r\n", 2000))
			.then(() => {
				const q = dev.command("query", { text: "uname", until: "^Linux", timeoutMs: 2000 });
				setTimeout(() => other.write("noise\nLinux box 6.1\n"), 50);
				return q;
			})
			.then((r) => {
				expect(r.matched).toBe(true);
				expect(r.lines).toEqual(["noise", "Linux box 6.1"]);
				return dev.command("write_hex", { hex: "01 02 ff" });
			})
			.then(() => waitFor(() => peer.endsWith("\x01\x02\xff"), 2000))
			.then(() => dev.command("capture_stop", { name: "boot" }))
			.then((r) => {
				expect(io.blobs.boot.toString("latin1")).toContain("U-Boot 2024");
				expect(r.bytes).toBe(io.blobs.boot.length);
				return dev.command("set", { baud: 9600, display: "hex" });
			})
			.then((s) => {
				expect(s.baud).toBe(9600);
				expect(io.options.baud).toBe(9600);
				other.write(Buffer.from([0xaa, 0x55]));
				return waitFor(() => rx().indexOf("aa 55") !== -1, 2000);
			})
			.then(() => expect(dev.command("set", { format: "bogus" })).rejects.toThrow())
			.then(() => {
				other.close();
				return dev.stop();
			});
	});
});
