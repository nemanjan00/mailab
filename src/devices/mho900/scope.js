// State layer: the synced settings model of the scope plus raw state
// accessors (waveform, screen, trigger status, measurement). All SCPI goes
// through the sync layer; changes to the model are emitted as "change"
// events so higher layers (and the UI) can react without polling.

const settings = require("./settings");

// :WAV:PRE? -> format,type,points,count,xinc,xorigin,xref,yinc,yorigin,yref
const parsePreamble = (reply) => {
	const f = reply.split(",").map(Number);
	return {
		points: f[2],
		xincrement: f[4],
		xorigin: f[5],
		xreference: f[6],
		yincrement: f[7],
		yorigin: f[8],
		yreference: f[9]
	};
};

const createScope = (sync) => {
	const model = { ch: {}, timebase: {}, trigger: {}, acquire: {}, awg: {} };
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

	// re-read every setting from the unit into the model. Settings of
	// channels that are off are skipped (their UI fields stay empty until
	// the channel turns on, then set() syncs just that channel).
	const syncAll = () => {
		const off = {};
		return settings.syncQueries().reduce((p, step) => {
			return p.then(() => {
				if (step.chan && off[step.chan]) {
					return null;
				}
				return sync.query(step.query).then((reply) => {
					const value = step.parse(reply.trim());
					if (step.chan && step.path[2] === "on") {
						off[step.chan] = !value;
					}
					settings.setPath(model, step.path, value);
				});
			});
		}, Promise.resolve()).then(() => {
			synced = true;
			emit("synced", model);
			emit("change", { paths: null });
			return model;
		});
	};

	// intent-level partial update: validate, write, read back into the model
	// (validation failures become rejections, not sync throws, so command
	// surfaces see a normal failed promise)
	const set = (partial) => {
		return Promise.resolve().then(() => {
			const writes = settings.buildWrites(partial);
			const applied = writes.reduce((p, w) => {
				return p.then(() => {
					return sync.write(w.write);
				}).then(() => {
					return sync.query(w.confirm);
				}).then(() => {
					settings.setPath(model, w.path, w.value);
				});
			}, Promise.resolve());
			return applied.then(() => {
				// a channel that just came on has no cached settings yet (syncAll
				// skips off channels): fill just that channel now
				const woken = writes.filter((w) => {
					return w.path[0] === "ch" && w.path[2] === "on" && w.value;
				}).map((w) => w.path[1]);
				return woken.reduce((p, n) => {
					return p.then(() => {
						return settings.syncQueries({ chan: n }).reduce((q, step) => {
							return q.then(() => {
								return sync.query(step.query).then((reply) => {
									settings.setPath(model, step.path, step.parse(reply.trim()));
								});
							});
						}, Promise.resolve());
					});
				}, Promise.resolve());
			}).then(() => {
				synced = true;
				emit("change", { paths: writes.map((w) => w.path) });
				return model;
			});
		});
	};

	// ---- raw state accessors (all serialized through the sync layer) ------

	const waveform = (source) => {
		return sync.write(":WAV:SOUR " + source)
			.then(() => {
				return sync.write(":WAV:MODE NORM");
			})
			.then(() => {
				return sync.write(":WAV:FORM BYTE");
			})
			.then(() => {
				return sync.query(":WAV:PRE?");
			})
			.then((reply) => {
				const pre = parsePreamble(reply);
				return sync.queryBinary(":WAV:DATA?").then((data) => {
					// TODO: verify BYTE scaling on MHO900 (12-bit ADC; WORD may be better)
					const y = Array.from(data).map((b) => {
						return (b - pre.yorigin - pre.yreference) * pre.yincrement;
					});
					const x = y.map((_, i) => {
						return (i - pre.xreference) * pre.xincrement + pre.xorigin;
					});
					return { source: source, x: x, y: y, pre: pre };
				});
			});
	};

	const screen = () => {
		return sync.queryBinary(":DISPlay:DATA? PNG");
	};

	const trigStatus = () => {
		return sync.query(":TRIGger:STATus?").then((s) => s.trim());
	};

	const measure = (item, source) => {
		return sync.query(":MEASure:ITEM? " + item + "," + (source || "CHAN1")).then((reply) => {
			return { item: item, source: source || "CHAN1", value: Number(reply) };
		});
	};

	const write = (cmd) => sync.write(cmd);

	return {
		on: on,
		get: () => model,
		isSynced: () => synced,
		sync: syncAll,
		set: set,
		waveform: waveform,
		screen: screen,
		trigStatus: trigStatus,
		measure: measure,
		write: write
	};
};

module.exports = { createScope: createScope, parsePreamble: parsePreamble };
