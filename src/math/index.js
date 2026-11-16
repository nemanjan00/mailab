// Math over channels, built on mathjs.
//  - evaluate: one-shot expression, each channel is a vector of recent samples
//    (mean(vbus), std(i), max(abs(fft(sig))), ...)
//  - derived: per-sample expression over latest channel values (v * i)

const mathjs = require("mathjs");

const math = mathjs.create(mathjs.all);

const flat = (values) => {
	if (mathjs.isMatrix(values)) {
		return values.toArray().flat(Infinity);
	}
	return [].concat(values).flat(Infinity);
};

// apply fn to a number or every element of an array/matrix
const elementwise = (fn) => {
	return (value) => {
		if (typeof value === "number") {
			return fn(value);
		}
		return math.map(value, fn);
	};
};

// lab helpers on top of mathjs
math.import({
	rms: (values) => {
		const v = flat(values);
		return Math.sqrt(v.reduce((sum, x) => {
			return sum + x * x;
		}, 0) / v.length);
	},
	vpp: (values) => {
		const v = flat(values);
		return Math.max.apply(null, v) - Math.min.apply(null, v);
	},
	db: elementwise((x) => {
		return 10 * Math.log10(x);
	}),
	undb: elementwise((x) => {
		return Math.pow(10, x / 10);
	}),
	dbm2w: elementwise((x) => {
		return Math.pow(10, (x - 30) / 10);
	}),
	w2dbm: elementwise((x) => {
		return 10 * Math.log10(x) + 30;
	}),
	mag: (values) => {
		if (mathjs.isComplex(values) || typeof values === "number") {
			return math.abs(values);
		}
		return math.map(values, (x) => {
			return math.abs(x);
		});
	}
});

const MAX_RESULT_ITEMS = 2000;

const toPlain = (value) => {
	if (mathjs.isMatrix(value)) {
		return toPlain(value.toArray());
	}
	if (Array.isArray(value)) {
		return value.slice(0, MAX_RESULT_ITEMS).map(toPlain);
	}
	if (mathjs.isComplex(value)) {
		return { re: value.re, im: value.im };
	}
	if (mathjs.isUnit(value) || mathjs.isFraction(value) || mathjs.isBigNumber(value)) {
		return value.toString();
	}
	if (typeof value === "function") {
		return "[function]";
	}
	return value;
};

const symbols = (expression) => {
	const names = math.parse(expression)
		.filter((node) => {
			return node.isSymbolNode;
		})
		.map((node) => {
			return node.name;
		});
	return Array.from(new Set(names));
};

const mathModule = {
	symbols: symbols,

	tex: (expression) => {
		return math.parse(expression).toTex({ parenthesis: "keep", implicit: "hide" });
	},

	/**
	 * @param {string} expression
	 * @param {Object} scope variable name -> value
	 * @returns {{value: *, text: string}}
	 */
	evaluate: (expression, scope) => {
		const result = math.evaluate(expression, Object.assign({}, scope));
		return {
			value: toPlain(result),
			text: math.format(result, { precision: 6 })
		};
	},

	/**
	 * Compile a derived-channel expression.
	 * @returns {{expression: string, inputs: string[], evaluate: function(Object): number}}
	 */
	compile: (expression) => {
		const compiled = math.compile(expression);
		return {
			expression: expression,
			inputs: symbols(expression),
			evaluate: (scope) => {
				return Number(compiled.evaluate(Object.assign({}, scope)));
			}
		};
	}
};

module.exports = mathModule;
