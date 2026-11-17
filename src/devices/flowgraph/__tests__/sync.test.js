// Runs the python sync_mark regression (python/test_sync.py) as part of
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

maybe("sync_mark stamps edges with the global sample index and edge time", () => {
	const run = spawnSync(config.get("PYTHON"), ["test_sync.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 120000 });
	if (run.status !== 0) {
		throw new Error(run.stdout + run.stderr);
	}
	["sync_mark", "sync_mark_falling", "sync_mark_gap"].forEach((name) => {
		expect(run.stdout).toMatch(new RegExp("ok " + name));
	});
}, 150000);
