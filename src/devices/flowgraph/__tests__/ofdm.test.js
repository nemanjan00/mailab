// Runs the python OFDM modem regression (python/test_ofdm.py) as part of
// `yarn test`, so the husky pre-commit hook covers it. Skipped when numpy
// isn't installed (the OFDM modem is pure numpy, no liquid-dsp needed).

const path = require("path");
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");

const available = () => {
	const probe = spawnSync(config.get("PYTHON"), ["-c", "import numpy"], { cwd: PYTHON_DIR });
	return probe.status === 0;
};

const maybe = available() ? test : test.skip;

maybe("802.11a/g-style OFDM: loopback recovers bits, corrects CFO, right structure", () => {
	const run = spawnSync(config.get("PYTHON"), ["test_ofdm.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 300000 });
	if (run.status !== 0) {
		throw new Error(run.stdout + run.stderr);
	}
	["ber bpsk", "ber qpsk", "ber qam16", "ber qam64", "ber qam256", "cfo", "structure", "pilots", "detect", "chunks"].forEach((name) => {
		expect(run.stdout).toMatch(new RegExp("ok " + name));
	});
}, 150000);
