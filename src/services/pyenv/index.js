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
const IMPORT_NAMES = { hidapi: "hid", pyserial: "serial" };

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
			const imports = wanted.map((p) => IMPORT_NAMES[p] || p.replace(/-/g, "_"));
			const probe = "import importlib.util, sys\nmissing = [n for n in sys.argv[1:] if importlib.util.find_spec(n) is None]\nprint(' '.join(missing))";
			return new Promise((resolve, reject) => {
				const child = spawn(venvPython(), ["-c", probe].concat(imports));
				let out = "";
				child.stdout.on("data", (d) => {
					out += d;
				});
				child.on("error", reject);
				child.on("close", () => resolve(out.trim().split(/\s+/).filter(Boolean)));
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

	_venvDir: venvDir
};

module.exports = pyenv;
