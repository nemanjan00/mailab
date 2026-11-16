// PicoGlitcher voltage glitcher via the findus python bridge. Glitch attempts
// land in the "glitch" scatter dataset (delay vs length, coloured by result).

const processDriver = require("../process");

module.exports = processDriver.pythonPreset({
	// pip packages, installed into the mailab-managed venv on first use
	requires: ["findus==1.14.1", "pyserial==3.5"],
	name: "picoglitcher",
	description: "PicoGlitcher fault injection (findus). Results go to scatter dataset \"glitch\"",
	script: "picoglitcher_bridge.py",
	options: {
		port: "PicoGlitcher serial port (default /dev/ttyACM0)",
		targetPort: "target UART for reply classification (optional)",
		targetBaud: "target baud (default 115200)"
	},
	commands: {
		trigger: "{mode: rising|falling|tio|uart, pin, pattern, baudrate}",
		mode: "{glitch: lp|hp|mux|ext}",
		reset: "{time}",
		power_cycle: "{time}",
		glitch: "{delay, length, timeout, expected} single attempt",
		campaign: "{delay: [min, max], length: [min, max], count, timeout, expected} random search"
	},
	args: (options) => {
		return processDriver.toFlags(options, ["port", "targetPort", "targetBaud"]);
	}
});
