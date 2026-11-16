// Helpers for drivers wrapping command-line tools (flashrom, minipro):
// execFile with argument arrays (never a shell), stdin closed so interactive
// prompts abort instead of hanging, temp dirs for image files, and strict
// name validation.

const fs = require("fs");
const os = require("os");
const path = require("path");
const execFile = require("child_process").execFile;
const createHash = require("crypto").createHash;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Run a tool. Resolves {code, stdout, stderr, output} whether or not it
 * exited 0 (callers parse the output either way); rejects only if it could
 * not run (missing binary) or timed out.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{timeoutMs: number, onLine: function(string)}} [opts]
 */
const run = (cmd, args, opts) => {
	const o = opts || {};
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, { timeout: o.timeoutMs || DEFAULT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (err, stdout, stderr) => {
			if (err && (err.code === "ENOENT" || err.killed)) {
				let reason = err.message;
				if (err.killed) {
					reason = "timed out after " + (o.timeoutMs || DEFAULT_TIMEOUT_MS) + " ms";
				}
				reject(new Error(cmd + ": " + reason));
				return;
			}
			let code = 0;
			if (err) {
				code = typeof err.code === "number" ? err.code : 1;
			}
			resolve({ code: code, stdout: stdout, stderr: stderr, output: stdout + stderr });
		});
		// tools that ask a question (minipro without a programmer) read EOF and abort
		child.stdin.end();
	});
};

/**
 * Run fn(dir) with a fresh temp dir, removed afterwards.
 * @param {function(string): Promise} fn
 */
const withTempDir = (fn) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-tool-"));
	const cleanup = () => {
		fs.rmSync(dir, { recursive: true, force: true });
	};
	return Promise.resolve()
		.then(() => fn(dir))
		.then((result) => {
			cleanup();
			return result;
		}, (err) => {
			cleanup();
			throw err;
		});
};

/**
 * Image data for write/verify: {blob} (a lab blob name), {file} (a path on
 * the lab host) or {data} (base64).
 * @param {{blob: string, file: string, data: string}} args
 * @param {{getBlob: function(string): Buffer}} io
 * @returns {Buffer}
 */
const imageFrom = (args, io) => {
	if (args.blob) {
		return io.getBlob(String(args.blob));
	}
	if (args.file) {
		return fs.readFileSync(String(args.file));
	}
	if (typeof args.data === "string" && args.data !== "") {
		return Buffer.from(args.data, "base64");
	}
	throw new Error("need the image: {blob: \"<lab blob name>\"}, {file: \"/path\"} or {data: \"<base64>\"}");
};

/**
 * Validate a name passed to a tool as one argument (chip names like
 * "W25Q128.V", "MX25L6436E/MX25L6445E", "AT28C256@DIP28", "W25Q128BV(OTP)@SOIC8").
 * A leading "-" would be read as an option.
 */
const checkName = (value, what) => {
	const s = String(value === undefined || value === null ? "" : value);
	if (!/^[A-Za-z0-9][A-Za-z0-9_.()@/+, -]{0,79}$/.test(s)) {
		throw new Error(what + " " + JSON.stringify(value) + " is not a valid name");
	}
	return s;
};

const sha256 = (buffer) => {
	return createHash("sha256").update(buffer).digest("hex");
};

module.exports = {
	run: run,
	withTempDir: withTempDir,
	imageFrom: imageFrom,
	checkName: checkName,
	sha256: sha256
};
