// ISDT MP305A/B bench supply over USB-HID (or BLE), via the pymp305 python bridge.
// Limits (maxVolts/maxAmps) are enforced in python/mp305_bridge.py; approvals
// for power-on, mode, USB-PD and program runs are in src/safety DEFAULT_POLICY.

const processDriver = require("../process");
const bypass = require("../../utils/bypass");

// hardware ratings the bridge enforces when the per-device limit is lifted
const HW_MAX_VOLTS = 30;
const HW_MAX_AMPS = 5;

// pymp305 0.6.3: 0xC2 state poll (no 2 s 0xBD stall), modes, USB-PD, programs.
// upgrade: venvs that installed 0.5.3 earlier get it replaced (src/services/pyenv)
const PYMP305 = { spec: "pymp305==0.6.3", upgrade: true };
const HIDAPI = "hidapi==0.15.0";
const BLEAK = "bleak==3.1.0";

module.exports = processDriver.pythonPreset({
	// pip packages, installed into the mailab-managed venv on first use
	requires: [PYMP305, HIDAPI],
	extras: { ble: [BLEAK] },
	extrasFor: (options) => (options.transport === "ble" ? ["ble"] : []),
	name: "mp305",
	description: "ISDT MP305A/B bench supply, 30 V / 5 A (USB-HID or BLE, pymp305 0.6.3). Modes DC / USB-PD source / programmable. "
		+ "Channels: v, i, p, temp, set_v, set_i, on, mode (0 DC, 1 program, 2 PD), step (program mode). Custom control pane",
	script: "mp305_bridge.py",
	options: {
		poll: "telemetry period in seconds (default 0.25)",
		transport: "usb (default) or ble (installs bleak; accept the prompt on the MP305 screen)",
		serial: "USB serial number, to pick one of several supplies",
		path: "hidraw path (alternative to serial)",
		address: "BLE address (transport ble; default: first MP305 found)",
		maxVolts: "voltage limit for this device, ≤ 30 V (default 30): DC setpoints, program steps, advertised USB-PD voltages",
		maxAmps: "current limit for this device, ≤ 5 A (default 5)",
		panel: "publish the control pane (default on)"
	},
	commands: {
		list: "connected units (USB path/serial, or a BLE scan)",
		state: "full telemetry: V/I/P, setpoints, output, mode, CV/CC, OCP, errors, limits",
		info: "hardware info (model, firmware) + system settings",
		set_output: "{voltage?, current?, on, ocp?, reapply?} DC mode; ocp true = trip, false = CC limit; reapply re-arms a lowered limit",
		set_voltage: "{volts} DC setpoint (output state kept)",
		set_current: "{amps} DC current limit (output state kept)",
		output: "{on} DC output with the current setpoints",
		output_off: "output off (any mode)",
		release: "give the front panel control back (unit reverts to DC)",
		mode: "{mode: dc|pd|program}",
		pd_profiles: "{id?} USB-PD source profile (active by default) with the advertised mask",
		pd_set: "{mask | voltages: [5, 9, ...]} advertised USB-PD voltages (PD mode)",
		pd_output: "{on} USB-PD source output (PD mode)",
		program_list: "stored sequences [{seq, name, count}]",
		program_read: "{seq} steps [{v, a, s}]",
		program_write: "{seq?, name?, steps: [{v, a, s}]} overwrite a sequence (≤ 20 steps)",
		program_run: "start the stored sequence (program mode; steps checked against the limits)",
		program_stop: "stop the sequence",
		program_state: "running step, V/I",
		charge_state: "battery-charge telemetry (read-only)"
	},
	args: (options) => {
		// chamber / unsafe bypass (env-only, src/utils/bypass): lift the
		// per-device limit by passing the hardware caps instead; the bridge
		// still enforces those. MAILAB_UNSAFE_PSU (independent opt-out on top
		// of the bypass) tells the bridge to lift the hardware caps too.
		const opts = Object.assign({}, options);
		if (bypass.active()) {
			opts.maxVolts = HW_MAX_VOLTS;
			opts.maxAmps = HW_MAX_AMPS;
		}
		if (bypass.psuUnsafe()) {
			opts.unsafePsu = true;
		}
		return processDriver.toFlags(opts, ["poll", "transport", "serial", "path", "address", "maxVolts", "maxAmps", "panel", "unsafePsu"]);
	}
});
