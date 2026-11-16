// Long-term trends (Grafana-like): recorded channels are aggregated into
// min/max/mean buckets at several resolutions, kept on disk, and queried at
// the finest resolution that fits the requested timeframe.

const fs = require("fs");
const path = require("path");
const globToRegex = require("../utils/glob").toRegex;

const TIERS = [
	{ name: "1s", ms: 1000, keep: 6 * 3600 },
	{ name: "10s", ms: 10000, keep: 3 * 8640 },
	{ name: "1m", ms: 60000, keep: 30 * 1440 },
	{ name: "1h", ms: 3600000, keep: 2 * 365 * 24 }
];
const DEFAULT_PATTERNS = ["*_v", "*_i", "*_p", "*_temp", "*_vin", "cls_*"];
const FLUSH_MS = 5000;
const DEFAULT_POINTS = 1000;

/**
 * @param {string} dir DATA_DIR/trends
 * @param {{patterns: string[]}} [saved]
 */
const create = (dir, saved) => {
	let patterns = (saved && saved.patterns) || DEFAULT_PATTERNS.slice();
	let matchers = patterns.map(globToRegex);
	// channel -> tier name -> {current, buckets: [{t, min, max, mean, n}]}
	const series = {};
	// pending file appends: file -> [lines]
	let pending = {};

	const fileFor = (tier, channel) => path.join(dir, tier.name, channel + ".ndjson");

	const load = (channel) => {
		const tiers = {};
		TIERS.forEach((tier) => {
			const file = fileFor(tier, channel);
			let buckets = [];
			if (fs.existsSync(file)) {
				buckets = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-tier.keep).map((line) => {
					const b = JSON.parse(line);
					return { t: b[0], min: b[1], max: b[2], mean: b[3], n: b[4] };
				});
			}
			tiers[tier.name] = { current: null, buckets: buckets };
		});
		return tiers;
	};

	const seriesFor = (channel) => series[channel] || (series[channel] = load(channel));

	const append = (tier, channel, b) => {
		const file = fileFor(tier, channel);
		(pending[file] || (pending[file] = [])).push(JSON.stringify([b.t, b.min, b.max, b.mean, b.n]));
	};

	const close = (tier, channel, state) => {
		const c = state.current;
		const b = { t: c.t, min: c.min, max: c.max, mean: c.sum / c.n, n: c.n };
		state.buckets.push(b);
		if (state.buckets.length > tier.keep) {
			state.buckets.splice(0, state.buckets.length - tier.keep);
		}
		append(tier, channel, b);
		state.current = null;
	};

	const trends = {
		TIERS: TIERS,

		recorded: (channel) => matchers.some((re) => re.test(channel)),

		setPatterns: (list) => {
			patterns = list.slice();
			matchers = patterns.map(globToRegex);
		},

		getPatterns: () => patterns.slice(),

		channels: () => Object.keys(series).sort(),

		sample: (channel, t, v) => {
			if (!Number.isFinite(v) || !trends.recorded(channel)) {
				return;
			}
			const s = seriesFor(channel);
			TIERS.forEach((tier) => {
				const state = s[tier.name];
				const start = Math.floor(t / tier.ms) * tier.ms;
				if (state.current && state.current.t !== start) {
					if (start < state.current.t) {
						// late sample for an already closed bucket: merge it in place
						const old = state.buckets.find((b) => b.t === start);
						if (old) {
							old.mean = (old.mean * old.n + v) / (old.n + 1);
							old.n++;
							old.min = Math.min(old.min, v);
							old.max = Math.max(old.max, v);
						}
						return;
					}
					close(tier, channel, state);
				}
				if (!state.current) {
					state.current = { t: start, min: v, max: v, sum: 0, n: 0 };
				}
				const c = state.current;
				c.min = Math.min(c.min, v);
				c.max = Math.max(c.max, v);
				c.sum += v;
				c.n++;
			});
		},

		/**
		 * @param {string} channel
		 * @param {{from: number, to: number, points: number, tier: string}} options ms since epoch; tier forces a resolution
		 * @returns {{tier: string, t: number[], min: number[], max: number[], mean: number[]}}
		 */
		read: (channel, options) => {
			const o = options || {};
			const to = o.to || Date.now();
			const from = o.from || to - 3600000;
			const points = o.points || DEFAULT_POINTS;
			const s = seriesFor(channel);
			// finest tier that still keeps the whole range...
			const tier = TIERS.find((tr) => tr.name === o.tier) || TIERS.find((tr) => Date.now() - from <= tr.keep * tr.ms) || TIERS[TIERS.length - 1];
			const state = s[tier.name];
			let buckets = state.buckets.concat(state.current ? [{
				t: state.current.t, min: state.current.min, max: state.current.max, mean: state.current.sum / state.current.n, n: state.current.n
			}] : []).filter((b) => b.t >= from - tier.ms && b.t <= to);
			// ...merged down to the point budget (min of mins, max of maxes, weighted mean)
			const group = Math.ceil(buckets.length / points);
			if (group > 1) {
				const merged = [];
				for (let i = 0; i < buckets.length; i += group) {
					const part = buckets.slice(i, i + group);
					const n = part.reduce((acc, b) => acc + (b.n || 1), 0);
					merged.push({
						t: part[0].t,
						min: Math.min.apply(null, part.map((b) => b.min)),
						max: Math.max.apply(null, part.map((b) => b.max)),
						mean: part.reduce((acc, b) => acc + b.mean * (b.n || 1), 0) / n,
						n: n
					});
				}
				buckets = merged;
			}
			return {
				tier: group > 1 ? tier.name + " ×" + group : tier.name,
				t: buckets.map((b) => b.t),
				min: buckets.map((b) => b.min),
				max: buckets.map((b) => b.max),
				mean: buckets.map((b) => b.mean)
			};
		},

		/**
		 * Close stale buckets (quiet channels) and write pending lines to disk.
		 */
		flush: () => {
			const now = Date.now();
			Object.keys(series).forEach((channel) => {
				TIERS.forEach((tier) => {
					const state = series[channel][tier.name];
					if (state.current && now - state.current.t >= tier.ms * 2) {
						close(tier, channel, state);
					}
				});
			});
			const writes = pending;
			pending = {};
			Object.keys(writes).forEach((file) => {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.appendFileSync(file, writes[file].join("\n") + "\n");
				// compact files that grew far past retention
				const tierName = path.basename(path.dirname(file));
				const tier = TIERS.find((tr) => tr.name === tierName);
				const size = fs.statSync(file).size;
				if (tier && size > tier.keep * 80 * 2) {
					const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-tier.keep);
					fs.writeFileSync(file, lines.join("\n") + "\n");
				}
			});
		},

		start: () => {
			const timer = setInterval(trends.flush, FLUSH_MS);
			timer.unref();
			return () => {
				clearInterval(timer);
				trends.flush();
			};
		},

		snapshot: () => ({ patterns: patterns })
	};

	return trends;
};

module.exports = {
	create: create,
	TIERS: TIERS,
	DEFAULT_PATTERNS: DEFAULT_PATTERNS
};
