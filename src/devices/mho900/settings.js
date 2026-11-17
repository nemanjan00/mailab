// MHO900/MHO98 settings model: a high-level, manual-free API over the SCPI
// layer. The schema below is the single source of truth for
//   - what the driver syncs from the unit (syncQueries),
//   - what `set` accepts and which SCPI writes it maps to (buildWrites),
//   - what the settings pane renders (schema()).
// Every header here was verified live against an MHO98 (patched MHO900) on
// LAN SCPI; unknown headers TIME OUT on this FW instead of erroring, so the
// plan must stay exact.

const PROBES = ["0.001", "0.002", "0.005", "0.01", "0.02", "0.05", "0.1", "0.2", "0.5", "1", "2", "5", "10", "15", "20", "50", "100", "200", "500", "1000"];
const COUPLINGS = ["DC", "AC", "GND"];
const IMPEDANCES = ["1M", "50"];
const TB_MODES = ["MAIN", "XY", "ROLL"];
const TRIG_MODES = ["EDGE", "PULSe", "VIDEO", "DURation", "PATTern", "RS232", "IIC", "SPI", "CAN", "FLEXray", "LIN", "IIS", "SBUS1", "SBUS2"];
const SWEEPS = ["AUTO", "NORM", "SINGle"];
const TRIG_SOURCES = ["CHAN1", "CHAN2", "CHAN3", "CHAN4", "AC", "DC"];
const SLOPES = ["POS", "NEG", "RFALl"];
const ACQ_TYPES = ["NORM", "AVER", "PEAK", "HRES"];
const AWG_FUNCS = ["SINusoid", "SQUare", "RAMP", "PULSe", "NOISe", "DC", "ARB"];

// path helpers: ["ch", 1, "scale"] <-> model.ch["1"].scale (keys stay strings
// so JSON round-trips never reshuffle numeric keys into arrays)
const getPath = (model, path) => {
	let node = model;
	for (let i = 0; i < path.length; i++) {
		if (node == null) {
			return undefined;
		}
		node = node[String(path[i])];
	}
	return node;
};

const setPath = (model, path, value) => {
	let node = model;
	for (let i = 0; i < path.length - 1; i++) {
		const key = String(path[i]);
		if (node[key] == null || typeof node[key] !== "object") {
			node[key] = {};
		}
		node = node[key];
	}
	node[String(path[path.length - 1])] = value;
};

const num = (v) => {
	const n = Number(v);
	if (!Number.isFinite(n)) {
		throw new Error("expected a number, got " + JSON.stringify(v));
	}
	return n;
};

// field spec: type number|bool|enum, unit (display), min/max (numbers),
// options (enums). `scpi`: (value) => command suffix, or a fixed map.
const CH_FIELDS = {
	on: { type: "bool", label: "on" },
	scale: { type: "number", label: "scale", unit: "V/div", min: 0.0001, max: 100 },
	offset: { type: "number", label: "offset", unit: "V", min: -1000, max: 1000 },
	probe: { type: "enum", label: "probe", options: PROBES },
	coupling: { type: "enum", label: "coupling", options: COUPLINGS },
	impedance: { type: "enum", label: "impedance", options: IMPEDANCES }
};

const AWG_FIELDS = {
	on: { type: "bool", label: "on" },
	func: { type: "enum", label: "func", options: AWG_FUNCS },
	freq: { type: "number", label: "freq", unit: "Hz", min: 0.0001, max: 50000000 },
	amp: { type: "number", label: "amp (Vpp)", unit: "V", min: 0.001, max: 10 },
	offset: { type: "number", label: "offset", unit: "V", min: -5, max: 5 }
};

const sections = [];
[1, 2, 3, 4].forEach((n) => {
	sections.push({ key: "ch", index: n, title: "Channel " + n, fields: CH_FIELDS });
});
sections.push({ key: "timebase", title: "Timebase", fields: {
	scale: { type: "number", label: "scale", unit: "s/div", min: 1e-9, max: 100 },
	offset: { type: "number", label: "offset", unit: "s", min: -1000, max: 1000 },
	mode: { type: "enum", label: "mode", options: TB_MODES }
} });
sections.push({ key: "trigger", title: "Trigger", fields: {
	mode: { type: "enum", label: "mode", options: TRIG_MODES },
	sweep: { type: "enum", label: "sweep", options: SWEEPS },
	source: { type: "enum", label: "source", options: TRIG_SOURCES },
	slope: { type: "enum", label: "slope", options: SLOPES },
	level: { type: "number", label: "level", unit: "V", min: -1000, max: 1000 }
} });
sections.push({ key: "acquire", title: "Acquire", fields: {
	type: { type: "enum", label: "type", options: ACQ_TYPES },
	averages: { type: "number", label: "averages", min: 2, max: 8192, integer: true },
	memdepth: { type: "number", label: "memdepth", min: 1000, max: 100000000, integer: true }
} });
[1, 2].forEach((n) => {
	sections.push({ key: "awg", index: n, title: "AWG " + n, fields: AWG_FIELDS });
});

const schema = () => {
	return sections.map((s) => {
		return {
			key: s.key,
			index: s.index,
			title: s.title,
			fields: Object.keys(s.fields).map((name) => {
				const f = s.fields[name];
				const out = { key: name, label: f.label, type: f.type };
				if (f.unit) {
					out.unit = f.unit;
				}
				if (f.options) {
					out.options = f.options;
				}
				return out;
			})
		};
	});
};

const validate = (section, name, value) => {
	const f = section.fields[name];
	if (!f) {
		throw new Error("unknown setting: " + name + " (available: " + Object.keys(section.fields).join(", ") + ")");
	}
	if (f.type === "bool") {
		return Boolean(value);
	}
	if (f.type === "number") {
		const n = num(value);
		if (f.min !== undefined && n < f.min) {
			throw new Error(name + " must be >= " + f.min);
		}
		if (f.max !== undefined && n > f.max) {
			throw new Error(name + " must be <= " + f.max);
		}
		return f.integer ? Math.round(n) : n;
	}
	const str = String(value).toUpperCase();
	const hit = f.options.find((o) => {
		return o.toUpperCase() === str || o.toUpperCase().startsWith(str);
	});
	if (!hit) {
		throw new Error(name + " must be one of " + f.options.join("|"));
	}
	return hit;
};

const onOff = (v) => (v ? "ON" : "OFF");
const parseOn = (s) => s === "1" || s.startsWith("ON");
const parseNum = Number;
const parseImpedance = (s) => (s.startsWith("FIFT") ? "50" : "1M");

// ---- sync plan: ordered queries that fill the model. Channel steps carry
// `chan`: scope.syncAll() skips them when that channel is off (querying a
// disabled channel's settings is wasted SCPI traffic), and scope.set()
// re-syncs a channel the moment it turns on.

const syncQueries = (filter) => {
	const plan = [];
	[1, 2, 3, 4].forEach((n) => {
		if (filter && filter.chan !== n) {
			return;
		}
		const root = ":CHAN" + n;
		const chanStep = (name, path, parse) => {
			return { chan: n, path: path, query: root + ":" + name + "?", parse: parse };
		};
		plan.push(chanStep("DISPlay", ["ch", n, "on"], parseOn));
		plan.push(chanStep("SCALe", ["ch", n, "scale"], parseNum));
		plan.push(chanStep("OFFSet", ["ch", n, "offset"], parseNum));
		plan.push(chanStep("PROBe", ["ch", n, "probe"], (s) => String(parseNum(s))));
		plan.push(chanStep("COUPling", ["ch", n, "coupling"], (s) => s));
		plan.push(chanStep("IMPedance", ["ch", n, "impedance"], parseImpedance));
	});
	plan.push({ path: ["timebase", "scale"], query: ":TIMebase:MAIN:SCALe?", parse: parseNum });
	plan.push({ path: ["timebase", "offset"], query: ":TIMebase:MAIN:OFFSet?", parse: parseNum });
	plan.push({ path: ["timebase", "mode"], query: ":TIMebase:MODE?", parse: (s) => s });
	plan.push({ path: ["trigger", "mode"], query: ":TRIGger:MODE?", parse: (s) => s });
	plan.push({ path: ["trigger", "sweep"], query: ":TRIGger:SWEep?", parse: (s) => s });
	plan.push({ path: ["trigger", "source"], query: ":TRIGger:EDGE:SOURce?", parse: (s) => s });
	plan.push({ path: ["trigger", "slope"], query: ":TRIGger:EDGE:SLOPe?", parse: (s) => s });
	plan.push({ path: ["trigger", "level"], query: ":TRIGger:EDGE:LEVel?", parse: parseNum });
	plan.push({ path: ["acquire", "type"], query: ":ACQuire:TYPE?", parse: (s) => s });
	plan.push({ path: ["acquire", "averages"], query: ":ACQuire:AVERages?", parse: parseNum });
	plan.push({ path: ["acquire", "memdepth"], query: ":ACQuire:MDEPth?", parse: parseNum });
	[1, 2].forEach((n) => {
		const root = ":SOURce" + n;
		plan.push({ path: ["awg", n, "on"], query: root + ":OUTPut:STATe?", parse: parseOn });
		plan.push({ path: ["awg", n, "func"], query: root + ":FUNCtion?", parse: (s) => s });
		plan.push({ path: ["awg", n, "freq"], query: root + ":FREQuency?", parse: parseNum });
		plan.push({ path: ["awg", n, "amp"], query: root + ":VOLTage:AMPLitude?", parse: parseNum });
		plan.push({ path: ["awg", n, "offset"], query: root + ":VOLTage:OFFSet?", parse: parseNum });
	});
	return plan;
};

// ---- set: partial update -> validated SCPI writes -------------------------

const CH_WRITE = {
	on: (n, v) => ":CHAN" + n + ":DISPlay " + onOff(v),
	scale: (n, v) => ":CHAN" + n + ":SCALe " + v,
	offset: (n, v) => ":CHAN" + n + ":OFFSet " + v,
	probe: (n, v) => ":CHAN" + n + ":PROBe " + v,
	coupling: (n, v) => ":CHAN" + n + ":COUPling " + v,
	impedance: (n, v) => ":CHAN" + n + ":IMPedance " + (v === "50" ? "FIFTy" : "OMEG")
};

const AWG_WRITE = {
	on: (n, v) => ":SOURce" + n + ":OUTPut:STATe " + onOff(v),
	func: (n, v) => ":SOURce" + n + ":FUNCtion " + v,
	freq: (n, v) => ":SOURce" + n + ":FREQuency " + v,
	amp: (n, v) => ":SOURce" + n + ":VOLTage:AMPLitude " + v,
	offset: (n, v) => ":SOURce" + n + ":VOLTage:OFFSet " + v
};

const SIMPLE_WRITE = {
	timebase: {
		scale: (v) => ":TIMebase:MAIN:SCALe " + v,
		offset: (v) => ":TIMebase:MAIN:OFFSet " + v,
		mode: (v) => ":TIMebase:MODE " + v
	},
	trigger: {
		mode: (v) => ":TRIGger:MODE " + v,
		sweep: (v) => ":TRIGger:SWEep " + v,
		source: (v) => ":TRIGger:EDGE:SOURce " + v,
		slope: (v) => ":TRIGger:EDGE:SLOPe " + v,
		level: (v) => ":TRIGger:EDGE:LEVel " + v
	},
	acquire: {
		type: (v) => ":ACQuire:TYPE " + v,
		averages: (v) => ":ACQuire:AVERages " + v,
		memdepth: (v) => ":ACQuire:MDEPth " + v
	}
};

// args: the partial update in model shape. Returns [{path, write, confirm}]
// where confirm is the query that reads the value back after the write.
const buildWrites = (partial) => {
	const writes = [];
	const sectionByKey = {};
	sections.forEach((s) => {
		sectionByKey[s.key + ":" + (s.index || "")] = s;
	});
	const applySection = (key, index, values, writers, confirms) => {
		const section = sectionByKey[key + ":" + (index || "")];
		if (!section) {
			throw new Error("unknown section: " + key + (index ? " " + index : ""));
		}
		Object.keys(values).forEach((name) => {
			const value = validate(section, name, values[name]);
			const path = index ? [key, index, name] : [key, name];
			writes.push({
				path: path,
				value: value,
				write: writers(name, index, value),
				confirm: confirms(name, index)
			});
		});
	};
	Object.keys(partial || {}).forEach((key) => {
		const values = partial[key];
		if (values == null || typeof values !== "object") {
			throw new Error(key + " must be an object of settings");
		}
		if (key === "ch" || key === "awg") {
			Object.keys(values).forEach((n) => {
				const writers = key === "ch" ? (name, idx, v) => CH_WRITE[name](idx, v) : (name, idx, v) => AWG_WRITE[name](idx, v);
				const confirms = (name, idx) => {
					const prefix = key === "ch" ? ":CHAN" + idx : ":SOURce" + idx;
					const suffix = key === "ch" ? {
						on: ":DISPlay?", scale: ":SCALe?", offset: ":OFFSet?", probe: ":PROBe?",
						coupling: ":COUPling?", impedance: ":IMPedance?"
					} : {
						on: ":OUTPut:STATe?", func: ":FUNCtion?", freq: ":FREQuency?",
						amp: ":VOLTage:AMPLitude?", offset: ":VOLTage:OFFSet?"
					};
					return prefix + suffix[name];
				};
				applySection(key, Number(n), values[n], writers, confirms);
			});
			return;
		}
		const writers = (name, idx, v) => SIMPLE_WRITE[key][name](v);
		const confirms = (name) => {
			const suffix = {
				scale: ":TIMebase:MAIN:SCALe?", offset: ":TIMebase:MAIN:OFFSet?", mode: ":TIMebase:MODE?",
				sweep: ":TRIGger:SWEep?", source: ":TRIGger:EDGE:SOURce?", slope: ":TRIGger:EDGE:SLOPe?", level: ":TRIGger:EDGE:LEVel?"
			}[name] || (key === "trigger" && name === "mode" ? ":TRIGger:MODE?" : ":" + key.toUpperCase().slice(0, 4) + ":" + name.toUpperCase().slice(0, 4) + "?");
			return suffix;
		};
		applySection(key, 0, values, writers, confirms);
	});
	return writes;
};

module.exports = {
	schema: schema,
	syncQueries: syncQueries,
	buildWrites: buildWrites,
	getPath: getPath,
	setPath: setPath,
	PROBES: PROBES,
	AWG_FUNCS: AWG_FUNCS
};
