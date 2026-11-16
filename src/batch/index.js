// Batch: run a list of MCP tool calls inside one request, with precise timing.
// One round-trip to the AI costs seconds; here "set 5 V, wait 20 ms, capture"
// runs with ~1 ms accuracy.
//
// step: {tool, args, name, delayMs, at, repeat, intervalMs}
//   delayMs   wait this long before the step
//   at        wait until this many ms after the batch started
//   repeat    run the step N times, intervalMs apart (start to start)
//   name      keep the result for later steps: "$name" or "$name.a.b" in args
// options: {loop: {var, values}, stopOnError (default true)}
// (uses the global high-resolution `performance` clock)
//   loop      run all steps once per value; "$<var>" in args is the value


const MAX_DURATION_MS = 10 * 60 * 1000;
const MAX_CALLS = 10000;
// sleep with setTimeout until this close, then spin for accuracy
const SPIN_MS = 2;

const waitUntil = (deadline) => {
	const remaining = deadline - performance.now();
	if (remaining <= 0) {
		return Promise.resolve();
	}
	if (remaining > SPIN_MS) {
		return new Promise((resolve) => {
			setTimeout(resolve, remaining - SPIN_MS);
		}).then(() => {
			return waitUntil(deadline);
		});
	}
	while (performance.now() < deadline) {
		// spin for the last couple of ms
	}
	return Promise.resolve();
};

const getPath = (value, pathParts) => {
	return pathParts.reduce((acc, key) => {
		if (acc === undefined || acc === null) {
			return undefined;
		}
		return acc[key];
	}, value);
};

/**
 * Replace "$name" / "$name.path" strings (whole-string matches only) in args.
 */
const substitute = (value, scope) => {
	if (typeof value === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(value)) {
		const parts = value.slice(1).split(".");
		if (Object.prototype.hasOwnProperty.call(scope, parts[0])) {
			return getPath(scope[parts[0]], parts.slice(1));
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((v) => {
			return substitute(v, scope);
		});
	}
	if (value && typeof value === "object") {
		const out = {};
		Object.keys(value).forEach((key) => {
			out[key] = substitute(value[key], scope);
		});
		return out;
	}
	return value;
};

// keep batch results small: images become a marker
const compact = (result) => {
	if (result && result._image) {
		const rest = Object.assign({}, result);
		delete rest._image;
		rest.image = "[" + result._image.mime + " omitted in batch; use image_get]";
		return rest;
	}
	return result;
};

const round = (ms) => {
	return Math.round(ms * 1000) / 1000;
};

/**
 * @param {Object[]} steps
 * @param {{loop: {var: string, values: Array}, stopOnError: boolean}} options
 * @param {function(string, Object): Promise} invoke runs one tool
 * @returns {Promise<{ok: boolean, totalMs: number, calls: Object[]}>}
 */
const run = (steps, options, invoke) => {
	const opts = options || {};
	const stopOnError = opts.stopOnError !== false;
	let loopValues = [undefined];
	if (opts.loop) {
		loopValues = opts.loop.values;
	}
	const plan = loopValues.reduce((acc, loopValue, iteration) => {
		return acc.concat(steps.reduce((inner, step, index) => {
			const repeat = Math.max(1, step.repeat || 1);
			return inner.concat(Array.from({ length: repeat }, (_, r) => {
				return { step: step, index: index, iteration: iteration, loopValue: loopValue, rep: r };
			}));
		}, []));
	}, []);
	if (plan.length > MAX_CALLS) {
		return Promise.reject(new Error("batch too large: " + plan.length + " calls (max " + MAX_CALLS + ")"));
	}

	const t0 = performance.now();
	const scope = {};
	const calls = [];
	let failed = false;
	// start time of the previous repetition, per step, for intervalMs
	let lastStart = 0;

	const runOne = (item) => {
		if (failed && stopOnError) {
			return Promise.resolve();
		}
		if (performance.now() - t0 > MAX_DURATION_MS) {
			failed = true;
			calls.push({ step: item.index, ok: false, error: "batch exceeded " + MAX_DURATION_MS + " ms" });
			return Promise.resolve();
		}
		const step = item.step;
		let deadline = performance.now();
		if (item.rep > 0 && step.intervalMs) {
			deadline = lastStart + step.intervalMs;
		} else if (step.at !== undefined && item.iteration === 0) {
			deadline = t0 + step.at;
		} else if (step.delayMs) {
			deadline = performance.now() + step.delayMs;
		}
		if (opts.loop) {
			scope[opts.loop.var] = item.loopValue;
		}
		return waitUntil(deadline).then(() => {
			const start = performance.now();
			lastStart = start;
			const args = substitute(step.args || {}, scope);
			return Promise.resolve()
				.then(() => {
					return invoke(step.tool, args);
				})
				.then((result) => {
					const value = compact(result);
					if (step.name) {
						scope[step.name] = value;
					}
					calls.push({ step: item.index, tool: step.tool, name: step.name, loop: item.loopValue, t: round(start - t0), ms: round(performance.now() - start), ok: true, result: value });
				}, (err) => {
					failed = true;
					calls.push({ step: item.index, tool: step.tool, name: step.name, loop: item.loopValue, t: round(start - t0), ms: round(performance.now() - start), ok: false, error: err.message });
				});
		});
	};

	return plan.reduce((chain, item) => {
		return chain.then(() => {
			return runOne(item);
		});
	}, Promise.resolve()).then(() => {
		return { ok: !failed, totalMs: round(performance.now() - t0), calls: calls };
	});
};

module.exports = {
	run: run,
	substitute: substitute
};
