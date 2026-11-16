// Runs the OpenCV bridge regression (python/test_vision.py: synthetic 7-segment
// digits, LEDs, template, warp, align, ArUco, OCR) and checks the node op
// catalog matches the bridge's. Uses the first python that imports cv2:
// VISION_PYTHON, the mailab venv (DATA_DIR/python), PYTHON; skipped otherwise.

const fs = require("fs");
const path = require("path");
const spawnSync = require("child_process").spawnSync;
const config = require("../../config");
const pyenv = require("../../services/pyenv");
const vision = require("..");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "python");

const candidates = [process.env.VISION_PYTHON, path.join(pyenv._venvDir(), "bin", "python"), config.get("PYTHON")]
	.filter((p) => p && (p.indexOf("/") === -1 || fs.existsSync(p)));

const python = candidates.find((p) => spawnSync(p, ["-c", "import cv2, numpy"], { cwd: PYTHON_DIR }).status === 0);

const maybe = python ? test : test.skip;

maybe("vision bridge ops work on synthetic images", () => {
	const run = spawnSync(python, ["test_vision.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 120000 });
	if (run.status !== 0) {
		throw new Error(run.stdout + run.stderr);
	}
	["seven_seg digits", "seven_seg Err", "led on green", "led off", "template multi-scale", "warp roundtrip", "align ORB homography",
		"aruco detect", "aruco scale", "measure mm", "diff previous frame", "watch led", "watch seven_seg", "protocol run"].forEach((name) => {
		expect(run.stdout).toContain("ok " + name);
	});
	expect(run.stdout).toContain("all ok");
}, 150000);

maybe("node op catalog matches the bridge", () => {
	const run = spawnSync(python, ["-c", "import json, vision_bridge as vb; print(json.dumps({k: v[1] for k, v in vb.OPS.items()}))"], { cwd: PYTHON_DIR, encoding: "utf8" });
	expect(JSON.parse(run.stdout)).toEqual(vision.OPS);
});
