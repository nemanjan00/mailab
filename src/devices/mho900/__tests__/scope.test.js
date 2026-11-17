// The MHO900 layer architecture: scope (state) over a fake sync layer, and
// the logic layer's watch policy on top.

const settings = require("../settings");
const syncLayer = require("../sync");
const scopeLayer = require("../scope");
const logicLayer = require("../logic");

// fake SCPI client with scripted answers (same idea as siggen.test.js)
const makeFake = () => {
	const writes = [];
	const queries = [];
	const answers = {
		"*IDN": "RIGOL,MHO900,fake,1.0",
		":TRIGger:STATus": "TD"
	};
	const client = {
		writes: writes,
		queries: queries,
		write: (c) => {
			writes.push(c);
			return Promise.resolve();
		},
		query: (c) => {
			queries.push(c);
			const rest = c.replace(/\?$/, "");
			let key = null;
			Object.keys(answers).forEach((k) => {
				if (rest.indexOf(k) === 0 && (!key || k.length > key.length)) {
					key = k;
				}
			});
			if (!key) {
				return Promise.reject(new Error("no scripted answer for " + c));
			}
			return Promise.resolve(answers[key]);
		},
		queryBinary: (c) => {
			queries.push(c);
			return Promise.resolve(Buffer.from([1, 2, 3]));
		},
		close: () => {}
	};
	client.answers = answers;
	// sync model answers per setting name (the sync plan's parse functions
	// see realistic replies)
	const byName = {
		on: "1", scale: "5.000000E-1", offset: "0", probe: "1.000000E0",
		coupling: "DC", impedance: "OMEG", mode: "EDGE", sweep: "AUTO",
		source: "CHAN1", slope: "POS", level: "0", type: "NORM",
		averages: "2", memdepth: "10000", func: "SINusoid",
		freq: "1.000000E+3", amp: "1.000000E0"
	};
	settings.syncQueries().forEach((step) => {
		const name = step.path[step.path.length - 1];
		if (step.path[0] === "timebase" && name === "mode") {
			answers[step.query.replace(/\?$/, "")] = "MAIN";
		} else if (step.path[0] === "trigger" && name === "mode") {
			answers[step.query.replace(/\?$/, "")] = "EDGE";
		} else {
			answers[step.query.replace(/\?$/, "")] = byName[name];
		}
	});
	return client;
};

describe("mho900 scope state layer", () => {
	it("syncs the model from the sync plan and emits change", () => {
		const fake = makeFake();
		const sync = syncLayer.createSync(fake, { log: () => {} });
		const scope = scopeLayer.createScope(sync);
		const changes = [];
		scope.on("change", (c) => changes.push(c));
		return scope.sync().then((model) => {
			expect(model.ch["1"].on).toBe(true);
			expect(model.ch["1"].scale).toBe(0.5);
			expect(model.ch["1"].coupling).toBe("DC");
			expect(model.ch["1"].impedance).toBe("1M");
			expect(model.timebase.mode).toBe("MAIN");
			expect(model.trigger.mode).toBe("EDGE");
			expect(model.awg["1"].freq).toBe(1000);
			expect(changes.length).toBe(1);
			expect(scope.isSynced()).toBe(true);
		});
	});

	it("set writes, confirms, and updates the model with the validated value", () => {
		const fake = makeFake();
		fake.answers[":CHAN1:SCALe"] = "2.5E-1";
		const sync = syncLayer.createSync(fake, { log: () => {} });
		const scope = scopeLayer.createScope(sync);
		const changes = [];
		scope.on("change", (c) => changes.push(c));
		return scope.set({ ch: { 1: { scale: 0.25 } }, trigger: { level: 0.1 } }).then((model) => {
			expect(model.ch["1"].scale).toBe(0.25);
			expect(model.trigger.level).toBe(0.1);
			expect(fake.writes).toEqual([":CHAN1:SCALe 0.25", ":TRIGger:EDGE:LEVel 0.1"]);
			// each write is followed by its confirm query
			expect(fake.queries).toEqual([":CHAN1:SCALe?", ":TRIGger:EDGE:LEVel?"]);
			expect(changes.length).toBe(1);
			expect(changes[0].paths).toEqual([["ch", 1, "scale"], ["trigger", "level"]]);
		});
	});

	it("rejects invalid values before any SCPI write", () => {
		const fake = makeFake();
		const sync = syncLayer.createSync(fake, { log: () => {} });
		const scope = scopeLayer.createScope(sync);
		return scope.set({ ch: { 1: { scale: 999 } } }).then(() => {
			throw new Error("should have failed");
		}, (err) => {
			expect(String(err)).toMatch("scale");
			expect(fake.writes).toEqual([]);
		});
	});

	it("accessors go through the sync layer serialized", () => {
		const fake = makeFake();
		fake.answers[":MEASure:ITEM"] = "5.0";
		const sync = syncLayer.createSync(fake, { log: () => {} });
		const scope = scopeLayer.createScope(sync);
		return scope.measure("VPP", "CHAN1").then((m) => {
			expect(m.value).toBe(5);
			expect(m.item).toBe("VPP");
			return scope.trigStatus();
		}).then((s) => {
			expect(s).toBe("TD");
			return scope.screen();
		}).then((png) => {
			expect(png.length).toBe(3);
		});
	});
});

describe("mho900 logic layer", () => {
	it("watch calls push on a fresh triggered status and stops cleanly", () => {
		const fake = makeFake();
		fake.answers[":WAV:PRE"] = "2,0,1000,1,1e-6,0,0,0.1,0,0";
		const sync = syncLayer.createSync(fake, { log: () => {} });
		const scope = scopeLayer.createScope(sync);
		const logic = logicLayer.createLogic(scope);
		const pushes = [];
		const res = logic.watch({ on: true, intervalMs: 200 }, (waves, opts) => {
			pushes.push({ waves: waves.length, opts: opts });
			return Promise.resolve();
		});
		expect(res.watching).toBe(true);
		return new Promise((resolve) => setTimeout(resolve, 700)).then(() => {
			logic.watch({ on: false }, () => null);
			expect(logic.watching()).toBe(false);
			expect(pushes.length).toBeGreaterThanOrEqual(1);
			expect(pushes[0].waves).toBe(1); // only CHAN1 enabled in the scripted model
		});
	});
});
