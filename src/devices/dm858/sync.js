// State-sync layer (SCPI): the only talker to the meter. One serialized
// chain (the FW, like the MHO98's, takes no interleaved queries) and every
// exchange emitted as tx/rx/error (also to the device console).

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

	return { write: write, query: query, on: on };
};

module.exports = { createSync: createSync };
