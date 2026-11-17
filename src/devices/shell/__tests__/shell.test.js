// PTY sessions as a lab device: output pushes (term + log + notification),
// raw writes from a web terminal, kill, and per-session scrollback through
// the lab. No hardware: sessions run `sh -c` snippets under util-linux
// `script` (a real pty, same as bash/gdb/openocd would get).

const fs = require("fs");
const os = require("os");
const path = require("path");

const shell = require("../index");

const driver = () => {
	const io = { term: jest.fn(), log: jest.fn(), status: jest.fn(), notify: jest.fn() };
	const dev = shell.create({}, io);
	return { io: io, dev: dev };
};

const waitFor = (fn, timeoutMs) => new Promise((resolve, reject) => {
	const t0 = Date.now();
	const tick = () => {
		let value;
		try {
			value = fn();
		} catch (err) {
			reject(err);
			return;
		}
		if (value) {
			resolve(value);
		} else if (Date.now() - t0 > timeoutMs) {
			reject(new Error("timeout waiting for condition"));
		} else {
			setTimeout(tick, 25);
		}
	};
	tick();
});

const termText = (io, session) => Buffer.concat(
	io.term.mock.calls
		.filter((call) => call[1] === session)
		.map((call) => call[0])
).toString("latin1");

describe("shell device", () => {
	test("stripAnsi removes CSI/OSC but keeps text", () => {
		const ESC = String.fromCharCode(27);
		expect(shell._test.stripAnsi(ESC + "[1;31mred" + ESC + "[0m plain")).toBe("red plain");
		expect(shell._test.stripAnsi(ESC + "]0;title" + String.fromCharCode(7) + "body")).toBe("body");
	});

	test("splitLines keeps the partial line", () => {
		const split = shell._test.splitLines("one\r\ntwo\nth");
		expect(split.lines).toEqual(["one", "two"]);
		expect(split.rest).toBe("th");
	});

	test("session_start runs the command: output -> term (per session) and log lines", async () => {
		const { io, dev } = driver();
		await dev.start();
		const started = dev.command("session_start", { cmd: "echo hello-from-pty" });
		expect(started.name).toBe("s1");
		expect(started.pty).toBe(true);
		await waitFor(() => termText(io, "s1").includes("hello-from-pty"), 5000);
		// the log gets the ANSI-stripped line for the AI
		await waitFor(() => io.log.mock.calls.some((call) => call[0] === "[s1] hello-from-pty" && call[1] === "rx"), 5000);
		await waitFor(() => io.notify.mock.calls.some((call) => call[0].event === "exit" && call[0].session === "s1"), 5000);
		await dev.stop();
	}, 15000);

	test("write sends a line; pty echoes it back", async () => {
		const { io, dev } = driver();
		await dev.start();
		dev.command("session_start", { cmd: "cat", name: "tty" });
		await waitFor(() => dev.command("session_list", {}).sessions[0].running, 5000);
		await new Promise((resolve) => setTimeout(resolve, 300)); // script execs cat
		dev.command("write", { session: "tty", text: "echo back-at-me" });
		await waitFor(() => termText(io, "tty").includes("back-at-me"), 5000);
		// tx line logged for the AI
		expect(io.log.mock.calls.some((call) => call[0] === "[tty] > echo back-at-me" && call[1] === "tx")).toBe(true);
		dev.command("session_kill", { session: "tty" });
		await dev.stop();
	}, 15000);

	test("write_raw sends base64 keystrokes without a tx log line", async () => {
		const { io, dev } = driver();
		await dev.start();
		dev.command("session_start", { cmd: "cat", name: "raw" });
		await waitFor(() => dev.command("session_list", {}).sessions[0].running, 5000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		dev.command("write_raw", { session: "raw", data: Buffer.from("ls -la\r").toString("base64") });
		await waitFor(() => termText(io, "raw").includes("ls -la"), 5000);
		expect(io.log.mock.calls.some((call) => String(call[0]).includes("> ls -la"))).toBe(false);
		dev.command("session_kill", { session: "raw" });
		await dev.stop();
	}, 15000);

	test("session_list reports sessions; unknown names are refused", async () => {
		const { dev } = driver();
		await dev.start();
		dev.command("session_start", { cmd: "sleep 5", name: "idle" });
		const list = dev.command("session_list", {});
		expect(list.sessions.map((s) => s.name)).toContain("idle");
		expect(list.sessions[0].running).toBe(true);
		expect(() => dev.command("write", { session: "nope", text: "x" })).toThrow(/no session "nope"/);
		dev.command("session_kill", { session: "idle" });
		await dev.stop();
	}, 15000);

	test("a session with a single match is implicit", async () => {
		const { io, dev } = driver();
		await dev.start();
		dev.command("session_start", { cmd: "cat", name: "only" });
		await waitFor(() => dev.command("session_list", {}).sessions[0].running, 5000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		dev.command("write", { text: "implicit-session" });
		await waitFor(() => termText(io, "only").includes("implicit-session"), 5000);
		dev.command("session_kill", { session: "only" });
		await dev.stop();
	}, 15000);

	test("duplicate names and empty cmds are rejected", async () => {
		const { dev } = driver();
		await dev.start();
		dev.command("session_start", { cmd: "sleep 5", name: "dup" });
		expect(() => dev.command("session_start", { cmd: "true", name: "dup" })).toThrow(/already exists/);
		expect(() => dev.command("session_start", { cmd: "  " })).toThrow(/needs \{cmd\}/);
		dev.command("session_kill", { session: "dup" });
		await dev.stop();
	}, 15000);
});

describe("shell device through the lab", () => {
	const labModule = require("../../../lab");

	const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mailab-shell-"));

	test("term events carry the session; scrollback is per session", async () => {
		const lab = labModule.create({ dataDir: mkdtemp(), channelCapacity: 64 });
		await lab.addDevice("sh", "shell", {});
		const seen = [];
		lab.events.on("term", (chunk) => seen.push(chunk));
		await lab.commandDevice("sh", "session_start", { cmd: "echo lab-session-a", name: "a" });
		await lab.commandDevice("sh", "session_start", { cmd: "echo lab-session-b", name: "b" });
		await new Promise((resolve) => setTimeout(resolve, 3000));
		const textOf = (session) => Buffer.concat(
			seen.filter((c) => c.device === "sh" && c.session === session)
				.map((c) => Buffer.from(c.data, "base64"))
		).toString("latin1");
		expect(textOf("a")).toContain("lab-session-a");
		expect(textOf("b")).toContain("lab-session-b");
		expect(Buffer.from(lab.getTerm("sh", "a"), "base64").toString("latin1")).toContain("lab-session-a");
		expect(Buffer.from(lab.getTerm("sh", "b"), "base64").toString("latin1")).toContain("lab-session-b");
		// sessions visible in the device status (terminal pane picker)
		const status = await lab.commandDevice("sh", "status", {});
		expect(status.sessions.map((s) => s.name).sort()).toEqual(["a", "b"]);
		await lab.stopDevice("sh");
	}, 30000);
});
