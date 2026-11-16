// ISDT MP305A/B bench supply over USB-HID, via the pymp305 python bridge.

const processDriver = require("../process");

module.exports = processDriver.pythonPreset({
	name: "mp305",
	description: "ISDT MP305A/B bench supply (USB-HID, pymp305). Channels: v, i, p, temp",
	script: "mp305_bridge.py",
	options: {
		poll: "telemetry period in seconds (default 0.25)"
	},
	commands: {
		state: "full telemetry",
		set_output: "{voltage, current, on} volts / amps",
		output_off: "output off",
		release: "give the front panel control back"
	},
	args: (options) => {
		return processDriver.toFlags(options, ["poll"]);
	}
});
