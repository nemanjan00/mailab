// ChipWhisperer Husky side-channel analysis board via the chipwhisperer
// python API (python/chipwhisperer_bridge.py). The bridge needs numpy; the
// chipwhisperer package itself installs into the mailab-managed venv on
// first use. Hardware-untested [HW]: written against the 6.x API docs.

const processDriver = require("../process");

const CW = { spec: "chipwhisperer==6.0.1", upgrade: true };

module.exports = processDriver.pythonPreset({
	requires: [CW],
	name: "chipwhisperer",
	description: "ChipWhisperer Husky capture board (side-channel/power analysis): scope control (gain, clock, decimation, target IO pins) and power captures -> trace <id>_wave + float32 blob <id>_wave_raw",
	script: "chipwhisperer_bridge.py",
	options: {
		serial: "Husky serial number, to pick one of several boards"
	},
	commands: {
		info: "board type, firmware, clock/gain/adc settings, IO pin states",
		capture: "{samples?} arm + capture the ADC trace -> trace <id>_wave + blob <id>_wave_raw (float32)",
		gain: "{db?} read or set the frontend gain in dB (-12..60)",
		clock: "{hz?} read or set the CLKGEN frequency (1e3..200e6)",
		decimate: "{n?} read or set the ADC decimation (1..65536)",
		io: "{tio1?, tio2?, tio3?, tio4?, hs2?, pdic?, pdid?} target IO pin states",
		reset: "scope.reset() (clears the arm state)"
	},
	args: (options) => {
		const args = [];
		if (options.serial) {
			args.push("--serial", String(options.serial));
		}
		return args;
	}
});
