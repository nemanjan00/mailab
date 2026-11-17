// Runs the python video_decode regression (python/test_video.py) as part of
// `yarn test`, so the husky pre-commit hook covers it. Skipped when the
// python side (numpy) isn't installed.

const path = require("path");
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");

const available = () => {
	const probe = spawnSync(config.get("PYTHON"), ["-c", "import numpy"], { cwd: PYTHON_DIR });
	return probe.status === 0;
};

const maybe = available() ? test : test.skip;

maybe("video_decode assembles PAL/NTSC fields from synthetic composite video", () => {
	const run = spawnSync(config.get("PYTHON"), ["test_video.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 120000 });
	if (run.status !== 0) {
		throw new Error(run.stdout + run.stderr);
	}
	expect(run.stdout).toMatch(/all video_decode tests passed/);
}, 150000);
