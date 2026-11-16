// mailab-managed Python: a venv in DATA_DIR/python (with system site
// packages, so apt-installed SoapySDR / liquid-dsp bindings stay visible),
// and per-driver pip requirements installed on demand.
//
// Set MAILAB_MANAGE_PYTHON=0 (or PYTHON=/path/to/python) to manage it yourself.

const fs = require("fs");
const path = require("path");
const spawn = require("child_process").spawn;
const config = require("../../config");
const serialize = require("../../utils/mutex").serialize;

const VENV_DIR = "python";
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

const run = (cmd, args, log) => {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { timeout: INSTALL_TIMEOUT_MS });
		let err = "";
		const forward = (data) => {
			String(data).split("\n").filter(Boolean).forEach((line) => {
				if (log) {
					log(line);
				}
			});
		};
		child.stdout.on("data", forward);
		child.stderr.on("data", (d) => {
			err += d;
			forward(d);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(cmd + " " + args.join(" ") + " failed: " + err.trim().split("\n").slice(-3).join(" ")));
			}
		});
	});
};

const managed = () => config.get("MAILAB_MANAGE_PYTHON") !== "0" && !process.env.PYTHON;

const venvDir = () => path.join(config.get("DATA_DIR"), VENV_DIR);

const venvPython = () => path.join(venvDir(), "bin", "python");

// import name for a pip package when they differ
const IMPORT_NAMES = { hidapi: "hid", pyserial: "serial", "opencv-python-headless": "cv2", "opencv-contrib-python-headless": "cv2" };

// "pymp305==0.5.3" -> "pymp305": requirements are pinned, imports aren't
const distName = (requirement) => String(requirement).split(/[<>=!~;[\s]/)[0];

// "numpy==2.5.3" -> "2.5.3" (only exact pins are compared)
const pinnedVersion = (requirement) => {
	const m = /==\s*([^\s;,]+)/.exec(String(requirement));
	return m ? m[1] : null;
};

/**
 * Requirements whose installed version differs from the pin. Pins are not
 * enforced on what's already importable (a system numpy / SoapySDR stack must
 * not be shadowed by a venv copy): mismatches are only reported.
 * @param {string[]} requirements
 * @param {Object} versions dist name -> installed version (null = unknown)
 * @returns {string[]} warnings
 */
const pinMismatches = (requirements, versions) => [].concat(requirements || []).filter((r) => {
	const want = pinnedVersion(r);
	const have = versions[distName(r)];
	return want && have && have !== want;
}).map((r) => distName(r) + " " + versions[distName(r)] + " is installed, " + r + " is pinned (kept: pins only apply to fresh installs)");

const importName = (requirement) => {
	const name = distName(requirement);
	return IMPORT_NAMES[name] || name.replace(/-/g, "_");
};

const pyenv = {
	managed: managed,

	/**
	 * Interpreter to run bridges with.
	 */
	python: () => {
		if (managed() && fs.existsSync(venvPython())) {
			return venvPython();
		}
		return config.get("PYTHON");
	},

	/**
	 * Make sure the venv exists and `packages` are importable; installs what's missing.
	 * Serialized: two devices starting at once don't run pip concurrently.
	 * @param {string[]} packages pip names
	 * @param {function(string)} [log] progress lines
	 * @returns {Promise<string>} python path
	 */
	ensure: serialize((packages, log) => {
		if (!managed()) {
			return Promise.resolve(config.get("PYTHON"));
		}
		let ready = Promise.resolve();
		if (!fs.existsSync(venvPython())) {
			if (log) {
				log("creating mailab python venv in " + venvDir());
			}
			fs.mkdirSync(config.get("DATA_DIR"), { recursive: true });
			ready = run(config.get("PYTHON"), ["-m", "venv", "--system-site-packages", venvDir()], log);
		}
		return ready.then(() => {
			const wanted = [].concat(packages || []);
			if (!wanted.length) {
				return venvPython();
			}
			// import check: system site packages count as installed
			const imports = wanted.map(importName);
			// argv: import names, "--", dist names; prints the missing imports, then dist=version pairs
			const probe = "import importlib.util, importlib.metadata as md, sys\n"
				+ "i = sys.argv.index('--')\n"
				+ "print(' '.join(n for n in sys.argv[1:i] if importlib.util.find_spec(n) is None))\n"
				+ "def v(d):\n    try:\n        return md.version(d)\n    except Exception:\n        return ''\n"
				+ "print(' '.join(d + '=' + v(d) for d in sys.argv[i + 1:]))";
			return new Promise((resolve, reject) => {
				const child = spawn(venvPython(), ["-c", probe].concat(imports, ["--"], wanted.map(distName)));
				let out = "";
				child.stdout.on("data", (d) => {
					out += d;
				});
				child.on("error", reject);
				child.on("close", () => {
					const lines = out.split("\n");
					const versions = {};
					(lines[1] || "").trim().split(/\s+/).filter(Boolean).forEach((pair) => {
						const eq = pair.indexOf("=");
						versions[pair.slice(0, eq)] = pair.slice(eq + 1) || null;
					});
					pinMismatches(wanted, versions).forEach((warning) => {
						if (log) {
							log(warning);
						}
					});
					resolve((lines[0] || "").trim().split(/\s+/).filter(Boolean));
				});
			}).then((missingImports) => {
				const missing = wanted.filter((p, i) => missingImports.indexOf(imports[i]) !== -1);
				if (!missing.length) {
					return venvPython();
				}
				if (log) {
					log("installing " + missing.join(", ") + " into the mailab venv");
				}
				return run(venvPython(), ["-m", "pip", "install", "--disable-pip-version-check", "-q"].concat(missing), log).then(() => venvPython());
			});
		});
	}),

	importName: importName,
	pinMismatches: pinMismatches,

	_venvDir: venvDir
};

module.exports = pyenv;
