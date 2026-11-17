// DM858: the settings model over a fake SCPI client. Wire syntax verified
// live on a real DM858 on the lab LAN (manuals/rigol/dm858 programming
// guide; NPLC is a discrete enum {0.4|5|20}).

const dm858 = require("..");
const settings = require("../settings");

// fake SCPI client: captures writes, answers queries from a script
const makeFake = (script) => {
	const writes = [];
	const queries = [];
	const answers = script || {};
	return {
		writes: writes,
		queries: queries,
		answers: answers,
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
		queryBinary: () => Promise.reject(new Error("not scripted")),
		close: () => {}
	};
};

const makeDriver = (fake) => {
	fake.answers["*IDN"] = "Rigol Technologies,DM858,fake,1.0";
	fake.answers[":SENSe:FUNCtion"] = "\"VOLT\"";
	fake.answers[":SENSe:VOLTage:DC:RANGe"] = "2.00000000E+00";
	fake.answers[":SENSe:VOLTage:DC:RANGe:AUTO"] = "1";
	fake.answers[":SENSe:VOLTage:DC:NPLC"] = "20";
	fake.answers[":SENSe:VOLTage:DC:RESolution"] = "1.00000000E-05";
	fake.answers[":SENSe:VOLTage:DC:NULL:STATe"] = "0";
	fake.answers[":SENSe:VOLTage:DC:NULL:VALue"] = "0.0";
	fake.answers[":CALCulate:AVERage:STATe"] = "0";
	fake.answers[":CALCulate:LIMit:STATe"] = "0";
	fake.answers[":CALCulate:LIMit:LOWer"] = "-110";
	fake.answers[":CALCulate:LIMit:UPPer"] = "110";
	fake.answers[":TRIGger:COUNt"] = "1";
	fake.answers[":TRIGger:SOURce"] = "IMM";
	fake.answers[":SYSTem:BEEPer:STATe"] = "1";
	fake.answers[":READ"] = "1.23450000E+00";
	return dm858.create({ _open: () => Promise.resolve(fake), autoSync: false }, {
		id: "dmm",
		log: () => {},
		sample: () => {},
		value: () => {},
		meta: () => {}
	});
};

describe("dm858 settings model", () => {
	it("syncs the model from the active function's nodes", () => {
		const fake = makeFake();
		const dev = makeDriver(fake);
		return dev.start().then(() => dev.command("sync", {})).then((model) => {
			expect(model.measure.func).toBe("VOLTage:DC");
			expect(model.measure.range).toBe(2);
			expect(model.measure.auto).toBe(true);
			expect(model.measure.nplc).toBe("20");
			expect(model.measure.resolution).toBe(1e-5);
			expect(model.null.state).toBe(false);
			expect(model.trigger.count).toBe(1);
			expect(model.system.beeper).toBe(true);
			// FUNCtion first, then the VOLTage:DC nodes, then the common ones
			// (the log also has *IDN? from startup and READ? from the legacy poll)
			const scpi = fake.queries.filter((q) => q.indexOf(":SENSe") === 0 || q.indexOf(":CALCulate") === 0 || q.indexOf(":TRIGger") === 0);
			expect(scpi[0]).toBe(":SENSe:FUNCtion?");
			expect(scpi[1]).toBe(":SENSe:VOLTage:DC:RANGe?");
		});
	});

	it("set writes, confirms, and retargets sub-settings after a func switch", () => {
		const fake = makeFake({
			":SENSe:CURRent:DC:RANGe": "5.00000000E-02",
			":SENSe:CURRent:DC:RANGe:AUTO": "0",
			":SENSe:CURRent:DC:RESolution": "1.00000000E-06",
			":SENSe:CURRent:DC:NPLC": "5",
			":SENSe:CURRent:DC:NULL:STATe": "0",
			":SENSe:CURRent:DC:NULL:VALue": "0.0"
		});
		const dev = makeDriver(fake);
		return dev.start().then(() => {
			return dev.command("set", { measure: { func: "DCI", range: 0.05, nplc: "5" } });
		}).then((model) => {
			expect(model.measure.func).toBe("CURRent:DC");
			expect(model.measure.range).toBe(0.05);
			// func first, then the new function's nodes
			expect(fake.writes[0]).toBe(":SENSe:FUNCtion \"CURRent:DC\"");
			expect(fake.writes).toContain(":SENSe:CURRent:DC:RANGe 0.05");
			expect(fake.writes).toContain(":SENSe:CURRent:DC:NPLC 5");
			// after the switch the CURRent:DC nodes were re-synced
			expect(fake.queries).toContain(":SENSe:CURRent:DC:RANGe?");
		});
	});

	it("rejects invalid values before any SCPI write", () => {
		const fake = makeFake();
		const dev = makeDriver(fake);
		return dev.start().then(() => {
			return dev.command("set", { measure: { nplc: 7 } });
		}).then(() => {
			throw new Error("should have failed");
		}, (err) => {
			expect(String(err)).toMatch("NPLC");
			expect(fake.writes).toEqual([]);
		});
	});

	it("freq range maps to the VOLTage:RANGe sub-node", () => {
		const writes = settings.buildWrites({ measure: { func: "freq", range: 1, auto: true } }, "VOLTage:DC");
		expect(writes[0].write).toBe(":SENSe:FUNCtion \"FREQuency\"");
		expect(writes[1].write).toBe(":SENSe:FREQuency:VOLTage:RANGe 1");
		expect(writes[2].write).toBe(":SENSe:FREQuency:VOLTage:RANGe:AUTO ON");
	});

	it("measure returns a reading with the active function's unit", () => {
		const fake = makeFake();
		const dev = makeDriver(fake);
		return dev.start().then(() => dev.command("measure", {})).then((r) => {
			expect(r.value).toBeCloseTo(1.2345, 4);
			expect(r.func).toBe("VOLTage:DC");
			expect(r.unit).toBe("V");
		});
	});

	it("normalizeFunc maps quoted FUNC? replies to canonical keys", () => {
		expect(settings.normalizeFunc("\"VOLT\"")).toBe("VOLTage:DC");
		expect(settings.normalizeFunc("\"VOLT:AC\"")).toBe("VOLTage:AC");
		expect(settings.normalizeFunc("\"RES\"")).toBe("RESistance");
		expect(settings.normalizeFunc("\"FRES\"")).toBe("FRESistance");
		expect(settings.normalizeFunc("\"CURR\"")).toBe("CURRent:DC");
	});
});
