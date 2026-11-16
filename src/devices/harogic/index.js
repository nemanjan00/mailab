// Harogic HTRA spectrum analyzers (SAE/SAM/SAN...) in sweep mode, through the
// vendor libhtraapi (ctypes in python/harogic_bridge.py). Not bundled: point
// `lib` at the libhtraapi.so that ships with SAStudio4 or the HTRA SDK.

const processDriver = require("../process");

module.exports = processDriver.pythonPreset({
	name: "harogic",
	description: "Harogic HTRA spectrum analyzer, sweep mode (vendor libhtraapi via ctypes): trace \"spectrum\" (dBm), peak_freq/peak_dbm/temp",
	script: "harogic_bridge.py",
	options: {
		lib: "path to libhtraapi.so (default ~/sastudio/SAStudio4_x86_64_4.4.55.50/lib/libhtraapi.so)",
		index: "device number when several analyzers are connected (default 0)",
		start: "Hz (default 88e6)",
		stop: "Hz (default 108e6)",
		rbw: "Hz (default 30e3)",
		refLevel: "dBm (default 0)",
		interval: "seconds between sweeps (default 0 = as fast as possible)"
	},
	commands: {
		info: "device identity (UID, model, firmware)",
		configure: "{start, stop, rbw, ref_level}",
		sweep: "single sweep",
		continuous: "{on}"
	},
	args: (options) => {
		return processDriver.toFlags(options, ["lib", "index", "start", "stop", "rbw", "refLevel", "interval"]);
	}
});
