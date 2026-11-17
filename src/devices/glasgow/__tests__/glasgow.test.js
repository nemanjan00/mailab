// Glasgow driver against a fake CLI: the exe option points at a node
// script that answers like `glasgow list` / `glasgow run <applet>`.
// Hardware-untested [HW].

const fs = require("fs");
const os = require("os");
const path = require("path");
const glasgow = require("..");

const fakeIo = () => {
	const io = { id: "gl1", logs: [] };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = () => {};
	return io;
};

// a fake glasgow binary: argv decides the canned output
const makeStub = (script) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-glasgow-"));
	const exe = path.join(dir, "glasgow");
	fs.writeFileSync(exe, "#!/usr/bin/env node\n" + script);
	fs.chmodSync(exe, 0o755);
	return { exe: exe, dir: dir };
};

describe("glasgow driver", () => {
	const dirs = [];
	afterEach(() => {
		dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
	});

	const make = (script) => {
		const stub = makeStub(script);
		dirs.push(stub.dir);
		return glasgow.create({ exe: stub.exe }, fakeIo());
	};

	test("list parses connected devices", () => {
		const dev = make("process.stdout.write('0: C3-20240101GT (rev C3, firmware 1.0.1)\\n1: C2-20200905AL (rev C2, firmware 0.9)\\n');");
		return dev.command("list", {}).then((r) => {
			expect(r.devices).toEqual([
				{ index: 0, serial: "C3-20240101GT", rev: "C3", firmware: "1.0.1" },
				{ index: 1, serial: "C2-20200905AL", rev: "C2", firmware: "0.9" }
			]);
		});
	});

	test("list with no devices returns empty", () => {
		const dev = make("process.stderr.write('error: no devices found'); process.exit(1);");
		return dev.command("list", {}).then((r) => {
			expect(r.devices).toEqual([]);
		});
	});

	test("run passes applet args through and returns output", () => {
		const dev = make("if (process.argv[2] !== 'run' || process.argv[3] !== 'uart') process.exit(2);\n"
			+ "if (process.argv.indexOf('--baud') === -1) process.exit(3);\n"
			+ "process.stdout.write('hello from uart\\n');");
		return dev.command("run", { applet: "uart", args: ["--baud", "115200"] }).then((r) => {
			expect(r.code).toBe(0);
			expect(r.out).toBe("hello from uart");
		});
	});

	test("run rejects applet names that are not safe argv", () => {
		const dev = make("process.exit(0);");
		return dev.command("run", { applet: "uart; rm -rf /" }).then(() => {
			throw new Error("should have failed");
		}, (err) => {
			expect(String(err)).toMatch("name");
		});
	});

	test("parseList helper ignores unrelated lines", () => {
		expect(glasgow._test.parseList("warning: something\n0: C3-1 (rev C3, firmware 1.0.1)\ngarbage\n")).toEqual([
			{ index: 0, serial: "C3-1", rev: "C3", firmware: "1.0.1" }
		]);
	});
});
