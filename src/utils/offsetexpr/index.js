// Tiny integer expression evaluator for "jump to": "0x1000+4*3",
// "end-0x100", "cur+0x20", "(sel_end - sel) / 2". BigInt throughout, so
// 64-bit addresses and bit operations are exact. No names besides the
// variables handed in, no calls: safe on user input. Shared by the server
// and the browser.
//
// Grammar (C precedence): | ^ & << >> + - * / % unary - ~ ( )
// Numbers: 0x1f, 0b101, 0o17, 1f h (hex suffix "1fh"), 123 (decimal)

const MAX_LENGTH = 256;
const MAX_DEPTH = 32;

const TOKEN = /\s*(0x[0-9a-f_]+|0b[01_]+|0o[0-7_]+|[0-9][0-9a-f_]*h\b|\d[\d_]*|[A-Za-z_][A-Za-z0-9_]*|<<|>>|[-+*/%&|^~()])/iy;

const tokenize = (text) => {
	const tokens = [];
	TOKEN.lastIndex = 0;
	while (TOKEN.lastIndex < text.length) {
		if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) {
			break;
		}
		const at = TOKEN.lastIndex;
		const m = TOKEN.exec(text);
		if (!m) {
			throw new Error("unexpected \"" + text.slice(at).trim().slice(0, 10) + "\"");
		}
		tokens.push(m[1]);
	}
	return tokens;
};

const literal = (tok) => {
	const t = tok.replace(/_/g, "");
	if (/^[0-9][0-9a-f]*h$/i.test(t)) {
		return BigInt("0x" + t.slice(0, -1));
	}
	return BigInt(t.toLowerCase());
};

const BINARY = [
	["|"], ["^"], ["&"], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]
];

const apply = (op, a, b) => {
	if ((op === "/" || op === "%") && b === 0n) {
		throw new Error("division by zero");
	}
	if ((op === "<<" || op === ">>") && (b < 0n || b > 64n)) {
		throw new Error("shift out of range: " + b);
	}
	const fns = {
		"|": () => a | b, "^": () => a ^ b, "&": () => a & b, "<<": () => a << b, ">>": () => a >> b,
		"+": () => a + b, "-": () => a - b, "*": () => a * b, "/": () => a / b, "%": () => a % b
	};
	return fns[op]();
};

/**
 * Evaluate an expression to a BigInt.
 * @param {string} text
 * @param {Object<string, number|bigint>} [vars] e.g. {end, cur, sel, base}
 * @returns {bigint}
 */
const evaluateBig = (text, vars) => {
	const src = String(text || "");
	if (!src.trim()) {
		throw new Error("empty expression");
	}
	if (src.length > MAX_LENGTH) {
		throw new Error("expression longer than " + MAX_LENGTH + " characters");
	}
	const scope = vars || {};
	const tokens = tokenize(src);
	let pos = 0;

	const unary = (depth) => {
		if (depth > MAX_DEPTH) {
			throw new Error("expression nested too deeply");
		}
		const tok = tokens[pos];
		if (tok === undefined) {
			throw new Error("unexpected end of expression");
		}
		pos++;
		if (tok === "-") {
			return -unary(depth + 1);
		}
		if (tok === "+") {
			return unary(depth + 1);
		}
		if (tok === "~") {
			return ~unary(depth + 1);
		}
		if (tok === "(") {
			const value = binary(0, depth + 1);
			if (tokens[pos] !== ")") {
				throw new Error("missing )");
			}
			pos++;
			return value;
		}
		if (/^\d/.test(tok)) {
			return literal(tok);
		}
		if (/^[A-Za-z_]/.test(tok)) {
			if (!Object.prototype.hasOwnProperty.call(scope, tok)) {
				throw new Error("unknown name: " + tok + (Object.keys(scope).length ? " (known: " + Object.keys(scope).join(", ") + ")" : ""));
			}
			return BigInt(scope[tok]);
		}
		throw new Error("unexpected \"" + tok + "\"");
	};

	const binary = (level, depth) => {
		if (level >= BINARY.length) {
			return unary(depth);
		}
		let left = binary(level + 1, depth);
		while (BINARY[level].indexOf(tokens[pos]) !== -1) {
			const op = tokens[pos];
			pos++;
			left = apply(op, left, binary(level + 1, depth));
		}
		return left;
	};

	const value = binary(0, 0);
	if (pos < tokens.length) {
		throw new Error("unexpected \"" + tokens[pos] + "\"");
	}
	return value;
};

/**
 * Evaluate to a Number (throws beyond 2^53).
 */
const evaluate = (text, vars) => {
	const big = evaluateBig(text, vars);
	if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < -BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("result too large: " + big);
	}
	return Number(big);
};

module.exports = {
	evaluate: evaluate,
	evaluateBig: evaluateBig
};
