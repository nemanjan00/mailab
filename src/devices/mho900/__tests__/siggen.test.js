// Rigol MHO900: siggen (AWG :SOURce) commands against a fake SCPI client.
// Hardware is unreachable (LAN SCPI doesn't answer yet), so the exact wire
// syntax can't be verified here — these tests pin the command construction.

const mho900 = require("..");

// A fake SCPI client: captures writes, answers queries from a script.
const makeFake = () => {
	const writes = [];
	const queries = [];
	const answers = {};
	return {
		writes: writes,
		queries: queries,
		answers: answers,
		write: (command) => {
			writes.push(command);
			return Promise.resolve();
		},
		query: (command) => {
			queries.push(command);
			const rest = command.replace(/\?$/, "");
			let key = null;
			Object.keys(answers).forEach((k) => {
				if (rest.indexOf(k) === 0 && (!key || k.length > key.length)) {
					key = k;
				}
			});
			if (!key) {
				return Promise.reject(new Error("no scripted answer for " + command));
			}
			return Promise.resolve(answers[key]);
		},
		queryBinary: () => {
			return Promise.reject(new Error("not scripted"));
		},
		close: () => {}
	};
};

const makeDriver = (fake) => {
	fake.answers["*IDN"] = "RIGOL,MHO900,fake,1.0";
	return mho900.create({ _open: () => Promise.resolve(fake) }, {
		id: "mho",
		log: () => {},
		sample: () => {},
		value: () => {}
	});
};

describe("mho900 siggen", () => {
	it("sets func/freq/amp/offset/state then queries the result back", () => {
		const fake = makeFake();
		const driver = makeDriver(fake);
		fake.answers[":SOURce1:FUNCtion"] = "SINusoid";
		fake.answers[":SOURce1:FREQuency"] = "1000";
		fake.answers[":SOURce1:VOLTage"] = "2.5";
		fake.answers[":SOURce1:VOLTage:OFFSet"] = "0.1";
		fake.answers[":SOURce1:OUTPut"] = "1";
		return driver.start().then(() => {
			return driver.command("siggen", {
				source: 1, func: "sin", freq: 1000, amp: 2.5, offset: 0.1, state: true
			});
		}).then((state) => {
			expect(fake.writes).toEqual([
				":SOURce1:FUNCtion SINusoid",
				":SOURce1:FREQuency 1000",
				":SOURce1:VOLTage 2.5",
				":SOURce1:VOLTage:OFFSet 0.1",
				":SOURce1:OUTPut ON"
			]);
			expect(state).toEqual({
				source: 1, func: "SINusoid", freq: 1000, amp: 2.5, offset: 0.1, on: true
			});
			expect(fake.queries.filter((q) => {
				return q.indexOf(":SOURce") === 0;
			}).length).toBe(5);
		});
	});

	it("prefix-matches func names and rejects unknown ones", () => {
		const fake = makeFake();
		const driver = makeDriver(fake);
		fake.answers[":SOURce2:FUNCtion"] = "SQUare";
		fake.answers[":SOURce2:FREQuency"] = "100";
		fake.answers[":SOURce2:VOLTage"] = "1";
		fake.answers[":SOURce2:VOLTage:OFFSet"] = "0";
		fake.answers[":SOURce2:OUTPut"] = "OFF";
		return driver.start().then(() => {
			return driver.command("siggen", { source: 2, func: "squ" });
		}).then((state) => {
			expect(fake.writes).toEqual([":SOURce2:FUNCtion SQUare"]);
			expect(state.func).toBe("SQUare");
			return driver.command("siggen", { func: "triangle" });
		}).then(() => {
			throw new Error("should have rejected");
		}, (err) => {
			expect(err.message).toMatch(/func must be one of/);
		});
	});

	it("defaults to source 1 and only writes what was given", () => {
		const fake = makeFake();
		const driver = makeDriver(fake);
		fake.answers[":SOURce1:FUNCtion"] = "DC";
		fake.answers[":SOURce1:FREQuency"] = "0";
		fake.answers[":SOURce1:VOLTage"] = "0";
		fake.answers[":SOURce1:VOLTage:OFFSet"] = "0";
		fake.answers[":SOURce1:OUTPut"] = "0";
		return driver.start().then(() => {
			return driver.command("siggen", { freq: 440 });
		}).then(() => {
			expect(fake.writes).toEqual([":SOURce1:FREQuency 440"]);
		});
	});

	it("siggen_on/off toggle the output", () => {
		const fake = makeFake();
		const driver = makeDriver(fake);
		return driver.start().then(() => {
			return driver.command("siggen_on", {});
		}).then(() => {
			return driver.command("siggen_off", { source: 2 });
		}).then(() => {
			expect(fake.writes).toEqual([
				":SOURce1:OUTPut ON",
				":SOURce2:OUTPut OFF"
			]);
		});
	});
});
