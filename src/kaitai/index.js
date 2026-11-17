// Kaitai Struct parsing on the server: compile a .ksy (YAML) with the JS build
// of the compiler in debug mode, run it on a blob and return a plain tree
// plus byte ranges per field (for the hex view).
//
// The spec is either a single .ksy YAML string, or a multi-file bundle from
// protokai: { main: "<id>.ksy" text (or just its YAML text), files: { "<id>.ksy":
// text } } — generated specs import each other (meta.imports) and the compiler
// resolves them through an import loader.

const createHash = require("crypto").createHash;
const vm = require("vm");
const yaml = require("js-yaml");
const compiler = require("kaitai-struct-compiler");
const KaitaiStream = require("kaitai-struct/KaitaiStream");
const protokai = require("./protokai");

const MAX_ARRAY_ITEMS = 2000;
const MAX_DEPTH = 32;
const CACHE_SIZE = 32;

// spec key -> Promise<{name, classes}>
const cache = new Map();

const specKey = (spec) => {
	if (typeof spec === "string") {
		return createHash("sha256").update(spec).digest("hex");
	}
	const hash = createHash("sha256");
	Object.keys(spec.files || {}).sort().forEach((name) => {
		hash.update(name);
		hash.update("\0");
		hash.update(spec.files[name]);
		hash.update("\0");
	});
	hash.update(spec.main || "");
	return hash.digest("hex");
};

const load = (spec) => {
	const key = specKey(spec);
	if (cache.has(key)) {
		return cache.get(key);
	}
	const files = typeof spec === "string" ? {} : (spec.files || {});
	const ksyText = typeof spec === "string" ? spec : (spec.main || "");
	const ksy = yaml.load(ksyText);
	if (!ksy || !ksy.meta || !ksy.meta.id) {
		return Promise.reject(new Error("ksy needs meta.id"));
	}
	// multi-file bundle: resolve meta.imports against the sibling specs
	const importer = Object.keys(files).length ? {
		importYaml: (name) => {
			const text = files[name + ".ksy"] || files[name];
			if (text === undefined) {
				return Promise.reject(new Error("import " + name + " not in bundle"));
			}
			return Promise.resolve(yaml.load(text));
		}
	} : null;
	const compiled = compiler.compile("javascript", ksy, importer, true).then((out) => {
		const classes = {};
		const sandbox = {
			exports: classes,
			require: (name) => {
				if (name === "kaitai-struct/KaitaiStream") {
					return KaitaiStream;
				}
				// imports between generated files
				const base = name.replace(/^\.\//, "").replace(/\.js$/, "");
				const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
				const hit = Object.keys(classes).filter((k) => norm(k) === norm(base))[0];
				return hit ? { [hit]: classes[hit] } : {};
			}
		};
		// generated files reference each other at load time, so run them in
		// dependency order (from the specs' meta.imports), deps first. The
		// compiler names files after the CLASS (capitalized), not meta.id.
		const names = Object.keys(out);
		// meta.ids are snake_case ("protobuf_varint"), generated file/class
		// names are CamelCase ("ProtobufVarint") - compare loosely
		const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
		const findFile = (id) => {
			const want = norm(id);
			return names.filter((n) => norm(n.replace(/\.js$/, "")) === want)[0] || null;
		};
		const findSpecText = (base) => {
			const want = norm(base);
			const key = Object.keys(files).filter((k) => {
				return norm(k.replace(/\.ksy$/, "")) === want;
			})[0];
			return key ? files[key] : undefined;
		};
		const sorted = [];
		const seen = {};
		const visit = (name) => {
			if (seen[name]) {
				return;
			}
			seen[name] = true;
			const base = name.replace(/\.js$/, "");
			const specText = findSpecText(base);
			const spec = specText ? yaml.load(specText) : null;
			const imports = spec && spec.meta && spec.meta.imports
				? [].concat(spec.meta.imports) : [];
			imports.forEach((imp) => {
				const dep = findFile(imp);
				if (dep && dep !== name) {
					visit(dep);
				}
			});
			sorted.push(name);
		};
		names.forEach(visit);
		sorted.forEach((file) => {
			vm.runInNewContext(out[file], sandbox, { filename: file });
		});
		// main class: the file matching the main spec's meta.id (class names
		// are capitalized), last generated file as fallback
		const mainFile = findFile(ksy.meta.id) || names[names.length - 1];
		const main = mainFile.replace(/\.js$/, "");
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
 * Resolve caller args ({ksy} or {proto, protoFiles?, protoType?}) into a spec
 * for parse(): .ksy YAML text, or a protokai bundle for .proto sources.
 * protoFiles maps "name.proto" -> schema text (imports).
 */
const resolve = (a) => {
	if (a.proto) {
		const files = Object.assign({ "main.proto": a.proto }, a.protoFiles || {});
		return protokai.convert({ files: files, type: a.protoType }).then((bundle) => {
			return { main: bundle.files[bundle.entry + ".ksy"], files: bundle.files };
		});
	}
	if (!a.ksy) {
		return Promise.reject(new Error("need a .ksy (ksy) or .proto (proto) source"));
	}
	return Promise.resolve(a.ksy);
};

/**
 * @param {string|{main: string, files: Object}} spec .ksy YAML or a bundle
 * @param {Buffer} data
 * @returns {Promise<{type: string, tree: Object, ranges: Object, error: string}>}
 */
const parse = (spec, data) => {
	return load(spec).then((compiled) => {
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
	parse: parse,
	resolve: resolve
};
