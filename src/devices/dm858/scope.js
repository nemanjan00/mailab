// State layer: the synced settings model of the meter. The sync plan is
// dynamic — the active function (SENSe:FUNCtion?) decides which per-function
// nodes (RANGe/AUTO/NPLC/RESolution/NULL) exist. All SCPI goes through the
// sync layer; model changes emit "change".

const settings = require("./settings");

const createMeter = (sync) => {
	const model = { measure: {}, null: {}, calc: {}, trigger: {}, system: {} };
	let synced = false;
	const listeners = { change: [], synced: [] };

	const on = (kind, fn) => {
		listeners[kind].push(fn);
		return () => {
			listeners[kind] = listeners[kind].filter((x) => x !== fn);
		};
	};
	const emit = (kind, arg) => {
		listeners[kind].forEach((fn) => fn(arg));
	};

	const runPlan = (plan) => {
		return plan.reduce((p, step) => {
			return p.then(() => {
				return sync.query(step.query).then((reply) => {
					settings.setPath(model, step.path, step.parse(reply.trim()));
				});
			});
		}, Promise.resolve());
	};

	const syncAll = () => {
		// function first, then the nodes that function supports
		return sync.query(settings.funcQuery.query).then((reply) => {
			settings.setPath(model, settings.funcQuery.path, settings.funcQuery.parse(reply));
			const func = model.measure.func;
			return runPlan(settings.syncQueries(func).concat(settings.commonSync()));
		}).then(() => {
			synced = true;
			emit("synced", model);
			emit("change", { paths: null });
			return model;
		});
	};

	const set = (partial) => {
		// need the active function to target per-function writes
		const ready = synced ? Promise.resolve() : syncAll();
		return ready.then(() => Promise.resolve().then(() => {
			const writes = settings.buildWrites(partial, model.measure.func);
			return writes.reduce((p, w) => {
				return p.then(() => {
					return sync.write(w.write);
				}).then(() => {
					return sync.query(w.confirm);
				}).then(() => {
					settings.setPath(model, w.path, w.value);
				});
			}, Promise.resolve()).then(() => {
				// switching function changes which sub-settings exist
				const switched = writes.some((w) => w.path[0] === "measure" && w.path[1] === "func");
				const refill = switched ? runPlan(settings.syncQueries(model.measure.func)) : Promise.resolve();
				return refill.then(() => {
					synced = true;
					emit("change", { paths: writes.map((w) => w.path) });
					return model;
				});
			});
		}));
	};

	// one reading in the active function (+ its unit); syncs first if needed
	const reading = () => {
		const ready = synced ? Promise.resolve() : syncAll();
		return ready.then(() => {
			return sync.query(":READ?").then((reply) => {
				const value = Number(reply.trim());
				return { value: value, func: model.measure.func, unit: settings.unitOf(model.measure.func) };
			});
		});
	};

	const write = (cmd) => sync.write(cmd);

	return {
		on: on,
		get: () => model,
		isSynced: () => synced,
		sync: syncAll,
		set: set,
		reading: reading,
		write: write
	};
};

module.exports = { createMeter: createMeter };
