// ChipWhisperer driver: requirements and the python bridge end to end
// against the simulated Husky (python/test_chipwhisperer_bridge.py, no
// hardware, no chipwhisperer install — the fake swaps in-process). The
// python part needs numpy: it uses CHIPWHISPERER_TEST_PYTHON, PYTHON, or
// the mailab venv, and is skipped when none has it.

const fs = require("fs");
const path = require("path");
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");
const pyenv = require("../../../services/pyenv");
const chipwhisperer = require("..");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");
const PROBE_OK = "import numpy; numpy.zeros(1)";

const python = [process.env.CHIPWHISPERER_TEST_PYTHON, config.get("PYTHON"), path.join(pyenv._venvDir(), "bin", "python")]
	.filter((p) => p && (p.indexOf("/") === -1 || fs.existsSync(p)))
	.find((p) => spawnSync(p, ["-c", PROBE_OK], { cwd: PYTHON_DIR }).status === 0);

describe("chipwhisperer driver", () => {
	test("chipwhisperer 6.0.1 is pinned with upgrade", () => {
		expect(chipwhisperer.requires).toContainEqual({ spec: "chipwhisperer==6.0.1", upgrade: true });
		expect(chipwhisperer.requires.map(pyenv.distName)).toContain("chipwhisperer");
	});

	test("options become bridge flags", () => {
		const flags = require("../../process").toFlags({ serial: "H123" }, ["serial"]);
		expect(flags).toEqual(["--serial", "H123"]);
	});

	(python ? test : test.skip)("bridge end to end against the simulated Husky", () => {
		const run = spawnSync(python, ["test_chipwhisperer_bridge.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 120000 });
		if (run.status !== 0) {
			throw new Error(run.stdout + run.stderr);
		}
		expect(run.stdout).toMatch(/ok chipwhisperer bridge/);
	}, 150000);
});
