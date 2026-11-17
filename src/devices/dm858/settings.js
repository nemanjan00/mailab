// DM858/DM858E bench multimeter: settings model over the SCPI layer, same
// 4-layer architecture as the mho900 scope (UI -> logic -> state -> sync).
// The schema is the single source of truth for the sync plan, `set`
// mapping and the settings pane. Every header was verified live against a
// DM858 on the lab LAN (manuals/rigol/dm858 programming guide): FUNC
// switching via [SENSe]:FUNCtion, per-function RANGe/RANGe:AUTO/NPLC/
// RESolution/NULL, CALCulate average/limit, TRIGger count/source,
// SYSTem beeper. NPLC is a discrete enum {0.4, 5, 20} (the unit snaps).

// canonical SCPI function -> capabilities. `range` nodes live at
// SENSe:<prefix>:RANGe(:AUTO), frequency/period sense the input voltage
// level at SENSe:<prefix>:VOLTage:RANGe(:AUTO) instead.
const FUNCS = {
	"VOLTage:DC": { label: "DCV", unit: "V", range: true, nplc: true, res: true, null: true },
	"VOLTage:AC": { label: "ACV", unit: "V", range: true, null: true },
	"CURRent:DC": { label: "DCI", unit: "A", range: true, nplc: true, res: true, null: true },
	"CURRent:AC": { label: "ACI", unit: "A", range: true, null: true },
	"RESistance": { label: "ohm2w", unit: "ohm", range: true, nplc: true, res: true, null: true },
	"FRESistance": { label: "ohm4w", unit: "ohm", range: true, nplc: true, res: true, null: true },
	"CAPacitance": { label: "cap", unit: "F", range: true, null: true },
	"FREQuency": { label: "freq", unit: "Hz", voltRange: true, null: true },
	"PERiod": { label: "period", unit: "s", voltRange: true, null: true },
	"TEMPerature": { label: "temp", unit: "C" },
	"DIODe": { label: "diode", unit: "V" },
	"CONTinuity": { label: "cont", unit: "ohm" }
};
const FUNC_KEYS = Object.keys(FUNCS);
const NPLC_OPTIONS = ["0.4", "5", "20"];

const getPath = (model, path) => {
	let node = model;
	for (let i = 0; i < path.length; i++) {
		if (node == null) {
			return undefined;
		}
		node = node[path[i]];
	}
	return node;
};

const setPath = (model, path, value) => {
	let node = model;
	for (let i = 0; i < path.length - 1; i++) {
		if (node[path[i]] == null || typeof node[path[i]] !== "object") {
			node[path[i]] = {};
		}
		node = node[path[i]];
	}
	node[path[path.length - 1]] = value;
};

const num = (v) => {
	const n = Number(v);
	if (!Number.isFinite(n)) {
		throw new Error("expected a number, got " + JSON.stringify(v));
	}
	return n;
};

// normalize the FUNC? reply ("\"VOLT\"", "\"RES\"", "\"VOLT:AC\"") to a key.
// The meter returns SCPI abbreviations; they are unique prefixes (VOLT is
// ambiguous between VOLTage:DC/AC and means the :DC variant, like the
// meter itself).
const normalizeFunc = (reply) => {
	const s = String(reply).replace(/"/g, "").trim().toUpperCase();
	if (FUNCS[s]) {
		return s;
	}
	const parts = s.split(":");
	const candidates = FUNC_KEYS.filter((k) => {
		const kp = k.toUpperCase().split(":");
		if (kp.length < parts.length) {
			return false;
		}
		return parts.every((p, i) => kp[i].startsWith(p));
	});
	return candidates.find((k) => k.endsWith(":DC")) || candidates[0] || "VOLTage:DC";
};

// the SENSe prefix for func-specific nodes; freq/period use their
// VOLTage:RANGe sub-node for the input level
const rangeNode = (func) => {
	const f = FUNCS[func] || {};
	if (f.voltRange) {
		return func + ":VOLTage";
	}
	return func;
};

const FUNC_ENUM = FUNC_KEYS.map((k) => FUNCS[k].label);
// label -> canonical key (schema enum shows labels; writes map back)
const labelToFunc = (label) => {
	const hit = FUNC_KEYS.find((k) => FUNCS[k].label.toUpperCase() === String(label).toUpperCase());
	if (hit) {
		return hit;
	}
	return normalizeFunc(label);
};
// and back: the MODEL stores labels (what the UI shows); canonical keys
// only exist at the SCPI boundary
const funcLabel = (canon) => (FUNCS[canon] ? FUNCS[canon].label : String(canon));

const sections = [
	{ key: "measure", title: "Measure", fields: {
		func: { type: "enum", label: "function", options: FUNC_ENUM },
		range: { type: "number", label: "range", min: 1e-12, max: 1e9 },
		auto: { type: "bool", label: "auto range" },
		nplc: { type: "enum", label: "NPLC", options: NPLC_OPTIONS },
		resolution: { type: "number", label: "resolution", readonly: true, min: 1e-12, max: 1 }
	} },
	{ key: "null", title: "Null (relative)", fields: {
		state: { type: "bool", label: "on" },
		value: { type: "number", label: "value" }
	} },
	{ key: "calc", title: "Calculate", fields: {
		average: { type: "bool", label: "statistics" },
		limit: { type: "bool", label: "limits" },
		limit_low: { type: "number", label: "low" },
		limit_high: { type: "number", label: "high" }
	} },
	{ key: "trigger", title: "Trigger", fields: {
		count: { type: "number", label: "count", min: 1, max: 1e6, integer: true },
		source: { type: "enum", label: "source", options: ["IMM", "BUS", "EXT"] }
	} },
	{ key: "system", title: "System", fields: {
		beeper: { type: "bool", label: "beeper" }
	} }
];

const schema = () => {
	return sections.map((s) => {
		return {
			key: s.key,
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
				if (f.readonly) {
					out.readonly = true;
				}
				return out;
			})
		};
	});
};

const sectionByKey = {};
sections.forEach((s) => {
	sectionByKey[s.key] = s;
});

const validate = (section, name, value) => {
	const f = section.fields[name];
	if (!f) {
		throw new Error("unknown setting: " + (f && f.label || name) + " (available: " + Object.keys(section.fields).join(", ") + ")");
	}
	if (f.readonly) {
		throw new Error(name + " is read-only (set it via the function/range)");
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
		throw new Error((f.label || name) + " must be one of " + f.options.join("|"));
	}
	return hit;
};

const onOff = (v) => (v ? "ON" : "OFF");
const parseOn = (s) => s === "1" || s.startsWith("ON");
const parseNum = Number;

// ---- sync: the plan depends on the active function, so scope.syncAll
// queries FUNCtion? first, then the per-function nodes ---------------------

const syncForFunc = (input) => {
	const func = FUNCS[input] ? input : labelToFunc(input);
	const f = FUNCS[func] || {};
	const plan = [];
	// NULL/NPLC/RESolution live directly under the function; the VOLTage
	// subnode only holds RANGe (the input voltage level for freq/period)
	const push = (path, suffix, parse) => {
		plan.push({ path: path, query: ":SENSe:" + func + ":" + suffix + "?", parse: parse });
	};
	if (f.range || f.voltRange) {
		push(["measure", "range"], "RANGe", parseNum);
		plan.push({ path: ["measure", "auto"], query: ":SENSe:" + rangeNode(func) + ":RANGe:AUTO?", parse: parseOn });
	}
	if (f.nplc) {
		push(["measure", "nplc"], "NPLC", (s) => String(parseNum(s)));
	}
	if (f.res) {
		push(["measure", "resolution"], "RESolution", parseNum);
	}
	if (f.null) {
		push(["null", "state"], "NULL:STATe", parseOn);
		push(["null", "value"], "NULL:VALue", parseNum);
	}
	return plan;
};

const commonSync = () => {
	return [
		{ path: ["calc", "average"], query: ":CALCulate:AVERage:STATe?", parse: parseOn },
		{ path: ["calc", "limit"], query: ":CALCulate:LIMit:STATe?", parse: parseOn },
		{ path: ["calc", "limit_low"], query: ":CALCulate:LIMit:LOWer?", parse: parseNum },
		{ path: ["calc", "limit_high"], query: ":CALCulate:LIMit:UPPer?", parse: parseNum },
		{ path: ["trigger", "count"], query: ":TRIGger:COUNt?", parse: parseNum },
		{ path: ["trigger", "source"], query: ":TRIGger:SOURce?", parse: (s) => s },
		{ path: ["system", "beeper"], query: ":SYSTem:BEEPer:STATe?", parse: parseOn }
	];
};

const FUNC_QUERY = { path: ["measure", "func"], query: ":SENSe:FUNCtion?", parse: (reply) => funcLabel(normalizeFunc(reply)) };

// ---- set: partial update -> validated SCPI writes -------------------------

const buildWrites = (partial, currentFunc) => {
	const writes = [];
	const funcOf = () => {
		// a func write earlier in this batch re-targets the sub-function keys
		const fw = writes.find((w) => w.path[0] === "measure" && w.path[1] === "func");
		if (!fw) {
			return currentFunc;
		}
		return FUNCS[fw.value] ? fw.value : labelToFunc(fw.value);
	};
	const applySection = (key, values) => {
		const section = sectionByKey[key];
		if (!section) {
			throw new Error("unknown section: " + key);
		}
		Object.keys(values).forEach((name) => {
			const value = validate(section, name, values[name]);
			const path = [key, name];
			let write = null;
			let confirm = null;
			if (key === "measure" && name === "func") {
				const canon = labelToFunc(value);
				write = ":SENSe:FUNCtion \"" + canon + "\"";
				confirm = ":SENSe:FUNCtion?";
			} else if (key === "measure" && (name === "range" || name === "auto")) {
				const node = rangeNode(funcOf());
				write = name === "range"
					? ":SENSe:" + node + ":RANGe " + value
					: ":SENSe:" + node + ":RANGe:AUTO " + onOff(value);
				confirm = ":SENSe:" + node + ":RANGe" + (name === "auto" ? ":AUTO" : "") + "?";
			} else if (key === "measure" && name === "nplc") {
				write = ":SENSe:" + funcOf() + ":NPLC " + value;
				confirm = ":SENSe:" + funcOf() + ":NPLC?";
			} else if (key === "null") {
				write = ":SENSe:" + funcOf() + ":NULL:" + (name === "state" ? "STATe " + onOff(value) : "VALue " + value);
				confirm = ":SENSe:" + funcOf() + ":NULL:" + (name === "state" ? "STATe" : "VALue") + "?";
			} else if (key === "calc") {
				const suffix = { average: "AVERage:STATe", limit: "LIMit:STATe", limit_low: "LIMit:LOWer", limit_high: "LIMit:UPPer" }[name];
				write = ":CALCulate:" + suffix + " " + (name === "average" || name === "limit" ? onOff(value) : value);
				confirm = ":CALCulate:" + suffix + "?";
			} else if (key === "trigger" && name === "count") {
				write = ":TRIGger:COUNt " + value;
				confirm = ":TRIGger:COUNt?";
			} else if (key === "trigger" && name === "source") {
				write = ":TRIGger:SOURce " + value;
				confirm = ":TRIGger:SOURce?";
			} else if (key === "system" && name === "beeper") {
				write = ":SYSTem:BEEPer:STATe " + onOff(value);
				confirm = ":SYSTem:BEEPer:STATe?";
			}
			if (!write) {
				throw new Error(name + " is not settable");
			}
			writes.push({ path: path, value: name === "func" ? funcLabel(labelToFunc(value)) : value, write: write, confirm: confirm });
		});
	};
	// func first so sub-function writes target the new function
	const keys = Object.keys(partial || {}).sort((a, b) => {
		return (a === "measure" ? -1 : 0) - (b === "measure" ? -1 : 0);
	});
	keys.forEach((key) => {
		const values = partial[key];
		if (values == null || typeof values !== "object") {
			throw new Error(key + " must be an object of settings");
		}
		if (key === "measure" && values.func !== undefined) {
			applySection("measure", { func: values.func });
			const rest = Object.assign({}, values);
			delete rest.func;
			if (Object.keys(rest).length) {
				applySection("measure", rest);
			}
			return;
		}
		applySection(key, values);
	});
	return writes;
};

const unitOf = (func) => (FUNCS[func] || FUNCS[labelToFunc(func)] || {}).unit || "";

module.exports = {
	schema: schema,
	syncQueries: (func) => (func ? syncForFunc(func) : []),
	commonSync: commonSync,
	funcQuery: FUNC_QUERY,
	buildWrites: buildWrites,
	normalizeFunc: normalizeFunc,
	labelToFunc: labelToFunc,
	funcLabel: funcLabel,
	rangeNode: rangeNode,
	unitOf: unitOf,
	getPath: getPath,
	setPath: setPath,
	FUNCS: FUNCS
};
