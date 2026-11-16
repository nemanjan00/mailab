// Blob analysis: entropy profile, `file` identification, binwalk signatures
// and binary diff. Works on any lab blob (dumps, captures, bit streams).

const fs = require("fs");
const os = require("os");
const path = require("path");
const createHash = require("crypto").createHash;
const spawn = require("child_process").spawn;

const DEFAULT_WINDOW = 256;
const MAX_POINTS = 4000;
// "high" = within this margin of what random data reaches in the window
const HIGH_MARGIN = 0.35;
const LOW_ENTROPY = 1.0;
const DIFF_GAP = 4;
const MAX_DIFF_RANGES = 2000;
const TOOL_TIMEOUT_MS = 30000;

/**
 * Run a tool with `input` on stdin; resolves stdout (rejects on failure).
 */
const run = (cmd, args, input) => {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { timeout: TOOL_TIMEOUT_MS });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err += d;
		});
		child.on("error", reject);
		// `file -` reads only the head and exits: writing the rest of a large
		// blob (a 16 MB flash dump) then fails with EPIPE, which would crash
		// the server if unhandled. The exit code still decides the result.
		child.stdin.on("error", () => {});
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(cmd + ": " + (err.trim() || "exit " + code)));
				return;
			}
			resolve(out);
		});
		if (input) {
			child.stdin.end(input);
		} else {
			child.stdin.end();
		}
	});
};

/**
 * Shannon entropy (bits per byte) of buf[start, end).
 */
const entropyOf = (buf, start, end) => {
	const counts = new Uint32Array(256);
	for (let i = start; i < end; i++) {
		counts[buf[i]]++;
	}
	const n = end - start;
	let h = 0;
	counts.forEach((c) => {
		if (c) {
			const p = c / n;
			h -= p * Math.log2(p);
		}
	});
	return h;
};

/**
 * Sliding-window entropy profile, at most MAX_POINTS windows.
 * @returns {{window: number, step: number, x: number[], y: number[], mean: number, regions: Object[]}}
 */
const entropy = (buf, window) => {
	const w = Math.max(16, Math.min(window || DEFAULT_WINDOW, buf.length || 16));
	const step = Math.max(1, Math.ceil(Math.max(1, buf.length - w) / MAX_POINTS));
	const x = [];
	const y = [];
	for (let start = 0; start + w <= buf.length; start += step) {
		x.push(start);
		y.push(Math.round(entropyOf(buf, start, start + w) * 1000) / 1000);
	}
	// always cover the tail, whatever the step
	if (buf.length >= w && x[x.length - 1] !== buf.length - w) {
		x.push(buf.length - w);
		y.push(Math.round(entropyOf(buf, buf.length - w, buf.length) * 1000) / 1000);
	}
	// random bytes can't reach 8 bits in a small window: expected max is about
	// 8 - 255 / (2 w ln 2) (Miller-Madow bias)
	const high = 8 - 255 / (2 * w * Math.LN2) - HIGH_MARGIN;
	// contiguous high (compressed/encrypted) and low (padding) stretches
	const regions = [];
	let current = null;
	y.forEach((h, i) => {
		let kind = null;
		if (h >= high) {
			kind = "high";
		} else if (h <= LOW_ENTROPY) {
			kind = "low";
		}
		if (current && current.kind === kind) {
			current.end = x[i] + w;
		} else {
			if (current && current.kind) {
				regions.push(current);
			}
			current = { kind: kind, start: x[i], end: x[i] + w };
		}
	});
	if (current && current.kind) {
		regions.push(current);
	}
	// merge same-kind regions closer than one window
	const merged = regions.reduce((acc, region) => {
		const last = acc[acc.length - 1];
		if (last && last.kind === region.kind && region.start - last.end <= w) {
			last.end = Math.max(last.end, region.end);
		} else {
			acc.push(Object.assign({}, region));
		}
		return acc;
	}, []);
	return {
		window: w,
		step: step,
		x: x,
		y: y,
		mean: buf.length ? Math.round(entropyOf(buf, 0, buf.length) * 1000) / 1000 : 0,
		regions: merged,
		highThreshold: Math.round(high * 100) / 100
	};
};

const fileType = (buf) => {
	return Promise.all([run("file", ["-b", "-"], buf), run("file", ["-b", "--mime-type", "-"], buf)])
		.then((out) => ({ type: out[0].trim(), mime: out[1].trim() }), (err) => ({ type: null, mime: null, error: err.message }));
};

const binwalk = (buf) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-binwalk-"));
	const file = path.join(dir, "blob.bin");
	const log = path.join(dir, "out.json");
	fs.writeFileSync(file, buf);
	return run("binwalk", ["-q", "-l", log, file])
		.then(() => {
			const results = JSON.parse(fs.readFileSync(log, "utf8"));
			return [].concat(results).reduce((acc, r) => acc.concat((r.Analysis && r.Analysis.file_map) || []), [])
				.map((m) => ({ offset: m.offset, size: m.size, name: m.name, description: m.description, confidence: m.confidence }));
		}, (err) => ({ error: err.message }))
		.then((out) => {
			fs.rmSync(dir, { recursive: true, force: true });
			return out;
		});
};

/**
 * Full analysis of a buffer.
 * @param {Buffer} buf
 * @param {{window: number, binwalk: boolean}} [options]
 */
const analyze = (buf, options) => {
	const opts = options || {};
	const ent = entropy(buf, opts.window);
	const tasks = [fileType(buf)];
	if (opts.binwalk !== false) {
		tasks.push(binwalk(buf));
	}
	return Promise.all(tasks).then((results) => ({
		size: buf.length,
		sha256: createHash("sha256").update(buf).digest("hex"),
		type: results[0].type,
		mime: results[0].mime,
		entropy: ent,
		signatures: results[1] || []
	}));
};

/**
 * Changed byte ranges between two buffers (ranges closer than DIFF_GAP merge).
 * Bytes past the shorter buffer count as changed.
 */
const diff = (a, b) => {
	const n = Math.max(a.length, b.length);
	const ranges = [];
	let changed = 0;
	let current = null;
	for (let i = 0; i < n; i++) {
		if (i >= a.length || i >= b.length || a[i] !== b[i]) {
			changed++;
			if (current && i - current.end <= DIFF_GAP) {
				current.end = i + 1;
			} else {
				if (current) {
					ranges.push(current);
				}
				current = { start: i, end: i + 1 };
			}
		}
	}
	if (current) {
		ranges.push(current);
	}
	return {
		sizeA: a.length,
		sizeB: b.length,
		changedBytes: changed,
		ranges: ranges.slice(0, MAX_DIFF_RANGES),
		truncated: ranges.length > MAX_DIFF_RANGES
	};
};

module.exports = {
	analyze: analyze,
	entropy: entropy,
	diff: diff,
	fileType: fileType,
	binwalk: binwalk
};
