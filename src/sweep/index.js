// Generic sweep & optimize: step device-command parameters over a range,
// let things settle, measure channels, and tabulate (sweep), or search one
// parameter for the min/max of a channel expression (optimize).
//
// Device commands go through a safety gate (src/safety `gate`): the whole plan
// is shown to a person once if the approval policy matches any step.
//
// axis:  {device, command, arg, args, values | from, to, steps, scale: linear|log}
//        the value goes into args[arg]; "$value" anywhere in args is replaced too
// read:  "channel" or {channel, mode: mean|latest, windowMs}

const math = require("../math");
const substitute = require("../batch").substitute;

const MAX_POINTS = 2000;
const MAX_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_SETTLE_MS = 100;
const DEFAULT_WINDOW_MS = 200;
const DEFAULT_ITERATIONS = 20;
const MAX_ITERATIONS = 200;
// points checked against the approval policy before an optimize run
const OPTIMIZE_PLAN_POINTS = 33;
const POLL_MS = 5;
const PHI = (1 + Math.sqrt(5)) / 2;

const sleep = (ms) => new Promise((resolve) => {
	setTimeout(resolve, Math.max(0, ms));
});

/**
 * Values of an axis.
 * @param {{values: Array, from: number, to: number, steps: number, scale: string}} axis
 * @returns {Array}
 */
const values = (axis) => {
	if (Array.isArray(axis.values)) {
		if (!axis.values.length) {
			throw new Error("axis values are empty");
		}
		return axis.values.slice();
	}
	const from = Number(axis.from);
	const to = Number(axis.to);
	const steps = Math.floor(Number(axis.steps));
	if (!Number.isFinite(from) || !Number.isFinite(to)) {
		throw new Error("axis needs values, or from and to");
	}
	if (!(steps >= 1)) {
		throw new Error("axis needs steps >= 1 (number of points)");
	}
	if (steps === 1) {
		return [from];
	}
	if (axis.scale === "log") {
		if (from <= 0 || to <= 0) {
			throw new Error("log scale needs from and to > 0");
		}
		const ratio = Math.log(to / from);
		// exact end points (no 100.00000000000004)
		return Array.from({ length: steps }, (_, i) => (i === steps - 1 ? to : from * Math.exp((ratio * i) / (steps - 1))));
	}
	return Array.from({ length: steps }, (_, i) => (i === steps - 1 ? to : from + ((to - from) * i) / (steps - 1)));
};

const commandFor = (axis, value) => {
	const args = substitute(Object.assign({}, axis.args || {}), { value: value });
	if (axis.arg) {
		args[axis.arg] = value;
	}
	return { device: axis.device, command: axis.command, args: args };
};

const checkAxis = (axis, label) => {
	if (!axis || !axis.device || !axis.command) {
		throw new Error(label + " needs device and command");
	}
	if (!axis.arg && !JSON.stringify(axis.args || {}).includes("\"$value\"")) {
		throw new Error(label + " needs arg (the command argument to step) or \"$value\" in args");
	}
};

const normalizeReads = (reads, windowMs) => (reads || []).map((r) => {
	if (typeof r === "string") {
		return { channel: r, mode: "mean", windowMs: windowMs };
	}
	return { channel: r.channel, mode: r.mode || "mean", windowMs: r.windowMs || windowMs };
});

/**
 * Measure channels from now on: mean over the window, or the first fresh sample.
 * @returns {Promise<Object>} channel -> {value, n}
 */
const measure = (lab, reads) => {
	const since = Date.now();
	return Promise.all(reads.map((r) => {
		if (r.mode === "latest") {
			const deadline = since + r.windowMs;
			const poll = () => {
				const last = lab.channels.has(r.channel) ? lab.channels.latest(r.channel) : null;
				if (last && last.t > since) {
					return Promise.resolve({ value: last.v, n: 1 });
				}
				if (Date.now() >= deadline) {
					return Promise.resolve({ value: null, n: 0 });
				}
				return sleep(POLL_MS).then(poll);
			};
			return poll();
		}
		return sleep(r.windowMs).then(() => {
			if (!lab.channels.has(r.channel)) {
				return { value: null, n: 0 };
			}
			const v = lab.channels.read(r.channel, { since: since }).v;
			if (!v.length) {
				return { value: null, n: 0 };
			}
			return { value: v.reduce((a, b) => a + b, 0) / v.length, n: v.length };
		});
	})).then((results) => {
		const out = {};
		reads.forEach((r, i) => {
			out[r.channel] = results[i];
		});
		return out;
	});
};

/**
 * Run the steps, then spec.after even if a step failed (e.g. turn the output
 * off). The first error wins.
 * @param {function(): Promise} work
 */
const withAfter = (spec, gate, work) => {
	const after = (err) => {
		if (!spec.after) {
			return err ? Promise.reject(err) : Promise.resolve();
		}
		return gate.run(spec.after.device, spec.after.command, spec.after.args || {}).then(() => {
			if (err) {
				throw err;
			}
		}, (afterErr) => {
			throw err || afterErr;
		});
	};
	return Promise.resolve().then(work).then((result) => after(null).then(() => result), (err) => after(err));
};

const truthy = (v) => v === true || (typeof v === "number" && v !== 0 && !Number.isNaN(v));

const describeAxis = (axis, list) => ({
	device: axis.device, command: axis.command, arg: axis.arg || "$value",
	from: list[0], to: list[list.length - 1], points: list.length, scale: axis.scale || (Array.isArray(axis.values) ? "list" : "linear")
});

/**
 * Sweep one or two parameters and tabulate channel readings.
 * @param {Object} lab
 * @param {{name: string, x: Object, y: Object, reads: Array, settleMs: number, windowMs: number, stopWhen: string, after: Object, trace: boolean}} spec
 * @param {{preapprove: function, run: function}} gate from lab.safety.gate(who)
 * @returns {Promise<Object>} the table (also stored as value `name`)
 */
const sweep = (lab, spec, gate) => {
	const name = spec.name || "sweep";
	const settleMs = spec.settleMs === undefined ? DEFAULT_SETTLE_MS : spec.settleMs;
	const reads = normalizeReads(spec.reads, spec.windowMs || DEFAULT_WINDOW_MS);
	checkAxis(spec.x, "x");
	if (spec.y) {
		checkAxis(spec.y, "y");
	}
	if (!reads.length) {
		throw new Error("give reads: channels to measure at each point");
	}
	const stopWhen = spec.stopWhen ? math.compile(spec.stopWhen) : null;
	const xs = values(spec.x);
	const ys = spec.y ? values(spec.y) : [undefined];
	const points = ys.reduce((acc, y) => acc.concat(xs.map((x) => ({ x: x, y: y }))), []);
	if (points.length > MAX_POINTS) {
		throw new Error("sweep too large: " + points.length + " points (max " + MAX_POINTS + ")");
	}
	const perPoint = settleMs + reads.reduce((m, r) => Math.max(m, r.windowMs), 0);
	if (points.length * perPoint > MAX_DURATION_MS) {
		throw new Error("sweep would take about " + Math.round(points.length * perPoint / 1000) + " s (max " + MAX_DURATION_MS / 1000 + " s): fewer points or shorter settle/window");
	}
	const plan = points.reduce((acc, p, i) => {
		if (spec.y && (i === 0 || points[i - 1].y !== p.y)) {
			acc.push(commandFor(spec.y, p.y));
		}
		acc.push(commandFor(spec.x, p.x));
		return acc;
	}, []).concat(spec.after ? [spec.after] : []);
	const columns = ["x"].concat(spec.y ? ["y"] : [], reads.map((r) => r.channel));
	const rows = [];
	const started = Date.now();
	let stopped = null;
	let lastY;

	const step = (p) => {
		if (stopped) {
			return Promise.resolve();
		}
		let setY = Promise.resolve();
		if (spec.y && p.y !== lastY) {
			const c = commandFor(spec.y, p.y);
			setY = gate.run(c.device, c.command, c.args);
			lastY = p.y;
		}
		return setY
			.then(() => {
				const c = commandFor(spec.x, p.x);
				return gate.run(c.device, c.command, c.args);
			})
			.then(() => sleep(settleMs))
			.then(() => measure(lab, reads))
			.then((m) => {
				const row = [p.x].concat(spec.y ? [p.y] : [], reads.map((r) => m[r.channel].value));
				rows.push(row);
				if (stopWhen) {
					const scope = { x: p.x, y: p.y };
					reads.forEach((r) => {
						scope[r.channel] = m[r.channel].value === null ? NaN : m[r.channel].value;
					});
					let hit;
					try {
						hit = truthy(stopWhen.evaluate(scope));
					} catch (_err) {
						hit = false;
					}
					if (hit) {
						stopped = { x: p.x, y: p.y, when: spec.stopWhen };
					}
				}
			});
	};

	const finish = (error) => {
		const table = {
			kind: "sweep",
			x: describeAxis(spec.x, xs),
			y: spec.y ? describeAxis(spec.y, ys) : undefined,
			reads: reads,
			settleMs: settleMs,
			columns: columns,
			rows: rows,
			stopped: stopped,
			error: error || undefined,
			started: started,
			ms: Date.now() - started
		};
		lab.setValue(name, table, "sweep");
		if (spec.trace !== false) {
			const numeric = xs.every((x) => typeof x === "number");
			const xAxis = numeric ? xs : xs.map((_, i) => i);
			const series = [];
			ys.forEach((y, yi) => {
				reads.forEach((r, ri) => {
					const col = (spec.y ? 2 : 1) + ri;
					const ySeries = xs.map((_, xi) => {
						const row = rows[yi * xs.length + xi];
						return row && row[col] !== null ? row[col] : NaN;
					});
					series.push({ label: spec.y ? r.channel + " @ y=" + y : r.channel, y: ySeries });
				});
			});
			lab.setTrace(name, { x: xAxis, series: series, xUnit: spec.x.unit || spec.x.arg || "x", yUnit: spec.yUnit || "" }, "sweep");
			table.trace = name;
		}
		table.value = name;
		return table;
	};

	const label = "sweep " + spec.x.device + "." + spec.x.command + (spec.y ? " × " + spec.y.device + "." + spec.y.command : "");
	return gate.preapprove(plan, label)
		.then(() => withAfter(spec, gate, () => points.reduce((chain, p) => chain.then(() => step(p)), Promise.resolve())))
		.then(() => finish(null), (err) => {
			// keep what was measured before the failure
			if (rows.length) {
				finish(err.message);
			}
			throw err;
		});
};

/**
 * Search one parameter for the min or max of an expression over channels.
 * @param {Object} lab
 * @param {{name: string, param: Object, objective: string, goal: string, method: string, maxIterations: number,
 *   tolerance: number, step: number, start: number, settleMs: number, windowMs: number, mode: string, after: Object}} spec
 *   param: {device, command, arg, args, min, max}; method golden (default, unimodal) or hill
 * @param {{preapprove: function, run: function}} gate
 */
const optimize = (lab, spec, gate) => {
	const name = spec.name || "optimize";
	const p = spec.param || {};
	checkAxis(p, "param");
	const min = Number(p.min);
	const max = Number(p.max);
	if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
		throw new Error("param needs min < max");
	}
	if (!spec.objective) {
		throw new Error("give an objective: a mathjs expression over channels, e.g. \"rx_rssi\" or \"psu_v * psu_i\"");
	}
	const goal = spec.goal === "max" ? "max" : "min";
	const sign = goal === "max" ? -1 : 1;
	const method = spec.method === "hill" ? "hill" : "golden";
	const maxIterations = Math.min(Math.max(1, Math.floor(spec.maxIterations || DEFAULT_ITERATIONS)), MAX_ITERATIONS);
	const tolerance = spec.tolerance || (max - min) / 1000;
	const settleMs = spec.settleMs === undefined ? DEFAULT_SETTLE_MS : spec.settleMs;
	const windowMs = spec.windowMs || DEFAULT_WINDOW_MS;
	if (maxIterations * (settleMs + windowMs) > MAX_DURATION_MS) {
		throw new Error("optimize could take " + Math.round(maxIterations * (settleMs + windowMs) / 1000) + " s (max " + MAX_DURATION_MS / 1000 + " s)");
	}
	const compiled = math.compile(spec.objective);
	const reads = compiled.inputs.filter((s) => s !== "x" && lab.channels.has(s)).map((c) => ({ channel: c, mode: spec.mode || "mean", windowMs: windowMs }));
	const evaluations = [];
	// x -> objective, so a search revisiting a point doesn't measure it again
	const cache = {};

	const f = (x) => {
		const key = String(x);
		if (cache[key] !== undefined) {
			return Promise.resolve(cache[key]);
		}
		if (evaluations.length >= maxIterations) {
			return Promise.resolve(null);
		}
		const c = commandFor(p, x);
		return gate.run(c.device, c.command, c.args)
			.then(() => sleep(settleMs))
			.then(() => measure(lab, reads))
			.then((m) => {
				const scope = { x: x };
				const readings = {};
				reads.forEach((r) => {
					scope[r.channel] = m[r.channel].value === null ? NaN : m[r.channel].value;
					readings[r.channel] = m[r.channel].value;
				});
				let value;
				try {
					value = compiled.evaluate(scope);
				} catch (_err) {
					value = NaN;
				}
				evaluations.push({ x: x, value: Number.isFinite(value) ? value : null, reads: readings });
				// unmeasurable points are the worst possible
				cache[key] = Number.isFinite(value) ? sign * value : Infinity;
				return cache[key];
			});
	};

	const budgetLeft = () => evaluations.length < maxIterations;

	const golden = () => {
		const search = (a, b, c, d, fc, fd) => {
			if (Math.abs(b - a) <= tolerance || !budgetLeft()) {
				return Promise.resolve(Math.abs(b - a) <= tolerance);
			}
			// keep the better inner point, shrink towards it
			if (fc < fd) {
				const nc = d - (d - a) / PHI;
				return f(nc).then((fnc) => search(a, d, nc, c, fnc, fc));
			}
			const nd = c + (b - c) / PHI;
			return f(nd).then((fnd) => search(c, b, d, nd, fd, fnd));
		};
		const c = max - (max - min) / PHI;
		const d = min + (max - min) / PHI;
		return f(c).then((fc) => f(d).then((fd) => search(min, max, c, d, fc, fd)));
	};

	const hill = () => {
		const clamp = (x) => Math.min(max, Math.max(min, x));
		const climb = (x, fx, stepSize) => {
			if (stepSize < tolerance) {
				return Promise.resolve(true);
			}
			if (!budgetLeft()) {
				return Promise.resolve(false);
			}
			const up = clamp(x + stepSize);
			const down = clamp(x - stepSize);
			return f(up).then((fu) => {
				if (fu !== null && fu < fx) {
					return climb(up, fu, stepSize);
				}
				return f(down).then((fdn) => {
					if (fdn !== null && fdn < fx) {
						return climb(down, fdn, stepSize);
					}
					return climb(x, fx, stepSize / 2);
				});
			});
		};
		const start = spec.start === undefined ? (min + max) / 2 : clamp(Number(spec.start));
		return f(start).then((fs) => climb(start, fs, spec.step || (max - min) / 10));
	};

	const finish = (converged) => {
		const valid = evaluations.filter((e) => e.value !== null);
		const best = valid.reduce((acc, e) => (acc === null || sign * e.value < sign * acc.value ? e : acc), null);
		const result = {
			kind: "optimize",
			param: { device: p.device, command: p.command, arg: p.arg || "$value", min: min, max: max },
			objective: spec.objective,
			goal: goal,
			method: method,
			converged: converged,
			best: best,
			evaluations: evaluations,
			value: name,
			trace: name
		};
		lab.setValue(name, result, "optimize");
		lab.setTrace(name, {
			mode: "scatter",
			xUnit: p.unit || p.arg || "x",
			yUnit: spec.objective,
			series: [{ label: spec.objective, x: valid.map((e) => e.x), y: valid.map((e) => e.value) }]
		}, "optimize");
		return result;
	};

	const planXs = Array.from({ length: OPTIMIZE_PLAN_POINTS }, (_, i) => min + ((max - min) * i) / (OPTIMIZE_PLAN_POINTS - 1));
	const plan = planXs.map((x) => commandFor(p, x)).concat(spec.after ? [spec.after] : []);
	return gate.preapprove(plan, "optimize " + p.device + "." + p.command + " " + (p.arg || "$value") + " " + min + ".." + max)
		.then(() => withAfter(spec, gate, () => (method === "hill" ? hill() : golden())))
		.then(finish);
};

module.exports = {
	values: values,
	sweep: sweep,
	optimize: optimize,
	MAX_POINTS: MAX_POINTS
};
