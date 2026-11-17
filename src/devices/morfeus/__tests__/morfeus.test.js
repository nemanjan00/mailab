// Morfeus driver: the python bridge end to end against the simulated
// device (python/test_morfeus_bridge.py, no hardware). Runs with plain
// python3 (the fake swaps the hidraw transport out), skipped when no
// interpreter is found.

const fs = require("fs");
const path = require("path");
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");
const pyenv = require("../../../services/pyenv");
const morfeus = require("..");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");

const python = [process.env.MORFEUS_TEST_PYTHON, config.get("PYTHON"), path.join(pyenv._venvDir(), "bin", "python")]
	.filter((p) => p && (p.indexOf("/") === -1 || fs.existsSync(p)))
	.find((p) => spawnSync(p, ["-c", "print(1)"], { cwd: PYTHON_DIR }).status === 0);

describe("morfeus driver", () => {
	test("no pip deps: the transport is plain /dev/hidraw report I/O", () => {
		expect(morfeus.requires).toEqual([]);
	});

	test("options become bridge flags", () => {
		const flags = require("../../process").toFlags({ index: 1 }, ["index"]);
		expect(flags).toEqual(["--index", "1"]);
	});

	(python ? test : test.skip)("bridge end to end against the simulated moRFeus", () => {
		const run = spawnSync(python, ["test_morfeus_bridge.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 60000 });
		if (run.status !== 0) {
			throw new Error(run.stdout + run.stderr);
		}
		expect(run.stdout).toMatch(/ok morfeus bridge/);
	}, 90000);
});
