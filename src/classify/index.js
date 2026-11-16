// Log classification in the spirit of diversity-classifier: device lines are
// normalized (numbers, hex, IPs, UUIDs -> placeholders); templates count
// matches and record their numeric fields as channels; everything unmatched
// collapses into clusters, which are the AI's to-do list.
//
// template: {name, pattern} where pattern uses <num> <hex> <ip> <uuid> <word> <*>
//   "temp=<num>C"  -> counts into channel cls_<name>, value into cls_<name>_1

const LINE_LEVELS = ["rx", "uart", "stdout", "stderr", "warn", "error", "info", "decode"];
const MAX_CLUSTERS = 500;
const DIGEST_MS = 5000;

const PLACEHOLDERS = {
	"<num>": "(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)",
	"<hex>": "((?:0x)?[0-9a-fA-F]{4,})",
	"<ip>": "(\\d{1,3}(?:\\.\\d{1,3}){3})",
	"<uuid>": "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})",
	"<word>": "(\\S+)",
	"<*>": "(.*)"
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Line -> signature with variable parts replaced, so similar lines cluster.
 */
const normalize = (line) => {
	return String(line)
		.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<uuid>")
		.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
		.replace(/\b0x[0-9a-fA-F]+\b/g, "<hex>")
		.replace(/\b[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]*\d[0-9a-fA-F]*\b|\b\d+[a-fA-F][0-9a-fA-F]*\b/g, (m) => (m.length >= 6 ? "<hex>" : m))
		.replace(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g, "<num>")
		.replace(/\s+/g, " ")
		.trim();
};

/**
 * Template pattern -> anchored regex (placeholders capture).
 */
const compileTemplate = (pattern) => {
	const parts = String(pattern).split(/(<num>|<hex>|<ip>|<uuid>|<word>|<\*>)/);
	const source = parts.map((part) => PLACEHOLDERS[part] || escapeRegex(part)).join("");
	return new RegExp("^" + source + "$");
};

const safeName = (name) => String(name).replace(/[^A-Za-z0-9_]/g, "_");

/**
 * @param {Object} lab
 * @param {{templates: Object[]}} [saved]
 */
const create = (lab, saved) => {
	let templates = [];
	let clusters = {};
	let pendingDigest = [];
	let digestTimer = null;

	const compile = (t) => Object.assign({ count: 0, last: null, example: null }, t, {
		name: safeName(t.name),
		regex: compileTemplate(t.pattern)
	});

	const describe = (t) => ({ name: t.name, pattern: t.pattern, count: t.count, last: t.last, example: t.example, record: t.record !== false });

	const flushDigest = () => {
		digestTimer = null;
		if (!pendingDigest.length) {
			return;
		}
		const fresh = pendingDigest;
		pendingDigest = [];
		lab.notify({ type: "cluster", clusters: fresh.map((sig) => clusters[sig]).filter(Boolean) });
	};

	const classifier = {
		normalize: normalize,

		/**
		 * Feed one device line.
		 */
		line: (device, text) => {
			const line = String(text).trim();
			if (!line) {
				return null;
			}
			// raw lines go to `line` subscribers only (not kept in the event history)
			lab.events.emit("notify", { type: "line", device: device, line: line, t: Date.now() });
			const t = templates.find((tpl) => tpl.regex.test(line));
			if (t) {
				const match = t.regex.exec(line);
				t.count++;
				t.last = Date.now();
				t.example = line;
				lab.pushSample("cls_" + t.name, t.count, { source: "classifier" });
				if (t.record !== false) {
					match.slice(1).forEach((value, i) => {
						const n = Number(value);
						if (value !== undefined && value.trim() !== "" && Number.isFinite(n)) {
							lab.pushSample("cls_" + t.name + "_" + (i + 1), n, { source: "classifier" });
						}
					});
				}
				lab.notify({ type: "match", template: t.name, device: device, line: line, values: match.slice(1) });
				return { template: t.name };
			}
			const sig = normalize(line);
			let cluster = clusters[sig];
			if (!cluster) {
				if (Object.keys(clusters).length >= MAX_CLUSTERS) {
					return null;
				}
				cluster = clusters[sig] = { signature: sig, count: 0, example: line, device: device, first: Date.now(), last: null };
				pendingDigest.push(sig);
				if (!digestTimer) {
					digestTimer = setTimeout(flushDigest, DIGEST_MS);
					digestTimer.unref();
				}
			}
			cluster.count++;
			cluster.last = Date.now();
			return { cluster: sig };
		},

		addTemplate: (spec) => {
			if (!spec.name || !spec.pattern) {
				throw new Error("template needs name and pattern (placeholders: <num> <hex> <ip> <uuid> <word> <*>)");
			}
			const t = compile(spec);
			templates = templates.filter((x) => x.name !== t.name).concat([t]);
			// the backlog: clusters the template now explains are absorbed
			Object.keys(clusters).forEach((sig) => {
				if (t.regex.test(clusters[sig].example)) {
					t.count += clusters[sig].count;
					t.example = clusters[sig].example;
					delete clusters[sig];
				}
			});
			classifier.changed();
			return describe(t);
		},

		removeTemplate: (name) => {
			templates = templates.filter((t) => t.name !== safeName(name));
			classifier.changed();
		},

		status: (options) => {
			const opts = options || {};
			const list = Object.keys(clusters).map((sig) => clusters[sig]).sort((a, b) => b.count - a.count);
			return {
				templates: templates.map(describe),
				unclassified: list.slice(0, opts.limit || 50),
				unclassifiedTotal: list.reduce((n, c) => n + c.count, 0),
				clusterCount: list.length
			};
		},

		reset: () => {
			clusters = {};
			templates.forEach((t) => {
				t.count = 0;
			});
		},

		changed: () => {},

		snapshot: () => templates.map((t) => ({ name: t.name, pattern: t.pattern, record: t.record })),

		restore: () => {
			((saved && saved.templates) || []).forEach((spec) => {
				try {
					templates.push(compile(spec));
				} catch (err) {
					lab.log("classifier", "template " + spec.name + ": " + err.message, "error");
				}
			});
		}
	};

	// classify device lines as they are logged
	lab.events.on("log", (entry) => {
		if (entry.device && entry.device !== "lab" && entry.device !== "safety" && LINE_LEVELS.indexOf(entry.level) !== -1) {
			classifier.line(entry.device, entry.text);
		}
	});

	return classifier;
};

module.exports = {
	create: create,
	normalize: normalize,
	compileTemplate: compileTemplate
};
