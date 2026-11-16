// flashrom output parsing (checked against flashrom v1.8.0).

const FOUND_RE = /^Found (.+?) flash chip "(.+?)" \((\d+) kB, ([^)]+)\)(?: on ([^.]+))?\.?\s*$/;
const MULTIPLE_RE = /^Multiple flash chip definitions match the detected chip\(s\): (.+)$/;

/**
 * Chip detection lines -> {found, chips: [{vendor, name, sizeKb, bus, programmer}], candidates}.
 * candidates: names to pass as `chip` when several definitions match.
 */
const detection = (text) => {
	const chips = [];
	let candidates = [];
	String(text).split("\n").forEach((raw) => {
		const line = raw.trim();
		const m = FOUND_RE.exec(line);
		if (m) {
			chips.push({ vendor: m[1], name: m[2], sizeKb: Number(m[3]), bus: m[4], programmer: m[5] || null });
			return;
		}
		const multi = MULTIPLE_RE.exec(line);
		if (multi) {
			candidates = (multi[1].match(/"([^"]+)"/g) || []).map((q) => q.slice(1, -1));
		}
	});
	return { found: chips.length > 0, chips: chips, candidates: candidates, multiple: candidates.length > 1 };
};

/**
 * Verify outcome: true (VERIFIED), false (FAILED / mismatch) or null (not reported).
 */
const verified = (text) => {
	const s = String(text);
	if (/VERIFIED\./.test(s)) {
		return true;
	}
	if (/Verifying flash\.\.\. FAILED|verify.* FAILED|FAILED at 0x/i.test(s)) {
		return false;
	}
	return null;
};

/**
 * One-line reason for a failed run.
 */
const failureHint = (text, det) => {
	const s = String(text);
	if (det.multiple) {
		return "several chip definitions match, pass chip: one of " + det.candidates.map((c) => JSON.stringify(c)).join(", ");
	}
	if (/No EEPROM\/flash device found/.test(s)) {
		return "no flash chip found (check wiring, power, clip contact)";
	}
	const lines = s.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !/^flashrom (is free|v\d)/.test(l));
	// "Couldn't open device 1a86:5512." comes before "Error: Programmer initialization failed."
	const problem = lines.find((l) => /^(Error:|Couldn't|Cannot|Can't)|FAILED|denied/i.test(l));
	return problem || lines[lines.length - 1] || "";
};

const summary = (det) => {
	if (det.multiple) {
		return "several definitions match: " + det.candidates.join(", ");
	}
	if (!det.found) {
		return "no chip found";
	}
	return det.chips.map((c) => c.vendor + " " + c.name + " (" + c.sizeKb + " kB, " + c.bus + ")").join("; ");
};

module.exports = {
	detection: detection,
	verified: verified,
	failureHint: failureHint,
	summary: summary
};
