// Rigol MHO900 oscilloscope, verified live on an MHO98 (= MHO900 with
// patched FW, "NK TECHNOLOGIES" ID) on LAN port 5555.
//
// Four layers, events flowing down (intent) and up (state):
//   UI (this file: MCP/GUI command surface, io.value/trace/image publishing)
//   -> logic (logic.js: capture, watch policy — decides WHEN to push)
//   -> state (scope.js: the synced settings model + raw state accessors,
//      emits "change")
//   -> state sync (sync.js: the only SCPI talker; serialized chain, emits
//      "tx"/"rx"/"error")
//
// What the AI gets: no manual needed. `settings` is a synced model of
// everything (channels, timebase, trigger, acquire, AWG); `set` changes it
// with intent-level args ({ch: {1: {scale: 0.1}}, trigger: {level: 0.5},
// awg: {1: {freq: 1e6, on: true}}}) — validated, written, read back; `watch`
// makes the scope push the trace + screen to the web UI on every trigger.
//
// SCPI quirks of this FW (learned on the bench, encoded in settings.js):
//   - one TCP session takes NO interleaved queries,
//   - unknown headers TIME OUT (10 s) instead of erroring,
//   - AWG amplitude is :SOURce<n>:VOLTage:AMPLitude, output :OUTPut:STATe,
//     probe ratio :CHAN<n>:PROBe.

const scpiDriver = require("../scpi");
const settings = require("./settings");
const syncLayer = require("./sync");
const scopeLayer = require("./scope");
const logicLayer = require("./logic");

module.exports = scpiDriver.preset({
	name: "mho900",
	description: "Rigol MHO900 oscilloscope: settings model (channels/timebase/trigger/acquire/AWG) synced with the unit, intent-level set, auto push of trace + screen on every trigger, capture/measure/snapshot",
	options: {
		autoSyncMs: "settings re-sync period in ms (default 30000; 0 = only sync on start and on change)",
		autoSync: "false disables the settings sync entirely (cache stays empty until `sync`)"
	},
	commandDocs: {
		settings: "{} the synced settings model (value <device>_settings); syncs first if never synced",
		sync: "{} re-read every setting from the unit into the model",
		set: "{ch?: {1..4: {on?, scale? (V/div), offset? (V), probe?, coupling?, impedance?}}, timebase?: {scale? (s/div), offset?, mode?}, trigger?: {mode?, sweep?, source?, slope?, level? (V)}, acquire?: {type?, averages?, memdepth?}, awg?: {1|2: {on?, func?, freq? (Hz), amp? (Vpp), offset? (V)}}} change settings; each write is validated and read back",
		settings_schema: "{} the form schema the settings pane renders",
		watch: "{on: true|false, intervalMs?, screen?} push trace + screen image to the UI on every triggered acquisition",
		capture: "{sources: [\"CHAN1\", ...], name?} screen waveform -> trace (x = seconds)",
		measure: "{item: VPP|VMAX|VMIN|VAVG|VRMS|FREQ|PER|RTIM|FTIM|PDUT, source?: CHAN1}",
		snapshot: "{} PNG of the screen -> image <device>_screen (returned too)",
		screenshot: "alias of snapshot",
		siggen: "{source?: 1|2, func?, freq?, amp?, offset?, state?} legacy AWG control = set({awg: {n: {...}}})",
		siggen_on: "{source?} AWG output on", siggen_off: "{source?} AWG output off",
		run: "", stop: "", single: "", autoscale: ""
	},
	commands: (client, io, options) => {
		// wire the layers bottom-up; the sync layer logs every exchange to
		// the device console as its tx/rx/error events
		const sync = syncLayer.createSync(client, io);
		const scope = scopeLayer.createScope(sync);
		const logic = logicLayer.createLogic(scope);

		// state layer -> UI: every model change republishes the value
		scope.on("change", () => {
			io.value("settings", scope.get());
		});
		sync.on("error", () => null); // already logged by the sync layer

		// fetch the state once at start (not a poll: one query burst at
		// connect), then re-sync every autoSyncMs (default 30 s; 0 disables
		// the periodic refresh, autoSync: false skips everything — test seam).
		// The timer lives on options so a reconnect replaces, not duplicates.
		if (options.autoSync !== false) {
			if (options._mhoStopAutoSync) {
				options._mhoStopAutoSync();
				options._mhoStopAutoSync = null;
			}
			scope.sync().catch(() => null);
			const period = options.autoSyncMs === undefined ? 30000 : Number(options.autoSyncMs);
			if (period > 0) {
				logic.autoSync(period);
				options._mhoStopAutoSync = logic.stop;
				io.log("settings auto-sync: every " + period / 1000 + " s", "info");
			}
		}

		const ensureSynced = () => {
			return scope.isSynced() ? Promise.resolve(scope.get()) : scope.sync();
		};


		// scope context under the plot: timebase + trigger, from the model
		const scopeReadings = () => {
			const m = scope.get();
			const out = [];
			if (m.timebase && m.timebase.scale != null) {
				out.push({ name: "t/div", value: m.timebase.scale, unit: "s" });
			}
			if (m.trigger) {
				if (m.trigger.source) {
					out.push({ name: "trig src", value: 0, unit: String(m.trigger.source) });
				}
				if (m.trigger.level != null) {
					out.push({ name: "trig lvl", value: m.trigger.level, unit: "V" });
				}
				if (m.trigger.slope) {
					out.push({ name: "trig slope", value: 0, unit: String(m.trigger.slope) });
				}
			}
			return out;
		};
		// watch push adapter (logic decides when, this decides how it's shown)
		const pushToUi = (waves, opts) => {
			io.trace("scope", {
				x: waves[0].x,
				xUnit: "s",
				yUnit: "V",
				measurements: scopeReadings(),
				series: waves.map((wave) => {
					return { label: wave.source, y: wave.y };
				})
			});
			io.value("acq", { status: "TD" });
			if (opts.screen) {
				return scope.screen().then((png) => {
					io.image("screen", png, "image/png");
				});
			}
			return Promise.resolve();
		};

		const simple = (command) => {
			return () => {
				return scope.write(command).then(() => {
					return { ok: true };
				});
			};
		};

		return {
			settings: () => ensureSynced(),
			sync: () => scope.sync(),
			settings_schema: () => settings.schema(),
			set: (args) => scope.set(args),

			watch: (args) => {
				const res = logic.watch(args, pushToUi);
				if (res.watching) {
					io.log("watch on (" + res.intervalMs + " ms poll" + (res.screen ? ", trace + screen" : ", trace") + ")", "info");
				} else {
					io.log("watch off", "info");
				}
				return res;
			},

			capture: (args) => {
				return logic.capture((args && args.sources) || null).then((waves) => {
					const name = (args && args.name) || "scope";
					io.trace(name, {
						x: waves[0].x,
						xUnit: "s",
						yUnit: "V",
						measurements: scopeReadings(),
						series: waves.map((wave) => {
							return { label: wave.source, y: wave.y };
						})
					});
					return {
						trace: name,
						points: waves[0].x.length,
						sources: waves.map((w) => w.source),
						xincrement: waves[0].pre.xincrement
					};
				});
			},

			measure: (args) => scope.measure(args.item, args.source),

			snapshot: () => {
				return scope.screen().then((png) => {
					io.image("screen", png, "image/png");
					return { _image: { data: png.toString("base64"), mime: "image/png" } };
				});
			},
			// the image pane snapshot button sends "snapshot"
			screenshot: () => {
				return scope.screen().then((png) => {
					io.image("screen", png, "image/png");
					return { _image: { data: png.toString("base64"), mime: "image/png" } };
				});
			},

			// legacy AWG control, kept for existing scripts/tests: a thin shim
			// over the settings model
			siggen: (args) => {
				const n = args.source === 2 ? 2 : 1;
				const partial = { awg: {} };
				partial.awg[n] = {};
				["func", "freq", "amp", "offset"].forEach((k) => {
					if (args[k] != null) {
						partial.awg[n][k] = args[k];
					}
				});
				if (args.state != null) {
					partial.awg[n].on = Boolean(args.state);
				}
				if (!Object.keys(partial.awg[n]).length) {
					return ensureSynced().then((m) => {
						return Object.assign({ source: n }, m.awg[String(n)]);
					});
				}
				return scope.set(partial).then((m) => {
					return Object.assign({ source: n }, m.awg[String(n)]);
				});
			},
			siggen_on: (args) => scope.set({ awg: { [args.source === 2 ? 2 : 1]: { on: true } } }).then(() => ({ ok: true })),
			siggen_off: (args) => scope.set({ awg: { [args.source === 2 ? 2 : 1]: { on: false } } }).then(() => ({ ok: true })),

			run: simple(":RUN"),
			stop: simple(":STOP"),
			single: simple(":SINGle"),
			autoscale: simple(":AUToscale")
		};
	}
});
