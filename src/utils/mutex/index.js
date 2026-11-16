// Serialize async work without timers: each call waits for the previous one.
// (Replaces queue-promised's wrapper for locks: after a call it kept a 1 ms
// setTimeout loop running forever, burning CPU and keeping processes alive.)

/**
 * @param {function(...*): Promise} [fn] function to serialize; omit for a
 *   generic lock: lock(() => work())
 * @returns {function(...*): Promise}
 */
const serialize = (fn) => {
	let tail = Promise.resolve();
	return (...args) => {
		const run = tail.then(() => {
			if (fn) {
				return fn.apply(null, args);
			}
			return args[0]();
		});
		// the next call waits for this one, whether it resolved or failed
		tail = run.then(() => null, () => null);
		return run;
	};
};

module.exports = {
	serialize: serialize
};
