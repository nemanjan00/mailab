// One timebase across instruments.
//
// A sync pulse every instrument sees (injected into a scope channel, a
// flowgraph signal block, a logic analyzer...) is stamped by the sync_mark
// flowgraph block as a mark: { index, t, rate } — the global sample index of
// the edge, the estimated host time of that edge, and the sample rate.
//
// Assuming an instrument's sample clock is constant, its samples map to host
// time as  t_host(i) = origin + i / rate  with  origin = t - index / rate.
// Two marks of the same physical pulse therefore relate the two instruments'
// sample grids: sample i of instrument a and sample j of instrument b are the
// same physical instant when
//
//     origin(a) + i / rate_a = origin(b) + j / rate_b
//
// The unknown intra-tick position of each stamp is common-mode when both
// edges are processed in the same flowgraph tick (TICK below), so the
// sample-grid alignment is typically far more accurate than the absolute
// stamp time.

const TICK_TOLERANCE_S = 0.02; // flowgraph tick; worst-case stamp error

const assertMark = (mark, name) => {
	if (!mark || typeof mark !== "object") {
		throw new TypeError(`${name} is not a mark object ({index, t, rate})`);
	}
	for (const key of ["index", "t", "rate"]) {
		if (typeof mark[key] !== "number" || !Number.isFinite(mark[key])) {
			throw new TypeError(`${name}.${key} must be a finite number`);
		}
	}
	if (mark.rate <= 0) {
		throw new TypeError(`${name}.rate must be > 0`);
	}
	return mark;
};

// instrument clock origin in host seconds: host time of sample index 0
const origin = (mark) => mark.t - mark.index / mark.rate;

// origin(a) - origin(b), in host seconds; combined with the grid relation above
const offsetSeconds = (a, b) => origin(assertMark(a, "a")) - origin(assertMark(b, "b"));

// the sample of b that is the same physical instant as sample i of a
const alignIndex = (a, b, i) => {
	assertMark(a, "a");
	assertMark(b, "b");
	return Math.round((i / a.rate + offsetSeconds(a, b)) * b.rate);
};

const sampleToHost = (mark, index) => origin(assertMark(mark, "mark")) + index / mark.rate;

const hostToSample = (mark, t) => Math.round((t - origin(assertMark(mark, "mark"))) * mark.rate);

// clock drift of a relative to b in ppm from two marks each (positive: a runs fast)
const driftPpm = (a1, a2, b1, b2) => {
	assertMark(a1, "a1");
	assertMark(a2, "a2");
	assertMark(b1, "b1");
	assertMark(b2, "b2");
	const elapsedA = (a2.index - a1.index) / a2.rate;
	const elapsedB = (b2.index - b1.index) / b2.rate;
	const dt = ((a2.t - a1.t) + (b2.t - b1.t)) / 2;
	if (dt <= 0) {
		throw new TypeError("mark pairs must be ordered in time");
	}
	return (elapsedA - elapsedB) / dt * 1e6;
};

module.exports = { TICK_TOLERANCE_S, assertMark, origin, offsetSeconds, alignIndex, sampleToHost, hostToSample, driftPpm };
