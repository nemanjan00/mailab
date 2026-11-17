// Shared RF transmit policy: turn device commands into TX intents, check them
// against the lab's region + MAILAB_RF_TX_EXTRA bands, and cap gain / duration.
// Pure functions only (no lab wiring) so jest can exercise them directly.
const rfbands = require("../utils/rfbands");
const config = require("../config");
const units = require("../utils/units");

// numbers may carry engineering suffixes ("433.92M") like the bridge accepts
const num = (value) => {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	const n = units.parse(String(value));
	return Number.isFinite(n) ? n : null;
};

// TX caps from the environment (a person with shell access set them deliberately)
const caps = () => {
	return {
		maxGainDb: Number(config.get("MAILAB_RF_TX_MAX_GAIN") || 40),
		maxSeconds: Number(config.get("MAILAB_RF_TX_MAX_SECONDS") || 120)
	};
};

// soapy_sink blocks in a flowgraph
const sinkBlocks = (graph) => {
	return ((graph && graph.blocks) || []).filter((b) => b && b.type === "soapy_sink");
};

/**
 * Map a device command to a TX intent, or null when it isn't a transmission.
 * @param {{driver: string, options: Object}} inst device instance record
 * @param {string} name command
 * @param {Object} args command args
 * @returns {?{kind: string, freqHz: number, gainDb: number, seconds: number, what: string}}
 */
const plan = (inst, name, args) => {
	const a = args || {};
	const driver = inst.driver;
	if (driver === "hackrf" && name === "transmit") {
		return {
			kind: "transmit",
			freqHz: num(a.freqHz),
			gainDb: num(a.gain) === null ? 20 : num(a.gain),
			seconds: num(a.seconds) || 0,
			what: "hackrf.transmit @ " + (num(a.freqHz) / 1e6).toFixed(3) + " MHz"
		};
	}
	if (driver === "rfcat" && (name === "tx" || name === "replay")) {
		const freq = num(inst.options && inst.options.freq) || 0;
		return {
			kind: name,
			freqHz: freq,
			gainDb: null,
			seconds: num(args.timeoutMs) ? num(args.timeoutMs) / 1000 : 0,
			what: "rfcat." + name + " @ " + (freq / 1e6).toFixed(3) + " MHz"
		};
	}
	if (driver === "flowgraph" && name === "run" && args.on === true) {
		const sinks = sinkBlocks(inst.options && inst.options.graph);
		if (!sinks.length) {
			return null;
		}
		// the most permissive sink decides; each still checks its own band in the bridge
		let worst = null;
		sinks.forEach((b) => {
			const p = b.params || {};
			const freq = num(p.freq) || 0;
			const gain = num(p.gain) === null ? 20 : num(p.gain);
			const intent = { kind: "flowgraph", freqHz: freq, gainDb: gain, seconds: 0, what: "flowgraph run (soapy_sink) @ " + (freq / 1e6).toFixed(3) + " MHz" };
			if (!worst || intent.freqHz < worst.freqHz) {
				worst = intent;
			}
		});
		return worst;
	}
	if (driver === "flowgraph" && name === "set_param" && args.key && String(args.key).match(/^(freq|gain)$/i)) {
		const graph = inst.options && inst.options.graph;
		const block = ((graph && graph.blocks) || []).filter((b) => {
			return b && b.id === args.block;
		})[0];
		if (!block || block.type !== "soapy_sink") {
			return null;
		}
		const freq = args.key === "freq" ? num(args.value) : num((block.params || {}).freq) || 0;
		const gain = args.key === "gain" ? num(args.value) : (num((block.params || {}).gain) === null ? 20 : num((block.params || {}).gain));
		return {
			kind: "flowgraph",
			freqHz: freq,
			gainDb: gain,
			seconds: 0,
			what: "flowgraph set_param " + args.block + "." + args.key + " (soapy_sink) @ " + (freq / 1e6).toFixed(3) + " MHz"
		};
	}
	return null;
};

// band check: the lab region's bands + person-configured MAILAB_RF_TX_EXTRA;
// MAILAB_RF_CHAMBER / MAILAB_UNSAFE (isolated chamber) lifts everything
const bypassActive = () => {
	try {
		return Boolean(require("../utils/bypass").active());
	} catch (_err) {
		return false;
	}
};

const checkBand = (intent) => {
	if (bypassActive()) {
		return { ok: true };
	}
	const region = config.get("MAILAB_RF_REGION") || "eu";
	const merged = rfbands.bands(region).concat(rfbands.extras(config));
	if (!merged.length) {
		return { ok: false, reason: "no TX bands are allowed in region \"" + region + "\" (MAILAB_RF_REGION; add MAILAB_RF_TX_EXTRA ranges for your licensed bands)" };
	}
	if (intent.freqHz === null || intent.freqHz === undefined) {
		return { ok: false, reason: "missing transmit frequency" };
	}
	const ok = merged.some((b) => {
		return b[0] <= intent.freqHz && intent.freqHz <= b[1];
	});
	if (ok) {
		return { ok: true };
	}
	return { ok: false, reason: rfbands.check(intent.freqHz, { region: region, extras: rfbands.extras(config) }).reason || (intent.freqHz / 1e6).toFixed(3) + " MHz is outside the allowed TX bands" };
};

// clamp a requested duration to the MAILAB_RF_TX_MAX_SECONDS cap;
// 0 / missing (open-ended) becomes the full cap. Returns {seconds}.
const clampSeconds = (seconds) => {
	const cap = caps().maxSeconds;
	const want = Number(seconds) || 0;
	const out = cap > 0 ? (want > 0 ? Math.min(want, cap) : cap) : want;
	return { seconds: out };
};

module.exports = { caps: caps, plan: plan, checkBand: checkBand, clampSeconds: clampSeconds, sinkBlocks: sinkBlocks, bypassActive: bypassActive };
