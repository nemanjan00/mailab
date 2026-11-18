// Vision on lab images (src/services/vision runs OpenCV in python):
//   run    one pipeline of ops on an image -> JSON results, optional annotated image
//   watch  regions of interest on an image stream (camera frames, browser
//          capture, screenshots): every time the image updates, each ROI is
//          evaluated and written to channel <watch>_<roi>; state changes
//          ("LED turned red", "display shows Err") and threshold crossings
//          raise lab notifications {type: "vision", watch, roi, ...}.
// Watches persist with the lab (snapshot / load) like udev rules.
//
// Bounded work: one evaluation per watch at a time; frames arriving while one
// runs (or faster than the watch's fps cap) are coalesced into the latest,
// and nothing is sent while the bridge already has MAX_INFLIGHT requests.

const isValidName = require("../channels").isValidName;

const DEFAULT_FPS = 2;
const MAX_FPS = 30;
const MAX_INFLIGHT = 4;
const MAX_ROIS = 64;
const KINDS = {
	led: "on/off (1/0) from the brightest pixels; params {threshold: 160, color: expected colour}; state \"on <colour>\" | \"off\"",
	seven_seg: "7-segment digits; params {count: N digits evenly across the rect, gap: 0.15} or {digits: [[x, y, w, h], ...] image px}, threshold, invert (dark segments), skew, dp; value = number, state = text",
	value_ocr: "tesseract OCR (digits by default); params {digits: false for text, whitelist, psm: 7, lang}; value = number, state = text",
	color: "mean colour; value = hue (0..179), state = colour name (red, green, ...)",
	motion: "change since the previous frame; value = changed fraction; params {threshold: 0.02, pixel_threshold: 25}; state motion | still",
	template: "find a template image in the rect; params {template: lab image, threshold: 0.8, scales}; value = score, state found | missing"
};
// op name -> params (mirrors python/vision_bridge.py OPS; checked by the tests)
const OPS = {
	crop: "{rect: [x, y, w, h]} continue on a region (overlays stay on the full frame)",
	resize: "{scale} or {width, height}",
	gray: "grayscale",
	threshold: "{value} fixed or {otsu: true} (default), invert",
	adaptive: "adaptive threshold {block: 31, c: 5, method: gaussian|mean, invert}",
	blur: "{ksize: 5, kind: gaussian|median|box}",
	morph: "{kind: open|close|dilate|erode, ksize: 3, iterations: 1}",
	canny: "edges {low: 50, high: 150}",
	warp: "perspective warp {points: 4 corners TL TR BR BL, width, height}",
	align: "register onto a reference image {reference: lab image, features: 2000} (ORB + RANSAC homography) -> matrix, inliers",
	contours: "{rect, min_area: 50, max: 50, threshold, invert} -> [{area, bbox, centroid, perimeter, mm}]",
	template: "{template: lab image, rect, scales: [0.5, 1.5, 11] (min, max, steps) or list, threshold: 0.8} -> found, score, bbox, scale",
	color: "{rect} -> mean rgb / hsv, brightness, colour name",
	led: "{rect, threshold: 160 (V of the brightest 20%), color: expected colour name} -> on, level, color",
	seven_seg: "{digits: [[x, y, w, h], ...]} or {rect, count, gap: 0.15}; threshold, invert (dark segments), skew, dp, on_fraction: 0.45 -> text, value",
	ocr: "tesseract {rect, digits: bool, whitelist, psm: 7, lang} -> text, value, confidence",
	aruco: "{dict: 4X4_50, marker_mm} -> markers (id, corners, center, side_px, pose with marker_mm), sets mm_per_px",
	scale: "set mm per px {mm_per_px} or {points: [[x, y], [x, y]], mm}",
	measure: "{points: [[x, y], ...], mm_per_px} -> px, mm (scale from aruco / scale)",
	diff: "change vs {reference: lab image} or the previous frame of this key {rect, pixel_threshold: 25} -> score, changed fraction, bbox",
	stats: "{rect} -> size, mean, std, min, max, sharpness (focus)"
};
// op / roi params naming a lab image; sent to the bridge as <param>_data (base64)
const IMAGE_PARAMS = ["template", "reference"];

// magic bytes -> mime of an uploaded image
const MAGIC = [
	["89504e47", "image/png"],
	["ffd8ff", "image/jpeg"],
	["47494638", "image/gif"],
	["424d", "image/bmp"]
];

/**
 * @param {Buffer} bytes
 * @returns {string} mime type (application/octet-stream when unknown)
 */
const sniffMime = (bytes) => {
	const hex = bytes.subarray(0, 4).toString("hex");
	const hit = MAGIC.find((m) => hex.startsWith(m[0]));
	if (hit) {
		return hit[1];
	}
	if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") {
		return "image/webp";
	}
	return "application/octet-stream";
};

const finite = (v) => typeof v === "number" && Number.isFinite(v);

const checkRect = (rect, where) => {
	if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(finite) || rect[2] <= 0 || rect[3] <= 0) {
		throw new Error(where + ": rect must be [x, y, w, h] with w, h > 0");
	}
	return rect.map(Number);
};

/**
 * Validate and normalize a watch spec.
 * @param {{name: string, image: string, rois: Object[], fps: number, annotate: boolean, enabled: boolean}} spec
 */
const normalize = (spec) => {
	const s = spec || {};
	if (!isValidName(s.name)) {
		throw new Error("watch name must be a channel-name prefix (letters, digits, _): " + s.name);
	}
	if (!s.image || typeof s.image !== "string") {
		throw new Error("watch " + s.name + ": image (lab image name) is required");
	}
	if (s.image === s.name + "_annotated") {
		throw new Error("watch " + s.name + " can't watch its own annotated output");
	}
	const rois = [].concat(s.rois || []);
	if (rois.length > MAX_ROIS) {
		throw new Error("at most " + MAX_ROIS + " rois per watch");
	}
	const seen = {};
	const outRois = rois.map((r, i) => {
		const where = "roi " + (r.name || i);
		if (!isValidName(r.name) || !isValidName(s.name + "_" + r.name)) {
			throw new Error(where + ": name must be letters, digits, _");
		}
		if (seen[r.name]) {
			throw new Error("duplicate roi name: " + r.name);
		}
		seen[r.name] = true;
		if (!KINDS[r.kind]) {
			throw new Error(where + ": kind must be one of " + Object.keys(KINDS).join(", "));
		}
		const roi = { name: r.name, kind: r.kind, rect: checkRect(r.rect, where), params: Object.assign({}, r.params || {}) };
		["above", "below", "cooldownMs", "stable"].forEach((key) => {
			if (r[key] !== undefined && r[key] !== null) {
				if (!finite(r[key])) {
					throw new Error(where + ": " + key + " must be a number");
				}
				roi[key] = r[key];
			}
		});
		if (r.notify !== undefined) {
			if (["change", "none"].indexOf(r.notify) === -1) {
				throw new Error(where + ": notify must be change or none");
			}
			roi.notify = r.notify;
		}
		return roi;
	});
	let fps = DEFAULT_FPS;
	if (s.fps !== undefined && s.fps !== null) {
		if (!finite(s.fps) || s.fps <= 0) {
			throw new Error("fps must be a positive number");
		}
		fps = Math.min(MAX_FPS, s.fps);
	}
	return { name: s.name, image: s.image, rois: outRois, fps: fps, annotate: s.annotate !== false, enabled: s.enabled !== false };
};

// the discrete state a notification is about, per kind
const stateOf = (roi, res) => {
	if (res.error) {
		return "error";
	}
	if (roi.kind === "led") {
		return res.on ? "on " + res.color : "off";
	}
	if (roi.kind === "template") {
		return res.found ? "found" : "missing";
	}
	if (roi.kind === "color") {
		return res.color;
	}
	return res.text === undefined || res.text === null ? "" : String(res.text);
};

const changeLine = (watch, roi, state, prev) => {
	const who = watch.name + "." + roi.name + ": ";
	if (state === "error") {
		return who + "evaluation failed";
	}
	if (roi.kind === "led") {
		return who + (state === "off" ? "LED turned off" : "LED turned " + state.slice(3) + (prev === "off" ? "" : " (was " + prev + ")"));
	}
	if (roi.kind === "color") {
		return who + "turned " + state + " (was " + prev + ")";
	}
	if (roi.kind === "motion") {
		return who + (state === "motion" ? "motion detected" : "motion stopped");
	}
	if (roi.kind === "template") {
		return who + "template " + state;
	}
	return who + "display shows \"" + state + "\" (was \"" + prev + "\")";
};

// big per-ROI details stay out of the published value
const brief = (res) => {
	const out = {};
	Object.keys(res).forEach((key) => {
		if (key !== "digits" && key !== "fractions") {
			out[key] = res[key];
		}
	});
	return out;
};

/**
 * @param {Object} deps
 * @param {{request: function(string, Object): Promise, inflight: function(): number}} deps.bridge
 * @param {function(string): {data: Buffer, mime: string, t: number}} deps.getImage throws when unknown
 * @param {function(string, Buffer, string)} deps.setImage
 * @param {function(string, number, Object)} deps.sample
 * @param {function(string, *)} deps.setValue
 * @param {function(Object)} deps.notify
 * @param {function(function({name: string})): function()} deps.onImage subscribe; returns unsubscribe
 * @param {function()} deps.onChange watches changed (persist)
 * @param {function(string, string)} [deps.log]
 * @param {Object[]} [saved] watches
 */
const create = (deps, saved) => {
	const log = deps.log || (() => null);
	let watches = {};
	// name -> {busy, queued, timer, lastRun, seen, frames, dropped, errors, ms, lastError, last: {roi: {state, value, text}}, pending: {roi: {state, count}}, notified: {roi: t}}
	const runtime = {};
	let unsubscribe = null;
	const anyEnabled = () => Object.keys(watches).some((name) => watches[name].enabled);

	const rt = (name) => {
		if (!runtime[name]) {
			runtime[name] = { busy: false, queued: false, timer: null, lastRun: 0, seen: 0, frames: 0, dropped: 0, errors: 0, ms: null, lastError: null, last: {}, pending: {}, notified: {}, above: {} };
		}
		return runtime[name];
	};

	const resetRuntime = (name) => {
		if (runtime[name]) {
			clearTimeout(runtime[name].timer);
		}
		delete runtime[name];
	};

	// replace lab image names in params with their data
	const resolveImages = (params) => {
		const out = Object.assign({}, params);
		IMAGE_PARAMS.forEach((key) => {
			if (typeof out[key] === "string" && out[key]) {
				out[key + "_data"] = deps.getImage(out[key]).data.toString("base64");
			}
		});
		return out;
	};

	const notifyChange = (watch, roi, r, res, value) => {
		const state = stateOf(roi, res);
		const last = r.last[roi.name];
		// stable: a state must be seen this many frames in a row before it counts
		const need = roi.stable || 1;
		const cand = r.pending[roi.name] && r.pending[roi.name].state === state ? r.pending[roi.name].count + 1 : 1;
		r.pending[roi.name] = { state: state, count: cand };
		const accepted = cand >= need;
		const prevState = last ? last.state : undefined;
		const entry = { state: accepted ? state : prevState, value: value, text: res.text === undefined ? null : res.text, t: Date.now() };
		if (res.error) {
			entry.error = res.error;
		}
		r.last[roi.name] = entry;
		if (!accepted || prevState === undefined || prevState === state || roi.notify === "none") {
			return;
		}
		const now = Date.now();
		if (roi.cooldownMs && now - (r.notified[roi.name] || 0) < roi.cooldownMs) {
			return;
		}
		r.notified[roi.name] = now;
		deps.notify({ type: "vision", watch: watch.name, roi: roi.name, kind: roi.kind, state: state, prev: prevState, value: value, text: entry.text, image: watch.image, line: changeLine(watch, roi, state, prevState) });
	};

	const notifyThreshold = (watch, roi, r, value) => {
		if (!finite(value)) {
			return;
		}
		[["above", (v, x) => v > x], ["below", (v, x) => v < x]].forEach((pair) => {
			const key = pair[0];
			if (roi[key] === undefined) {
				return;
			}
			const id = roi.name + "_" + key;
			const now = pair[1](value, roi[key]);
			const was = r.above[id];
			r.above[id] = now;
			// the first frame sets the baseline; a crossing into the condition notifies
			if (was === false && now) {
				deps.notify({ type: "vision", watch: watch.name, roi: roi.name, kind: roi.kind, threshold: key, limit: roi[key], value: value, image: watch.image,
					line: watch.name + "." + roi.name + ": " + value + " is " + key + " " + roi[key] });
			}
		});
	};

	const apply = (watch, reply) => {
		const r = rt(watch.name);
		r.frames++;
		r.ms = reply.ms;
		r.lastError = null;
		const t = Date.now();
		const rois = {};
		watch.rois.forEach((roi) => {
			const res = (reply.rois || {})[roi.name] || { error: "no result" };
			const value = finite(res.value) ? res.value : (typeof res.value === "boolean" ? Number(res.value) : null);
			if (value !== null) {
				deps.sample(watch.name + "_" + roi.name, value, { t: t });
			}
			notifyChange(watch, roi, r, res, value);
			notifyThreshold(watch, roi, r, value);
			rois[roi.name] = Object.assign(brief(res), { state: r.last[roi.name].state });
		});
		if (watch.annotate && reply.annotated) {
			deps.setImage(watch.name + "_annotated", Buffer.from(reply.annotated, "base64"), "image/png");
		}
		deps.setValue(watch.name + "_vision", { t: t, image: watch.image, size: reply.size, ms: reply.ms, rois: rois, stats: vision.stats(watch.name) });
	};

	const fail = (watch, err) => {
		const r = rt(watch.name);
		r.errors++;
		if (r.lastError !== err.message) {
			log("watch " + watch.name + ": " + err.message, "error");
		}
		r.lastError = err.message;
	};

	// evaluate the latest frame now
	const evaluate = (watch) => {
		const r = rt(watch.name);
		let img;
		try {
			img = deps.getImage(watch.image);
		} catch (_err) {
			return;
		}
		r.busy = true;
		r.queued = false;
		r.lastRun = Date.now();
		let rois;
		try {
			rois = watch.rois.map((roi) => Object.assign({}, roi, { params: resolveImages(roi.params) }));
		} catch (err) {
			r.busy = false;
			fail(watch, err);
			return;
		}
		deps.bridge.request("watch", { key: watch.name, image: img.data.toString("base64"), rois: rois, annotate: watch.annotate })
			.then((reply) => {
				// removed or replaced while the frame was out
				if (watches[watch.name] === watch) {
					apply(watch, reply);
				}
			}, (err) => {
				fail(watch, err);
			})
			.then(() => {
				r.busy = false;
				if (r.queued && watches[watch.name] === watch && watch.enabled) {
					schedule(watch);
				}
			});
	};

	// a new frame: run it now, or later within the fps cap / when the bridge frees up
	const schedule = (watch) => {
		const r = rt(watch.name);
		if (r.busy || r.timer) {
			// a frame still waiting (queued, or held by the rate timer) is superseded by this one
			if (r.queued || r.timer) {
				r.dropped++;
			}
			r.queued = true;
			return;
		}
		const minInterval = 1000 / watch.fps;
		let wait = minInterval - (Date.now() - r.lastRun);
		if (wait <= 0 && deps.bridge.inflight() >= MAX_INFLIGHT) {
			wait = minInterval;
		}
		if (wait > 0) {
			r.timer = setTimeout(() => {
				r.timer = null;
				if (watches[watch.name] === watch && watch.enabled) {
					schedule(watch);
				}
			}, wait);
			if (r.timer.unref) {
				r.timer.unref();
			}
			return;
		}
		evaluate(watch);
	};

	const onImage = (e) => {
		Object.keys(watches).forEach((name) => {
			const watch = watches[name];
			if (watch.enabled && watch.image === e.name) {
				rt(name).seen++;
				schedule(watch);
			}
		});
	};

	const vision = {
		KINDS: KINDS,
		OPS: OPS,

		/**
		 * One pipeline on a lab image.
		 * @param {{image: string, ops: Object[], annotate: boolean, output: string, key: string}} spec
		 *   annotate: store overlays as <image>_annotated; output: store the final pipeline image under this name
		 * @returns {Promise<{results: Object[], ms: number, annotated: string, output: string, png: string}>}
		 */
		run: (spec) => {
			const img = deps.getImage(spec.image);
			const ops = [].concat(spec.ops || []).map((op, i) => {
				if (!op || !OPS[op.op]) {
					throw new Error("op " + i + ": unknown op " + (op && op.op) + " (see vision_ops)");
				}
				return resolveImages(op);
			});
			return deps.bridge.request("run", { image: img.data.toString("base64"), ops: ops, annotate: spec.annotate !== false, output: Boolean(spec.output), key: spec.key || spec.image })
				.then((reply) => {
					const out = { image: spec.image, size: reply.size, ms: reply.ms, results: reply.results };
					if (reply.annotated) {
						out.annotated = spec.image + "_annotated";
						out.png = reply.annotated;
						deps.setImage(out.annotated, Buffer.from(reply.annotated, "base64"), "image/png");
					}
					if (spec.output && reply.output) {
						out.output = spec.output;
						deps.setImage(spec.output, Buffer.from(reply.output, "base64"), "image/png");
					}
					return out;
				});
		},

		list: () => Object.keys(watches).sort().map((name) => vision.describe(name)),

		describe: (name) => {
			const watch = watches[name];
			if (!watch) {
				throw new Error("no vision watch " + name);
			}
			const r = rt(name);
			return Object.assign({}, watch, { stats: vision.stats(name), last: Object.assign({}, r.last) });
		},

		stats: (name) => {
			const r = rt(name);
			return { seen: r.seen, frames: r.frames, dropped: r.dropped, errors: r.errors, ms: r.ms, lastError: r.lastError };
		},

		/**
		 * Create or replace a watch; it evaluates the image's current frame right away.
		 */
		add: (spec) => {
			const watch = normalize(spec);
			resetRuntime(watch.name);
			watches = Object.assign({}, watches, { [watch.name]: watch });
			deps.onChange();
			if (watch.enabled) {
				// lazily arm the image subscription: watches only evaluate while
				// at least one is enabled (start is idempotent)
				vision.start();
				let exists = true;
				try {
					deps.getImage(watch.image);
				} catch (_err) {
					exists = false;
				}
				if (exists) {
					schedule(watch);
				}
			} else if (!anyEnabled()) {
				vision.stop();
			}
			return vision.describe(watch.name);
		},

		remove: (name) => {
			if (!watches[name]) {
				throw new Error("no vision watch " + name);
			}
			const next = Object.assign({}, watches);
			delete next[name];
			watches = next;
			resetRuntime(name);
			// motion baselines live in the bridge; don't start one just to clear them
			if (!deps.bridge.running || deps.bridge.running()) {
				deps.bridge.request("forget", { key: name }).catch(() => null);
			}
			deps.onChange();
			if (!anyEnabled()) {
				vision.stop();
			}
			return vision.list();
		},

		/**
		 * Replace all watches (lab import); invalid ones are logged and skipped.
		 */
		load: (list) => {
			Object.keys(runtime).forEach(resetRuntime);
			watches = {};
			(list || []).forEach((spec) => {
				try {
					const watch = normalize(spec);
					watches[watch.name] = watch;
				} catch (err) {
					log("vision watch skipped: " + err.message, "error");
				}
			});
			// restored watches only evaluate once the image subscription is armed
			if (anyEnabled()) {
				vision.start();
				Object.keys(watches).forEach((name) => {
					if (watches[name].enabled) {
						schedule(watches[name]);
					}
				});
			}
		},

		snapshot: () => Object.keys(watches).sort().map((name) => watches[name]),

		start: () => {
			if (!unsubscribe) {
				unsubscribe = deps.onImage(onImage);
			}
			return vision.stop;
		},

		stop: () => {
			if (unsubscribe) {
				unsubscribe();
				unsubscribe = null;
			}
			Object.keys(runtime).forEach((name) => {
				clearTimeout(runtime[name].timer);
				runtime[name].timer = null;
			});
		}
	};

	vision.load(saved);
	return vision;
};

module.exports = {
	create: create,
	normalize: normalize,
	sniffMime: sniffMime,
	KINDS: KINDS,
	OPS: OPS,
	MAX_INFLIGHT: MAX_INFLIGHT
};
