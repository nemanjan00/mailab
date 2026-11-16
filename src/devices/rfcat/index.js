// RfCat dongles (YARD Stick One 1d50:605b, CC1111 USB dongles) via rflib,
// python/rfcat_bridge.py. Sub-GHz packet RX / TX, RSSI, spectrum sweep.
// TX (tx, replay) and TX power need a person's approval (safety DEFAULT_POLICY)
// and stay inside the allowed bands (region / txBands, checked in the bridge).
// Set env MAILAB_RFCAT_FAKE=1 (device option env) for a fake dongle.
// Hardware-untested: written against the rflib 2.0.1 source.

const processDriver = require("../process");

// commands whose {blob} argument (a lab blob name) becomes base64 `data`
const BLOB_COMMANDS = ["tx", "replay"];
// the process driver times a command out after args.timeoutMs: commands that
// take a time window get this much on top
const COMMAND_MARGIN_MS = 15000;
const TX_BASE_MS = 30000;

const OPTION_KEYS = ["index", "serial", "region", "txBands", "freq", "modulation", "drate", "deviation", "chanbw",
	"syncWord", "syncMode", "pktLen", "variable", "crc", "manchester", "preamble"];

const preset = processDriver.pythonPreset({
	// pip packages (rfcat's own deps pinned too), installed into the mailab-managed venv on first use
	requires: ["rfcat==2.0.1", "pyusb==1.3.1", "pyserial==3.5", "future==1.0.0", "numpy==2.5.3", "ipython==9.18.1"],
	name: "rfcat",
	description: "RfCat sub-GHz dongle (YARD Stick One / CC1111, rflib): packets -> table + blob \"packets\" + events, rssi channel, "
		+ "specan -> trace \"spectrum\". TX needs approval and stays in the region's ISM/SRD bands",
	script: "rfcat_bridge.py",
	options: {
		index: "dongle index (rflib order, default 0)",
		serial: "USB serial, to pick one of several dongles",
		region: "TX allow-list: eu (433.05-434.79, 868-868.6 MHz; default), us (314-316, 433.05-434.79, 902-928 MHz), none",
		txBands: "narrower TX allow-list inside the region, \"433.9M-433.95M,868M-868.6M\"",
		freq: "Hz (300-348, 391-464, 782-928 MHz)",
		modulation: "2FSK | GFSK | ASK_OOK | MSK (4FSK is CC1101-only, refused)",
		drate: "data rate, baud",
		deviation: "FSK deviation, Hz",
		chanbw: "channel filter bandwidth, Hz",
		syncWord: "16-bit sync word (0xd391)",
		syncMode: "none | 15/16 | 16/16 | 30/32 | carrier | carrier+15/16 | carrier+16/16 | carrier+30/32",
		pktLen: "packet length (fixed) or max length (variable), 1-255",
		variable: "variable length packets (first byte = length)",
		crc: "packet CRC on/off",
		manchester: "Manchester coding on/off",
		preamble: "preamble bytes: 2, 3, 4, 6, 8, 12, 16, 24",
		env: "{MAILAB_RFCAT_FAKE: \"1\"} for the fake dongle (no radio)"
	},
	commands: {
		info: "firmware build, part number (chip), serial, frequency, TX bands",
		ping: "{count} USB round trips",
		config: "{freq, modulation, drate, deviation, chanbw, syncWord, syncMode, pktLen, variable, crc, manchester, preamble} apply any subset; returns the effective settings + registers (persisted as options)",
		rx: "{timeoutMs (window, default 2000), count (default 10)} packets (n, t, hex, bytes, rssi) -> table + blob \"packets\", event \"packet\" each",
		listen: "{on} continuous RX: packets -> events + table/blob \"packets\", rssi channel",
		packets: "{last} captured packets (n is what replay takes)",
		tx: "{hex | text | data (base64) | blob (lab blob name), repeat, delayMs} transmit (needs approval; allowed bands only)",
		replay: "{index (packet n) | blob [, offset, length] | hex, repeat, delayMs} retransmit a capture (needs approval)",
		power: "{value: PA_TABLE byte | max: true} TX power (needs approval)",
		specan: "{center, span | inc, count (<=255), rate (traces/s), seconds (omit = until specan_stop)} -> trace \"spectrum\" (Hz, dBm)",
		specan_stop: "stop the spectrum analyzer",
		rssi: "current RSSI dBm -> channel rssi",
		idle: "stop listen / specan, radio IDLE",
		reset: "stop listen / specan, re-apply the options' radio settings, back to RX"
	},
	args: (options) => {
		return processDriver.toFlags(options, OPTION_KEYS);
	}
});

const isSet = (v) => v !== undefined && v !== null && v !== "";

/**
 * Bridge args for a command: lab blobs resolved to base64 `data`, and the
 * command timeout stretched past the command's own time window.
 * @param {{getBlob: function(string): Buffer}} io
 * @param {string} name command
 * @param {Object} args as given
 * @returns {Object}
 */
const bridgeArgs = (io, name, args) => {
	const out = Object.assign({}, args || {});
	if (BLOB_COMMANDS.indexOf(name) !== -1 && isSet(out.blob)) {
		out.data = io.getBlob(String(out.blob)).toString("base64");
		delete out.blob;
	}
	if (name === "rx") {
		const windowMs = isSet(out.timeoutMs) ? Number(out.timeoutMs) : 2000;
		out.windowMs = windowMs;
		out.timeoutMs = (Number.isFinite(windowMs) ? windowMs : 0) + COMMAND_MARGIN_MS;
	} else if (name === "specan" && isSet(out.seconds)) {
		const ms = Number(out.seconds) * 1000;
		out.timeoutMs = (Number.isFinite(ms) ? ms : 0) + COMMAND_MARGIN_MS;
	} else if (name === "tx" || name === "replay") {
		const repeat = Number(out.repeat) || 1;
		const delay = Number(out.delayMs) || 0;
		out.timeoutMs = TX_BASE_MS + repeat * delay;
	}
	return out;
};

module.exports = Object.assign({}, preset, {
	create: (options, io) => {
		const inner = preset.create(options, io);
		return {
			start: inner.start,
			stop: inner.stop,
			command: (name, args) => {
				let resolved;
				try {
					resolved = bridgeArgs(io, name, args);
				} catch (err) {
					return Promise.reject(err);
				}
				return inner.command(name, resolved);
			}
		};
	},
	_bridgeArgs: bridgeArgs
});
