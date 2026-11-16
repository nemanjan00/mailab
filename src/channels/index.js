// Channel store: named time series kept in fixed-size ring buffers.
// A channel is { name, unit, source } plus (t, v) samples, t in ms since epoch.

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isValidName = (name) => {
	return typeof name === "string" && NAME_RE.test(name);
};

/**
 * Turn any label into a valid channel name ("A0 V" -> "A0_V").
 */
const sanitizeName = (label) => {
	const cleaned = String(label).replace(/[^A-Za-z0-9_]/g, "_");
	if (/^[0-9]/.test(cleaned)) {
		return "_" + cleaned;
	}
	return cleaned;
};

const createBuffer = (capacity) => {
	return {
		t: new Float64Array(capacity),
		v: new Float64Array(capacity),
		head: 0,
		size: 0
	};
};

/**
 * @param {number} capacity samples per channel
 */
const create = (capacity) => {
	const channels = {};

	// chronological index i (0 = oldest) -> physical ring index
	const at = (channel, i) => {
		const buf = channel.buffer;
		return (buf.head - buf.size + i + capacity) % capacity;
	};

	const store = {
		has: (name) => {
			return Boolean(channels[name]);
		},

		/**
		 * Create a channel if missing, update its metadata otherwise.
		 * @param {string} name
		 * @param {{unit: string, source: string, description: string}} [meta]
		 */
		ensure: (name, meta) => {
			if (!isValidName(name)) {
				throw new Error("invalid channel name: " + name + " (use letters, digits, _)");
			}
			if (!channels[name]) {
				channels[name] = {
					name: name,
					unit: "",
					source: "",
					description: "",
					buffer: createBuffer(capacity)
				};
			}
			const channel = channels[name];
			Object.keys(meta || {}).forEach((key) => {
				if (meta[key] !== undefined && meta[key] !== null && key !== "buffer") {
					channel[key] = meta[key];
				}
			});
			return channel;
		},

		push: (name, t, v) => {
			const buf = channels[name].buffer;
			buf.t[buf.head] = t;
			buf.v[buf.head] = v;
			buf.head = (buf.head + 1) % capacity;
			buf.size = Math.min(buf.size + 1, capacity);
		},

		latest: (name) => {
			const channel = channels[name];
			if (!channel || channel.buffer.size === 0) {
				return null;
			}
			const i = at(channel, channel.buffer.size - 1);
			return { t: channel.buffer.t[i], v: channel.buffer.v[i] };
		},

		/**
		 * Read samples, oldest first.
		 * @param {string} name
		 * @param {{since: number, seconds: number, last: number}} [options]
		 *   since: only samples with t > since; seconds: only the last N seconds;
		 *   last: at most the last N samples
		 * @returns {{t: number[], v: number[]}}
		 */
		read: (name, options) => {
			const channel = channels[name];
			if (!channel) {
				throw new Error("unknown channel: " + name);
			}
			const opts = options || {};
			const buf = channel.buffer;
			let from = 0;
			if (opts.last !== undefined) {
				from = Math.max(0, buf.size - opts.last);
			}
			let since = -Infinity;
			if (opts.since !== undefined) {
				since = opts.since;
			}
			if (opts.seconds !== undefined) {
				since = Math.max(since, Date.now() - opts.seconds * 1000);
			}
			// samples are time-ordered, so binary search the first one after `since`
			let lo = from;
			let hi = buf.size;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (buf.t[at(channel, mid)] > since) {
					hi = mid;
				} else {
					lo = mid + 1;
				}
			}
			const count = buf.size - lo;
			const t = Array.from({ length: count }, (_, i) => {
				return buf.t[at(channel, lo + i)];
			});
			const v = Array.from({ length: count }, (_, i) => {
				return buf.v[at(channel, lo + i)];
			});
			return { t: t, v: v };
		},

		clear: (name) => {
			channels[name].buffer = createBuffer(capacity);
		},

		remove: (name) => {
			delete channels[name];
		},

		describe: (name) => {
			const channel = channels[name];
			return {
				name: channel.name,
				unit: channel.unit,
				source: channel.source,
				description: channel.description,
				count: channel.buffer.size,
				latest: store.latest(name)
			};
		},

		list: () => {
			return Object.keys(channels).sort().map(store.describe);
		},

		listMap: () => {
			const map = {};
			store.list().forEach((channel) => {
				map[channel.name] = channel;
			});
			return map;
		}
	};

	return store;
};

module.exports = {
	create: create,
	isValidName: isValidName,
	sanitizeName: sanitizeName
};
