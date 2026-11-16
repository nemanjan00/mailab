// Graphing calculator: evaluate mathjs expressions into plottable series.
//   "sin(x) * exp(-x/5)"            y = f(x) over [xmin, xmax]
//   {x: "cos(t)", y: "sin(2t)"}     parametric over t in [tmin, tmax]
//   "db(mag(fft(scope_ch1)))"      no x: an array result, plotted against its index
// Lab channels (recent samples) and traces (first series) are in scope by name.

const mathjs = require("mathjs");
const math = require("../math");

const DEFAULT_POINTS = 500;
const MAX_POINTS = 20000;

const linspace = (min, max, n) => {
	return Array.from({ length: n }, (_, i) => {
		return min + (max - min) * i / (n - 1);
	});
};

const toNumbers = (value) => {
	let v = value;
	if (mathjs.isMatrix(v)) {
		v = v.toArray();
	}
	if (!Array.isArray(v)) {
		return null;
	}
	return v.flat(Infinity).map((item) => {
		if (mathjs.isComplex(item)) {
			return mathjs.abs(item);
		}
		return Number(item);
	});
};

const finite = (n) => {
	return Number.isFinite(n) ? n : null;
};

/**
 * @param {function(string[]): Object} scopeFor builds a scope with the lab data a set of symbols needs
 * @param {{exprs: Array, xmin: number, xmax: number, tmin: number, tmax: number, points: number}} spec
 * @returns {{x: number[], series: Object[], xUnit: string, mode: string}}
 */
const plot = (scopeFor, spec) => {
	const n = Math.min(MAX_POINTS, Math.max(2, Number(spec.points) || DEFAULT_POINTS));
	const xs = linspace(Number(spec.xmin === undefined ? -10 : spec.xmin), Number(spec.xmax === undefined ? 10 : spec.xmax), n);
	const ts = linspace(Number(spec.tmin === undefined ? 0 : spec.tmin), Number(spec.tmax === undefined ? 2 * Math.PI : spec.tmax), n);
	const exprs = [].concat(spec.exprs || []);
	if (!exprs.length) {
		throw new Error("give at least one expression");
	}

	const curve = (expr) => {
		// parametric
		if (expr && typeof expr === "object") {
			const fx = math.compile(String(expr.x));
			const fy = math.compile(String(expr.y));
			const scope = scopeFor(fx.inputs.concat(fy.inputs));
			return {
				label: expr.label || "(" + expr.x + ", " + expr.y + ")",
				x: ts.map((t) => finite(fx.evaluate(Object.assign({}, scope, { t: t })))),
				y: ts.map((t) => finite(fy.evaluate(Object.assign({}, scope, { t: t }))))
			};
		}
		const text = String(expr);
		const scope = scopeFor(math.symbols(text));
		const first = math.evaluate(text, Object.assign({}, scope, { x: xs[0] })).value;
		// array result: data expression, plotted against its index
		if (Array.isArray(first)) {
			const ys = toNumbers(math.evaluate(text, scope).value) || [];
			return { label: text, x: ys.map((_, i) => i), y: ys.map(finite) };
		}
		const f = math.compile(text);
		return {
			label: text,
			x: xs,
			y: xs.map((x) => {
				try {
					return finite(f.evaluate(Object.assign({}, scope, { x: x })));
				} catch (_err) {
					return null;
				}
			})
		};
	};

	const curves = exprs.map(curve);
	return {
		// series carry their own x (they may differ: functions, parametric, data)
		x: curves[0].x,
		series: curves.map((c) => ({ label: c.label, x: c.x, y: c.y })),
		xUnit: spec.xUnit || "",
		yUnit: spec.yUnit || "",
		mode: "plot"
	};
};

module.exports = {
	plot: plot
};
