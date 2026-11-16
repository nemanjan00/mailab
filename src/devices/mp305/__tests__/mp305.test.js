// MP305 driver: requirements, flags, approval policy, and the python bridge
// end to end against the simulated unit (python/test_mp305_bridge.py, no
// hardware). The python part needs pymp305 >= 0.6.3: it uses MP305_TEST_PYTHON,
// PYTHON, or the mailab venv, and is skipped when none has it.

const fs = require("fs");
const path = require("path");
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");
const pyenv = require("../../../services/pyenv");
const safety = require("../../../safety");
const mp305 = require("..");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");
const PROBE = "import pymp305, sys; sys.exit(0 if tuple(int(x) for x in pymp305.__version__.split('.')[:3]) >= (0, 6, 3) else 1)";

const python = [process.env.MP305_TEST_PYTHON, config.get("PYTHON"), path.join(pyenv._venvDir(), "bin", "python")]
	.filter((p) => p && (p.indexOf("/") === -1 || fs.existsSync(p)))
	.find((p) => spawnSync(p, ["-c", PROBE], { cwd: PYTHON_DIR }).status === 0);

describe("mp305 driver", () => {
	test("pymp305 0.6.3 is pinned with upgrade, bleak only for BLE", () => {
		expect(mp305.requires).toContainEqual({ spec: "pymp305==0.6.3", upgrade: true });
		expect(mp305.requires.map(pyenv.distName)).not.toContain("bleak");
		expect(mp305.extras.ble.map(pyenv.distName)).toEqual(["bleak"]);
	});

	test("options become bridge flags", () => {
		const flags = require("../../process").toFlags({ transport: "ble", maxVolts: 12, maxAmps: 1.5, address: "AA:BB" },
			["poll", "transport", "serial", "path", "address", "maxVolts", "maxAmps", "panel"]);
		expect(flags).toEqual(["--transport", "ble", "--address", "AA:BB", "--max-volts", "12", "--max-amps", "1.5"]);
	});

	test("power-on, mode, USB-PD and program commands need a person's approval", () => {
		const s = safety.create({}, {});
		const ask = (command, args) => s.needsApproval("psu", "mp305", command, args);
		expect(ask("set_output", { voltage: 3.3, on: true })).not.toBeNull();
		expect(ask("set_output", { voltage: 12, on: false })).toBeNull();
		expect(ask("set_voltage", { volts: 12 })).not.toBeNull();
		expect(ask("set_voltage", { volts: 3.3 })).toBeNull();
		expect(ask("output", { on: true })).not.toBeNull();
		expect(ask("output_off", {})).toBeNull();
		expect(ask("mode", { mode: "pd" })).not.toBeNull();
		expect(ask("pd_set", { voltages: [9] })).not.toBeNull();
		expect(ask("pd_output", { on: true })).not.toBeNull();
		expect(ask("pd_output", { on: false })).toBeNull();
		expect(ask("program_write", { steps: [] })).not.toBeNull();
		expect(ask("program_run", {})).not.toBeNull();
		expect(ask("program_stop", {})).toBeNull();
		expect(ask("state", {})).toBeNull();
		// with the generic set_output entry removed, the mp305 one still guards > 5 V
		const only = safety.DEFAULT_POLICY.filter((p) => !(p.command === "set_output" && !p.driver));
		s.setPolicy(only);
		expect(ask("set_output", { voltage: 3.3, on: true })).toBeNull();
		expect(ask("set_output", { voltage: 12, on: true })).not.toBeNull();
		expect(ask("set_output", { on: true })).not.toBeNull();
	});

	(python ? test : test.skip)("bridge end to end against the simulated MP305", () => {
		const run = spawnSync(python, ["test_mp305_bridge.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 120000 });
		if (run.status !== 0) {
			throw new Error(run.stdout + run.stderr);
		}
		["dc_and_limits", "output_on_checks_a_setpoint_left_on_the_device", "modes_pd_and_programs",
			"program_run_rechecks_stored_steps", "telemetry_and_panel", "bad_limits_refuse_to_start"].forEach((name) => {
			expect(run.stdout).toMatch(new RegExp("ok " + name));
		});
	}, 150000);
});
