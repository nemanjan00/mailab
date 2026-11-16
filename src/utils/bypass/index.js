// Safety bypass for isolated benches: a shielded RF chamber or a throwaway
// non-persistent image where emissions are contained and friction is unwanted.
//
// ENV-ONLY, by design: the flags are read from the fixed process env at call
// time (like MAILAB_RF_*), never from device options or the lab state, so an
// AI configuring a device can't switch the bypass on. There is no runtime
// toggle and no API to set it: restart the server without the env var to go
// back to full safety.
//
//   MAILAB_RF_CHAMBER=1  shielded-chamber bypass
//   MAILAB_UNSAFE=1      same bypass, spelled for a throwaway bench/image
//
// Both lift: the RF TX band allow-list (src/utils/rfbands), per-TX approvals
// (src/safety) and per-device limits (PSU maxVolts/maxAmps). They never lift
// the PSU hardware-damage caps (the absolute V/I a supply can be asked for):
// that needs the independent opt-out MAILAB_UNSAFE_PSU=1 on top, so a typo
// can't fry a board even in bypass.

const config = require("../../config");

const TRUTHY = ["1", "true", "yes", "on"];

/**
 * @param {*} value env value (string / boolean / undefined)
 * @returns {boolean}
 */
const isTruthy = (value) => {
	if (value === true) {
		return true;
	}
	if (value === undefined || value === null) {
		return false;
	}
	return TRUTHY.indexOf(String(value).trim().toLowerCase()) !== -1;
};

/**
 * Chamber / unsafe bypass active?
 * @returns {boolean}
 */
const active = () => {
	return isTruthy(config.get("MAILAB_RF_CHAMBER")) || isTruthy(config.get("MAILAB_UNSAFE"));
};

/**
 * Independent opt-out that also lifts the PSU hardware-damage caps. Only
 * meaningful on top of the base bypass (it never widens safety by itself).
 * @returns {boolean}
 */
const psuUnsafe = () => {
	return active() && isTruthy(config.get("MAILAB_UNSAFE_PSU"));
};

/**
 * Human-readable one-line description of the active bypass, or null when
 * safety is fully on. Used for the UI banner, safety_overview and log lines.
 * @returns {string|null}
 */
// named describeBypass internally: `describe` is a jest global
const describeBypass = () => {
	if (!active()) {
		return null;
	}
	const flags = [];
	if (isTruthy(config.get("MAILAB_RF_CHAMBER"))) {
		flags.push("MAILAB_RF_CHAMBER");
	}
	if (isTruthy(config.get("MAILAB_UNSAFE"))) {
		flags.push("MAILAB_UNSAFE");
	}
	let text = "⚠ SAFETY BYPASSED (" + flags.join(" + ") + "): RF TX band allow-list, per-TX approvals and device limits are lifted";
	if (psuUnsafe()) {
		text += "; PSU hardware-damage caps lifted too (MAILAB_UNSAFE_PSU)";
	}
	return text;
};

/**
 * @returns {{active: boolean, psuUnsafe: boolean, text: string|null}}
 */
const info = () => {
	return { active: active(), psuUnsafe: psuUnsafe(), text: describeBypass() };
};

module.exports = {
	isTruthy: isTruthy,
	active: active,
	psuUnsafe: psuUnsafe,
	describe: describeBypass,
	info: info
};
