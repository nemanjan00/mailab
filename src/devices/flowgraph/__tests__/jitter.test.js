// Runs the python jitter regression (python/test_jitter.py) as part of
// `yarn test`. Skipped when the python side (numpy) isn't installed.

const path = require("path");
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");

const available = () => {
	const probe = spawnSync(config.get("PYTHON"), ["-c", "import numpy"], { cwd: PYTHON_DIR });
	return probe.status === 0;
};

const maybe = available() ? test : test.skip;

maybe("tie_jitter/cdr/eye_mask measure TIE, lock a PLL and count mask hits", () => {
	const run = spawnSync(config.get("PYTHON"), ["test_jitter.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 120000 });
	if (run.status !== 0) {
		throw new Error(run.stdout + run.stderr);
	}
	["tie_clean", "tie_jittery", "cdr_locks", "cdr_freq", "eye_mask_open", "eye_mask_counts"].forEach((name) => {
		expect(run.stdout).toMatch(new RegExp("ok " + name));
	});
}, 150000);
