// Math over channels, built on mathjs.
//  - evaluate: one-shot expression, each channel is a vector of recent samples
//    (mean(vbus), std(i), max(abs(fft(sig))), ...)
//  - derived: per-sample expression over latest channel values (v * i)

const mathjs = require("mathjs");

const math = mathjs.create(mathjs.all);

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
