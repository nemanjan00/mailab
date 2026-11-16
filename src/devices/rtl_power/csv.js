// rtl_power CSV (also soapy_power -F rtl_power):
//   2026-11-16, 22:10:01, 88000000, 90000000, 10000.00, 4096, -52.1, -50.3, ...
// One sweep is several hop lines with the same timestamp.

/**
 * One CSV line -> {key, low, high, step, samples, db: number[]} or null.
 */
const parseLine = (line) => {
	const f = line.split(",").map((s) => s.trim());
	if (f.length < 7) {
		return null;
	}
	const low = Number(f[2]);
	const high = Number(f[3]);
	const step = Number(f[4]);
	if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(step) || step <= 0) {
		return null;
	}
	const db = f.slice(6).filter((s) => s !== "").map((s) => {
		// rtl_power prints "nan" / "-inf" for empty bins
		const n = Number(s);
		if (Number.isFinite(n)) {
			return n;
		}
		return null;
	});
	return { key: f[0] + " " + f[1], low: low, high: high, step: step, samples: Number(f[5]), db: db };
};

/**
 * Hop lines -> {x: Hz[], y: dB[]} sorted by frequency (null bins dropped).
 */
const joinHops = (hops) => {
	const x = [];
	const y = [];
	hops.slice().sort((a, b) => a.low - b.low).forEach((hop) => {
		hop.db.forEach((v, i) => {
			if (v !== null) {
				x.push(hop.low + i * hop.step);
				y.push(v);
			}
		});
	});
	return { x: x, y: y };
};

/**
 * Collect hop lines into sweeps. A sweep ends when the timestamp changes,
 * the frequency wraps back, or a hop reaches the configured stop.
 * @param {{stop: number, bin: number}} range
 * @param {function({t: string, x: number[], y: number[]})} onSweep
 */
const sweepAssembler = (range, onSweep) => {
	let hops = [];

	const flush = () => {
		if (!hops.length) {
			return;
		}
		const key = hops[0].key;
		const sweep = joinHops(hops);
		hops = [];
		onSweep({ t: key, x: sweep.x, y: sweep.y });
	};

	const push = (line) => {
		const hop = parseLine(line);
		if (!hop) {
			return;
		}
		const prev = hops[hops.length - 1];
		if (prev && (prev.key !== hop.key || hop.low <= prev.low)) {
			flush();
		}
		hops.push(hop);
		if (range && range.stop && hop.high >= range.stop - (range.bin || 0)) {
			flush();
		}
	};

	return { push: push, flush: flush };
};

/**
 * Byte chunks -> complete lines.
 */
const lineSplitter = (onLine) => {
	let pending = "";
	return (chunk) => {
		const parts = (pending + chunk.toString()).split(/\r?\n/);
		pending = parts.pop();
		parts.forEach((line) => {
			if (line.trim()) {
				onLine(line);
			}
		});
	};
};

module.exports = {
	parseLine: parseLine,
	joinHops: joinHops,
	sweepAssembler: sweepAssembler,
	lineSplitter: lineSplitter
};
