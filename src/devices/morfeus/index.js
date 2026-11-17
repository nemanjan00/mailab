// Othernet moRFeus: wideband RF signal generator/mixer (MAX2871, 30 MHz-6
// GHz) over USB HID (10c4:eac9, 16-byte reports; protocol per the
// tai/morfeus library and the Othernet forum). Bridge: python/morfeus_bridge.py
// (plain /dev/hidraw reports). Live-verified on a moRFeus v1: frequency set confirmed on the device LCD.
//
// RF safety: switching to generator mode runs an RF sweep, or setting max
// mixer current needs a person's approval (safety DEFAULT_POLICY); sweeps
// stay in the lab's region bands by policy of the operator.

const processDriver = require("../process");

// no pip deps: the transport is plain /dev/hidraw report I/O

module.exports = processDriver.pythonPreset({
	requires: [],
	name: "morfeus",
	description: "Othernet moRFeus RF signal generator/mixer (30 MHz-6 GHz, USB HID): frequency, mixer/generator mode, mixer current, bias-T, stepped sweeps -> sweep_freq channel",
	script: "morfeus_bridge.py",
	options: {
		index: "device index when several moRFeus are connected (default 0)"
	},
	commands: {
		info: "{} current state: frequency Hz, mode, current, bias",
		freq: "{hz?} read or set the LO/output frequency in Hz (30M..6G); freq_hz channel (MHz)",
		mode: "{value?: mixer|generator} read or set the function mode (generator = RF output, needs approval)",
		current: "{level?} read or set the mixer current 0..7 (level 7 needs approval)",
		bias: "{on?} read or set the bias-T (5V on the mixer input)",
		sweep: "{start_hz, stop_hz, step_hz, dwell_ms?} step the frequency (needs approval), sweep_freq channel (MHz)"
	},
	args: (options) => {
		const args = [];
		if (options.index !== undefined && options.index !== "") {
			args.push("--index", String(options.index));
		}
		return args;
	}
});
