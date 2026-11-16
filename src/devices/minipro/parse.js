// minipro output parsing. `info` and `search` formats checked against
// minipro 0.7.4 without a programmer; read_id / autodetect / presence
// formats are from the minipro sources and not yet seen on hardware.

/**
 * `minipro -d <chip>` "Key: value" block -> {name, availableOn, memoryBytes, package, protocol, ...}.
 */
const info = (text) => {
	const out = { found: false, fields: {} };
	const s = String(text);
	if (/Device .* not found!/.test(s)) {
		return out;
	}
	s.split("\n").forEach((raw) => {
		const m = /^([A-Za-z][A-Za-z0-9 ()/_-]*?):\s*(.*)$/.exec(raw.trim());
		if (m && m[2] !== "") {
			out.fields[m[1]] = m[2].trim();
		}
	});
	const f = out.fields;
	if (f.Name) {
		out.found = true;
		out.name = f.Name;
		out.availableOn = (f["Available on"] || "").split(",").map((x) => x.trim()).filter(Boolean);
		out.package = f.Package || null;
		out.protocol = f.Protocol || null;
		const mem = /(\d+)\s*Bytes/i.exec(f.Memory || "");
		out.memoryBytes = mem ? Number(mem[1]) : null;
	}
	return out;
};

/**
 * `minipro -L <text>`: one device name per line.
 */
const search = (text) => {
	return String(text).split("\n").map((l) => l.trim()).filter((l) => {
		return l && !/^(No device found|Which database|\d\)|Aborted|Supported programmers)/.test(l);
	});
};

/**
 * Programmer presence (`minipro -k`).
 */
const presence = (text) => {
	const s = String(text);
	if (/No programmer found/i.test(s)) {
		return { connected: false, model: null };
	}
	const m = /(TL866A|TL866CS|TL866II\+?|T48|T56|T76)/i.exec(s);
	return { connected: Boolean(m), model: m ? m[1] : null };
};

/**
 * Chip ID from `minipro -p <chip> -D` or autodetect (`-a 8`) output.
 * Matching names come back for autodetect.
 */
const chipId = (text) => {
	const s = String(text);
	const out = { id: null, expected: null, match: null, candidates: [] };
	const mismatch = /Chip ID mismatch: expected (0x[0-9A-Fa-f]+), got (0x[0-9A-Fa-f]+)/i.exec(s);
	if (mismatch) {
		out.expected = mismatch[1];
		out.id = mismatch[2];
		out.match = false;
	} else {
		const ok = /(?:Chip ID|ID)\s*[:=]?\s*(0x[0-9A-Fa-f]+)(\s+OK)?/i.exec(s);
		if (ok) {
			out.id = ok[1];
			out.match = ok[2] ? true : null;
		}
	}
	out.candidates = s.split("\n").map((l) => l.trim()).filter((l) => /^[A-Za-z0-9][^\s:]*@[A-Za-z0-9]+$/.test(l));
	return out;
};

/**
 * One-line reason for a failed run.
 */
const failureHint = (text) => {
	const lines = String(text).split("\n").map((l) => l.trim()).filter(Boolean);
	const problem = lines.find((l) => /not found|No programmer|error|failed|mismatch|invalid|Unsupported|overcurrent|Bad pin/i.test(l));
	return problem || lines[lines.length - 1] || "";
};

module.exports = {
	info: info,
	search: search,
	presence: presence,
	chipId: chipId,
	failureHint: failureHint
};
