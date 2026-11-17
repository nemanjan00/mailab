// .proto -> .ksy conversion via protokai (github.com/nemanjan00/protokai),
// driven through python/protokai_bridge.py (which runs protoc + the protokai
// compiler and prints a JSON spec bundle).

const { execFile } = require("child_process");
const config = require("../config");

const TIMEOUT_MS = 30000;

/**
 * @param {Object} request {files: {"name.proto": text}, type?: string}
 * @returns {Promise<{entry: string, files: Object, warnings: string[]}>}
 *   files maps "<id>.ksy" -> YAML text; entry is the main spec id (no .ksy).
 */
const convert = (request) => {
	const protokaiPath = config.get("PROTOKAI_PATH");
	const env = Object.assign({}, process.env);
	if (protokaiPath) {
		env.PYTHONPATH = env.PYTHONPATH
			? protokaiPath + ":" + env.PYTHONPATH
			: protokaiPath;
	}
	return new Promise((resolve, reject) => {
		const child = execFile(
			config.get("PYTHON"),
			[require("path").join(__dirname, "..", "..", "python", "protokai_bridge.py")],
			{ env: env, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					const detail = (stderr || String(err.message || err)).trim()
						.split("\n").slice(0, 6).join("\n");
					reject(new Error(
						"protokai conversion failed (is PROTOKAI_PATH a protokai checkout with protoc on PATH?)\n" + detail
					));
					return;
				}
				try {
					resolve(JSON.parse(stdout));
				} catch (parseErr) {
					reject(new Error("protokai_bridge returned invalid JSON: " + parseErr.message));
				}
			}
		);
		child.stdin.on("error", () => {}); // EPIPE if the child died early
		child.stdin.end(JSON.stringify(request));
	});
};

module.exports = {
	convert: convert
};
