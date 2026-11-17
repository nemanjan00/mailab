// State-sync layer (SCPI): the only place that talks to the unit.
//
// The MHO98/MHO900 FW takes NO interleaved queries on one TCP session and
// answers unknown headers with a 10 s timeout, so every exchange — watch
// polls included — is serialized through one chain here. Each exchange is
// emitted as a "tx"/"rx"/"error" event (and logged to the device console, so
// the log pane shows exactly what the AI sets and what the unit answers).

const createSync = (client, io) => {
	let chain = Promise.resolve();
	const listeners = { tx: [], rx: [], error: [] };

	const emit = (kind, text) => {
		listeners[kind].forEach((fn) => fn(text));
		if (io) {
			io.log(text, kind === "error" ? "error" : kind);
		}
	};

	const on = (kind, fn) => {
		listeners[kind].push(fn);
		return () => {
			listeners[kind] = listeners[kind].filter((x) => x !== fn);
		};
	};

	// run fn after everything queued so far; failures don't break the chain
	const exclusive = (fn) => {
		const job = chain.then(fn);
		chain = job.catch(() => null);
		return job;
	};

	const write = (cmd) => {
		return exclusive(() => {
			emit("tx", cmd);
			return client.write(cmd).catch((err) => {
				emit("error", cmd + " failed: " + err.message);
				throw err;
			});
		});
	};

	const query = (cmd) => {
		return exclusive(() => {
			emit("tx", cmd);
			return client.query(cmd).then((reply) => {
				emit("rx", String(reply).slice(0, 500));
				return reply;
			}, (err) => {
				emit("error", cmd + " failed: " + err.message);
				throw err;
			});
		});
	};

	const queryBinary = (cmd) => {
		return exclusive(() => {
			emit("tx", cmd);
			return client.queryBinary(cmd).then((data) => {
				emit("rx", cmd + " -> " + data.length + " bytes");
				return data;
			}, (err) => {
				emit("error", cmd + " failed: " + err.message);
				throw err;
			});
		});
	};

	return { write: write, query: query, queryBinary: queryBinary, on: on, exclusive: exclusive };
};

module.exports = { createSync: createSync };
