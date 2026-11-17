// Runs the python modem BER regression (python/test_modem.py) as part of
// `yarn test`, so the husky pre-commit hook covers it. Skipped when the
// python side (numpy + liquid-dsp) isn't installed.

const path = require("path");
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");

const available = () => {
	const probe = spawnSync(config.get("PYTHON"), ["-c", "import numpy, liquid_dsp"], { cwd: PYTHON_DIR });
	return probe.status === 0;
};

const maybe = available() ? test : test.skip;

maybe("every modulation survives AWGN with a low BER", () => {
	const run = spawnSync(config.get("PYTHON"), ["test_modem.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 120000 });
	if (run.status !== 0) {
		throw new Error(run.stdout + run.stderr);
	}
	["lowpass", "bpsk", "qam256", "gfsk", "4fsk", "ook", "sync", "uart", "baud", "esb", "ble"].forEach((name) => {
		expect(run.stdout).toMatch(new RegExp("ok " + name));
	});
}, 150000);
