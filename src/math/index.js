// Math over channels, built on mathjs.
//  - evaluate: one-shot expression, each channel is a vector of recent samples
//    (mean(vbus), std(i), max(abs(fft(sig))), ...)
//  - derived: per-sample expression over latest channel values (v * i)

const mathjs = require("mathjs");

const math = mathjs.create(mathjs.all);

// mailab's own entry points, kept before the sandbox below disables them
// inside expressions (mathjs security guidance)
const parse = math.parse;
const compile = math.compile;
const evaluate = math.evaluate;

// largest matrix/array an expression may create (elements): beyond this a
// single expression could exhaust memory and take the whole lab down
const MAX_ELEMENTS = 1000000;

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
	// beamforming (uniform linear array; d in wavelengths, angles in degrees)
	steering: (n, d, thetaDeg) => {
		const k = 2 * Math.PI * d * Math.sin(thetaDeg * Math.PI / 180);
		return math.matrix(Array.from({ length: n }, (_, i) => math.complex({ r: 1, phi: k * i })));
	},
	array_factor_db: (n, d, steerDeg, thetaDeg) => {
		const psi = 2 * Math.PI * d * (Math.sin(thetaDeg * Math.PI / 180) - Math.sin(steerDeg * Math.PI / 180));
		let re = 0;
		let im = 0;
		for (let i = 0; i < n; i++) {
			re += Math.cos(psi * i);
			im += Math.sin(psi * i);
		}
		// -100 dB floor: exact nulls would otherwise dominate any plot
		return Math.max(-100, 20 * Math.log10(Math.sqrt(re * re + im * im) / n + 1e-12));
	},
	// normalized |array response| at theta for a beam steered to steerDeg (0..1)
	array_factor: (n, d, steerDeg, thetaDeg) => {
		const psi = 2 * Math.PI * d * (Math.sin(thetaDeg * Math.PI / 180) - Math.sin(steerDeg * Math.PI / 180));
		let re = 0;
		let im = 0;
		for (let i = 0; i < n; i++) {
			re += Math.cos(psi * i);
			im += Math.sin(psi * i);
		}
		return Math.sqrt(re * re + im * im) / n;
	},
	mag: (values) => {
		if (mathjs.isComplex(values) || typeof values === "number") {
			return math.abs(values);
		}
		return math.map(values, (x) => {
			return math.abs(x);
		});
	}
});

// ---- sandbox ------------------------------------------------------------

const disabled = (name) => {
	return () => {
		throw new Error(name + " is disabled in lab expressions");
	};
};

const elements = (size) => {
	return [].concat(size).flat(Infinity).reduce((n, d) => n * Number(d), 1);
};

const sizeOf = (value) => {
	if (mathjs.isMatrix(value)) {
		return value.size();
	}
	if (Array.isArray(value)) {
		return mathjs.size(value).valueOf();
	}
	return [1];
};

const capped = (name, count) => {
	if (!Number.isFinite(count) || count > MAX_ELEMENTS) {
		throw new Error(name + ": result too large (" + count + " elements, max " + MAX_ELEMENTS + ")");
	}
};

// wrap a function, checking the result size it would produce from its arguments first
const guard = (name, estimate) => {
	const original = math[name];
	return mathjs.typed(name, {
		"...any": (args) => {
			capped(name, estimate(args));
			return original.apply(null, args);
		}
	});
};

// size arguments may be numbers, an array of numbers, or a matrix of numbers
const dims = (args) => {
	const numeric = args.filter((a) => typeof a === "number" || Array.isArray(a) || mathjs.isMatrix(a));
	if (!numeric.length) {
		return 1;
	}
	if (numeric.length === 1 && typeof numeric[0] !== "number") {
		return elements(mathjs.isMatrix(numeric[0]) ? numeric[0].toArray() : numeric[0]);
	}
	return elements(numeric.filter((a) => typeof a === "number"));
};

const rangeCount = (args) => {
	if (typeof args[0] === "string") {
		const parts = args[0].split(":").map(Number);
		return Math.abs((parts[parts.length === 3 ? 2 : 1] - parts[0]) / (parts.length === 3 ? parts[1] : 1)) + 1;
	}
	const step = args.length >= 3 && typeof args[2] === "number" ? args[2] : 1;
	return Math.abs((Number(args[1]) - Number(args[0])) / (step || 1)) + 1;
};

// result size of an element-wise op with broadcasting: max of each dimension
const broadcast = (args) => {
	const shapes = args.map(sizeOf);
	const rank = Math.max.apply(null, shapes.map((sh) => sh.length));
	const out = Array.from({ length: rank }, (_, i) => {
		return Math.max.apply(null, shapes.map((sh) => sh[sh.length - rank + i] || 1));
	});
	return elements(out);
};

math.import({
	import: disabled("import"),
	createUnit: disabled("createUnit"),
	evaluate: disabled("evaluate"),
	parse: disabled("parse"),
	compile: disabled("compile"),
	simplify: disabled("simplify"),
	derivative: disabled("derivative"),
	resolve: disabled("resolve"),
	reviver: disabled("reviver"),
	zeros: guard("zeros", dims),
	ones: guard("ones", dims),
	identity: guard("identity", (args) => {
		const n = args.filter((a) => typeof a === "number");
		return n.length > 1 ? n[0] * n[1] : (n[0] || 1) * (n[0] || 1);
	}),
	random: guard("random", (args) => (Array.isArray(args[0]) || mathjs.isMatrix(args[0]) ? dims([args[0]]) : 1)),
	randomInt: guard("randomInt", (args) => (Array.isArray(args[0]) || mathjs.isMatrix(args[0]) ? dims([args[0]]) : 1)),
	range: guard("range", rangeCount),
	resize: guard("resize", (args) => dims([args[1]])),
	reshape: guard("reshape", (args) => dims([args[1]])),
	concat: guard("concat", (args) => args.filter((a) => typeof a !== "number").reduce((n, a) => n + elements(sizeOf(a)), 0)),
	kron: guard("kron", (args) => elements(sizeOf(args[0])) * elements(sizeOf(args[1]))),
	// element-wise ops broadcast N×1 with 1×N into N×N
	add: guard("add", broadcast),
	subtract: guard("subtract", broadcast),
	dotMultiply: guard("dotMultiply", broadcast),
	dotDivide: guard("dotDivide", broadcast),
	dotPow: guard("dotPow", broadcast),
	// matrix products: rows(a) * cols(b) for the outer-product case
	multiply: guard("multiply", (args) => {
		if (args.length !== 2) {
			return 1;
		}
		const a = sizeOf(args[0]);
		const b = sizeOf(args[1]);
		if (a.length === 2 && b.length === 2) {
			return a[0] * b[1];
		}
		return Math.max(elements(a), elements(b));
	})
}, { override: true });

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
	const names = parse(expression)
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
		return parse(expression).toTex({ parenthesis: "keep", implicit: "hide" });
	},

	/**
	 * @param {string} expression
	 * @param {Object} scope variable name -> value
	 * @returns {{value: *, text: string}}
	 */
	evaluate: (expression, scope) => {
		const result = evaluate(expression, Object.assign({}, scope));
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
		const compiled = compile(expression);
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
