// Kaitai Struct parsing on the server: compile a .ksy (YAML) with the JS build
// of the compiler in debug mode, run it on a blob and return a plain tree
// plus byte ranges per field (for the hex view).

const createHash = require("crypto").createHash;
const vm = require("vm");
const yaml = require("js-yaml");
const compiler = require("kaitai-struct-compiler");
const KaitaiStream = require("kaitai-struct/KaitaiStream");

const MAX_ARRAY_ITEMS = 2000;
const MAX_DEPTH = 32;
const CACHE_SIZE = 32;

// ksy hash -> Promise<{name, classes}>
const cache = new Map();

const load = (ksyText) => {
	const key = createHash("sha256").update(ksyText).digest("hex");
	if (cache.has(key)) {
		return cache.get(key);
	}
	const ksy = yaml.load(ksyText);
	if (!ksy || !ksy.meta || !ksy.meta.id) {
		return Promise.reject(new Error("ksy needs meta.id"));
	}
	const compiled = compiler.compile("javascript", ksy, null, true).then((files) => {
		const classes = {};
		const sandbox = {
			exports: classes,
			require: (name) => {
				if (name === "kaitai-struct/KaitaiStream") {
					return KaitaiStream;
				}
				// imports between generated files
				const base = name.replace(/^\.\//, "").replace(/\.js$/, "");
				return classes[base] ? { [base]: classes[base] } : {};
			}
		};
		Object.keys(files).forEach((file) => {
			vm.runInNewContext(files[file], sandbox, { filename: file });
		});
		const main = Object.keys(files)[0].replace(/\.js$/, "");
		return { name: main, classes: classes };
	});
	cache.set(key, compiled);
	if (cache.size > CACHE_SIZE) {
		cache.delete(cache.keys().next().value);
	}
	compiled.catch(() => {
		cache.delete(key);
	});
	return compiled;
};

const isStruct = (value) => {
	return value && typeof value === "object" && value._io !== undefined;
};

// field names: own data fields plus instance getters on the prototype
const fieldNames = (obj) => {
	const own = Object.keys(obj).filter((k) => !k.startsWith("_"));
	const proto = Object.getPrototypeOf(obj);
	const instances = Object.getOwnPropertyNames(proto).filter((k) => {
		const d = Object.getOwnPropertyDescriptor(proto, k);
		return d && typeof d.get === "function" && !k.startsWith("_");
	});
	return own.concat(instances.filter((k) => own.indexOf(k) === -1));
};

/**
 * Walk a parsed object into plain JSON; ranges[path] = [start, end] (absolute offsets).
 */
const toPlain = (obj, path, ranges, depth) => {
	if (depth > MAX_DEPTH) {
		return "[max depth]";
	}
	if (obj instanceof Uint8Array) {
		return { bytes: obj.length, hex: Buffer.from(obj.slice(0, 64)).toString("hex") + (obj.length > 64 ? "…" : "") };
	}
	if (Array.isArray(obj)) {
		return obj.slice(0, MAX_ARRAY_ITEMS).map((item, i) => {
			return toPlain(item, path + "[" + i + "]", ranges, depth + 1);
		});
	}
	if (!isStruct(obj)) {
		if (typeof obj === "bigint") {
			return obj.toString();
		}
		return obj;
	}
	const debug = obj._debug || {};
	const out = {};
	fieldNames(obj).forEach((name) => {
		const childPath = path + "." + name;
		const info = debug[name];
		if (info && info.start !== undefined) {
			ranges[childPath] = [info.start, info.end];
			// per-element ranges of repeated fields
			(info.arr || []).forEach((el, i) => {
				ranges[childPath + "[" + i + "]"] = [el.start, el.end];
			});
		}
		try {
			out[name] = toPlain(obj[name], childPath, ranges, depth + 1);
		} catch (err) {
			out[name] = "[error: " + err.message + "]";
		}
	});
	return out;
};

/**
 * @param {string} ksyText .ksy YAML
 * @param {Buffer} data
 * @returns {Promise<{type: string, tree: Object, ranges: Object, error: string}>}
 */
const parse = (ksyText, data) => {
	return load(ksyText).then((compiled) => {
		const Cls = compiled.classes[compiled.name];
		const bytes = new Uint8Array(data.buffer, data.byteOffset, data.length);
		const obj = new Cls(new KaitaiStream(bytes));
		let error = null;
		try {
			obj._read();
		} catch (err) {
			// keep what parsed before the failure
			error = err.message;
		}
		const ranges = {};
		return { type: compiled.name, tree: toPlain(obj, "", ranges, 0), ranges: ranges, error: error };
	});
};

module.exports = {
	parse: parse
};
