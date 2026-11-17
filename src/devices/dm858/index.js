// RIGOL DM858/DM858E bench multimeter, live-verified on a DM858 (identity
// "Rigol Technologies,DM858") on the lab LAN.
//
// Four layers, events flowing down (intent) and up (state):
//   UI (this file: MCP/GUI command surface, io.value/trace/image publishing)
//   -> logic (logic.js: monitor — poll readings into a channel)
//   -> state (scope.js: the synced settings model, emits "change")
//   -> state sync (sync.js: the only SCPI talker; serialized chain, emits
//      "tx"/"rx"/"error")
//
// What the AI gets: no manual needed. `settings` is a synced model
// (function, range/auto, NPLC, null/relative, calculate, trigger, beeper);
// `set` changes it with intent-level args ({measure: {func: "DCV",
// auto: true, nplc: 20}, null: {state: true}}) — validated, written, read
// back; `monitor` streams readings to the reading channel.
//
// FW quirks (learned on the bench, encoded in settings.js):
//   - [SENSe]:FUNCtion switches functions (then per-function nodes apply);
//   - NPLC is a discrete enum {0.4|5|20} — writes snap to the nearest;
//   - freq/period range lives at SENSe:<f>:VOLTage:RANGe (input level);
//   - unsupported headers time out, so the sync plan only uses verified ones.

const scpiDriver = require("../scpi");
const settings = require("./settings");
const syncLayer = require("./sync");
const scopeLayer = require("./scope");
const logicLayer = require("./logic");

module.exports = scpiDriver.preset({
	name: "dm858",
	description: "Rigol DM858/DM858E bench multimeter: synced settings model (function/range/NPLC/null/calculate/trigger/beeper), intent-level set, reading monitor -> channel, screenshot",
	options: {
		monitorOnStart: "start the reading monitor (value channel) when the device starts",
		monitorMs: "monitor poll period (default 1000; keep it slower than the integration time)",
		autoSyncMs: "settings re-sync period in ms (default 30000; 0 = only sync on start and on change)",
		autoSync: "false disables the settings sync entirely (cache stays empty until `sync`)"
	},
	commandDocs: {
		settings: "{} the synced settings model (value <device>_settings); syncs first if never synced",
		sync: "{} re-read every setting from the meter into the model",
		set: "{measure?: {func? (DCV|ACV|DCI|ACI|ohm2w|ohm4w|cap|freq|period|temp|diode|cont), range?, auto?, nplc? (0.4|5|20)}, null?: {state?, value?}, calc?: {average?, limit?, limit_low?, limit_high?}, trigger?: {count?, source? (IMM|BUS|EXT)}, system?: {beeper?}} change settings; each write is validated and read back",
		settings_schema: "{} the form schema the settings pane renders",
		monitor: "{on: true|false, intervalMs?} poll readings -> the reading channel ({unit} per active function)",
		measure: "{} one reading {value, func, unit} in the active function",
		screenshot: "{} PNG of the screen -> image <device>_screen (returned too)",
		snapshot: "alias of screenshot (the image pane button sends \"snapshot\")",
		zero: "{} shorthand: null the reading (NULL on, value = last reading)",
		beep: "{} beep once"
	},
	commands: (client, io, options) => {
		const sync = syncLayer.createSync(client, io);
		const meter = scopeLayer.createMeter(sync);
		const logic = logicLayer.createLogic(meter);

		meter.on("change", () => {
			io.value("settings", meter.get());
			// the legacy `value` poll channel carries no unit: stamp it from
			// the active function so panes show V/A/ohm/...
			io.meta("value", { unit: settings.unitOf(meter.get().measure.func) });
			io.meta("reading", { unit: settings.unitOf(meter.get().measure.func) });
		});
		sync.on("error", () => null);

		if (options.autoSync !== false) {
			if (options._dmStopAutoSync) {
				options._dmStopAutoSync();
				options._dmStopAutoSync = null;
			}
			meter.sync().catch(() => null);
			const period = options.autoSyncMs === undefined ? 30000 : Number(options.autoSyncMs);
			if (period > 0) {
				const timer = setInterval(() => {
					meter.sync().catch(() => null);
				}, Math.max(5000, period));
				if (typeof timer.unref === "function") {
					timer.unref();
				}
				options._dmStopAutoSync = () => clearInterval(timer);
			}
		}


		const screenNow = () => {
			return client.queryBinary(":HCOPy:SDUMp:DATA? PNG").then((png) => {
				io.image("screen", png, "image/png");
				return { _image: { data: png.toString("base64"), mime: "image/png" } };
			});
		};

		const pushReading = (r) => {
			io.sample("value", r.value, { unit: r.unit });
			io.sample("reading", r.value, { unit: r.unit });
			io.value("reading", { value: r.value, func: r.func, unit: r.unit, t: Date.now() });
		};

		// monitorOnStart: poll readings through the serialized chain from the
		// start (a raw preset poll races the settings sync and times out behind
		// long integrations or function switches)
		if (options.monitorOnStart) {
			const res = logic.monitor({ on: true, intervalMs: options.monitorMs || 1000 }, pushReading);
			io.log("monitor on (" + res.intervalMs + " ms, monitorOnStart)", "info");
		}


		return {
			settings: () => meter.isSynced() ? Promise.resolve(meter.get()) : meter.sync(),
			sync: () => meter.sync(),
			settings_schema: () => settings.schema(),
			set: (args) => meter.set(args),

			monitor: (args) => {
				const res = logic.monitor(args, pushReading);
				io.log(res.monitoring ? "monitor on (" + res.intervalMs + " ms)" : "monitor off", "info");
				return res;
			},

			measure: () => meter.reading(),

			// null the reading: enable NULL with the current reading as value
			zero: () => {
				return meter.reading().then((r) => {
					return meter.set({ null: { value: r.value } }).then(() => {
						return meter.set({ null: { state: true } }).then(() => ({ ok: true, nulled: r.value, unit: r.unit }));
					});
				});
			},

			screenshot: () => screenNow(),
			// the image pane snapshot button sends "snapshot"
			snapshot: () => screenNow(),

			beep: () => meter.write(":SYSTem:BEEPer:IMMediate").then(() => ({ ok: true })),

			// legacy shims from the pre-settings driver
			function: () => meter.sync().then((m) => {
				return { function: m.measure.func, unit: settings.unitOf(m.measure.func) };
			}),
			configure: (args) => {
				const partial = { measure: { func: args.function } };
				if (args.range !== undefined) {
					partial.measure.range = args.range;
				}
				return meter.set(partial).then((m) => {
					return { function: m.measure.func, unit: settings.unitOf(m.measure.func) };
				});
			}
		};
	}
});
