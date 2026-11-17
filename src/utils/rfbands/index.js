// Lab RF transmit allow-list: which frequencies a bench transmitter (siggen,
// SDR TX, etc.) may radiate on, keyed by the lab's region. This is a SAFETY
// boundary, not a device capability: the region comes from the lab config
// (MAILAB_RF_REGION), never from a device's own options, so an AI adding a
// device can't widen the bands. A chamber / unsafe bypass (MAILAB_RF_CHAMBER,
// MAILAB_UNSAFE) lifts the check for shielded / explicitly-unsafe benches.
//
// The band tables below are the common licence-free ISM / SRD allocations
// (conservative) and are a lab allow-list, not legal advice - review them for
// your jurisdiction before trusting them. They intentionally match the spirit
// of the rfcat driver's region bands (src/devices/rfcat) but cover the wider
// range a broadband siggen (e.g. Morfeus, 23.5 MHz-6 GHz) can reach.

const bypass = require("../bypass");
const units = require("../units");

const MHZ = 1e6;

// [lo, hi] in Hz. Licence-free ISM / SRD bands.
const BANDS = {
	eu: [
		[6.765 * MHZ, 6.795 * MHZ],
		[13.553 * MHZ, 13.567 * MHZ],
		[26.957 * MHZ, 27.283 * MHZ],
		[40.660 * MHZ, 40.700 * MHZ],
		[433.05 * MHZ, 434.79 * MHZ],
		[863 * MHZ, 870 * MHZ],
		[2400 * MHZ, 2483.5 * MHZ],
		[5725 * MHZ, 5875 * MHZ]
	],
	us: [
		[13.553 * MHZ, 13.567 * MHZ],
		[26.957 * MHZ, 27.283 * MHZ],
		[40.660 * MHZ, 40.700 * MHZ],
		[902 * MHZ, 928 * MHZ],
		[2400 * MHZ, 2483.5 * MHZ],
		[5725 * MHZ, 5875 * MHZ]
	],
	// no region configured: nothing is allowed on the air (chamber/bypass only)
	none: []
};

/**
 * Bands for a region, as [lo, hi] Hz pairs. Unknown region -> [] (deny all).
 * @param {string} region eu | us | none
 * @returns {number[][]}
 */
const bands = (region) => {
	return BANDS[String(region || "none").toLowerCase()] || [];
};

/**
 * Parse a comma-separated "lo-hi, lo-hi" range list with engineering suffixes
 * (k/M/G) into [lo, hi] Hz pairs. Malformed ranges are skipped, not fatal.
 * @param {string} text
 * @returns {number[][]}
 */
const parseRanges = (text) => {
	const out = [];
	String(text || "").split(",").forEach((part) => {
		const m = part.trim().match(/^(.+?)\s*-\s*(.+)$/);
		if (!m) {
			return;
		}
		try {
			const lo = units.parse(m[1]);
			const hi = units.parse(m[2]);
			if (lo > 0 && hi >= lo) {
				out.push([lo, hi]);
			}
		} catch (_err) {
			// ignore a malformed range rather than refusing every TX
		}
	});
	return out;
};

/**
 * Person-configured extra TX bands (MAILAB_RF_TX_EXTRA), e.g.
 * "144M-146M, 2400M-2483.5M": comma-separated lo-hi ranges with engineering
 * suffixes. These are added to the region's licence-free bands, so a licensed
 * amateur or lab allocation a person is actually allowed to use can be opened
 * up without widening the table for everyone. Like the region, this is read
 * from the fixed process env, never from device options, so an AI configuring
 * a device can't widen the bands.
 * @param {{get: function(string): string}} config the lab config module
 * @returns {number[][]} [lo, hi] Hz pairs (empty when unset / unparseable)
 */
const extras = (config) => {
	return parseRanges(config.get("MAILAB_RF_TX_EXTRA"));
};

/**
 * Is hz inside one of the region's allowed bands (plus any extras)?
 * @param {number} hz
 * @param {string} region
 * @param {number[][]} [extra] extras(config) bands
 * @returns {boolean}
 */
const inBand = (hz, region, extra) => {
	const all = bands(region).concat(extra || []);
	return all.some((b) => {
		return hz >= b[0] && hz <= b[1];
	});
};

/**
 * Human-readable list of the region's bands (for error messages), in MHz.
 * @param {string} region
 * @returns {string}
 */
const describeBands = (region) => {
	const list = bands(region);
	if (!list.length) {
		return "none (region " + (region || "none") + " permits no on-air transmit)";
	}
	return list.map((b) => {
		return (b[0] / MHZ) + "-" + (b[1] / MHZ) + " MHz";
	}).join(", ");
};

/**
 * Decide whether a transmit at hz is allowed.
 * @param {number} hz
 * @param {{region: string, chamber: boolean}} env region plus chamber/bypass flag
 * @returns {{ok: boolean, reason: string}}
 */
const check = (hz, env) => {
	const e = env || {};
	if (e.chamber) {
		return { ok: true, reason: "chamber/bypass mode: band check disabled" };
	}
	if (inBand(hz, e.region, e.extras)) {
		return { ok: true, reason: "in band" };
	}
	return {
		ok: false,
		reason: (hz / MHZ) + " MHz is outside the allowed " + (e.region || "none")
			+ " transmit bands (" + describeBands(e.region)
			+ (e.extras && e.extras.length ? "; extras: " + e.extras.map((b) => {
				return (b[0] / MHZ) + "-" + (b[1] / MHZ) + " MHz";
			}).join(", ") : "")
			+ "). Set MAILAB_RF_CHAMBER=1 (shielded chamber) or MAILAB_UNSAFE=1 to bypass."
	};
};

/**
 * Read the lab's RF transmit environment from config: region plus whether a
 * chamber / unsafe bypass is active. Both bypass vars are read the same way so
 * a caller never has to know which one is set.
 * @param {{get: function(string): string}} config the lab config module
 * @returns {{region: string, chamber: boolean}}
 */
const fromConfig = (config) => {
	return {
		region: config.get("MAILAB_RF_REGION") || "none",
		chamber: bypass.active(),
		extras: extras(config)
	};
};

module.exports = {
	bands: bands,
	extras: extras,
	parseRanges: parseRanges,
	inBand: inBand,
	describe: describeBands,
	check: check,
	fromConfig: fromConfig,
	isTruthy: bypass.isTruthy
};
