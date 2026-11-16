// mailab-managed Python: a venv in DATA_DIR/python (with system site
// packages, so apt-installed SoapySDR / liquid-dsp bindings stay visible),
// and per-driver pip requirements installed on demand.
//
// Set MAILAB_MANAGE_PYTHON=0 (or PYTHON=/path/to/python) to manage it yourself.
//
// Requirements are pip specs, pinned (`name==x.y`, or a PEP 508 direct
// reference to a git commit: `name @ git+https://...@<40-hex sha>`), or an
// object {spec, version, upgrade} for a pin that must replace an older copy
// (see plan()).

const fs = require("fs");
const path = require("path");
const spawn = require("child_process").spawn;
const config = require("../../config");
const serialize = require("../../utils/mutex").serialize;

const VENV_DIR = "python";
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const PIP = ["-m", "pip", "install", "--disable-pip-version-check", "-q"];

// import name for a pip package when they differ
const IMPORT_NAMES = { hidapi: "hid", pyserial: "serial" };

// a direct reference pinned to a commit: "name @ git+https://...@<40-hex sha>[#subdirectory=...]"
const GIT_COMMIT_PIN = /@\s*git\+\S+@([0-9a-f]{40})(?:#\S*)?$/;

// argv: import names, "--", dist names; prints {missing: [import names], dists: {name: {version, commit}}}
// (commit: pip's direct_url.json vcs commit_id, for git installs)
const PROBE = [
	"import importlib.util, importlib.metadata as md, json, sys",
	"i = sys.argv.index('--')",
	"out = {'missing': [n for n in sys.argv[1:i] if importlib.util.find_spec(n) is None], 'dists': {}}",
	"for d in sys.argv[i + 1:]:",
	"    try:",
	"        dist = md.distribution(d)",
	"    except Exception:",
	"        continue",
	"    commit = None",
	"    try:",
	"        commit = (json.loads(dist.read_text('direct_url.json') or '{}').get('vcs_info') or {}).get('commit_id')",
	"    except Exception:",
	"        pass",
	"    out['dists'][d] = {'version': dist.version, 'commit': commit}",
	"print(json.dumps(out))"
].join("\n");

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

/**
 * A driver requirement: a pip spec string, or an object for what a string
 * can't say:
 *   {spec: "pymp305 @ git+https://...@<sha>#subdirectory=python", version: "0.6.3", upgrade: true}
 * `version` is the version that spec installs (a direct reference doesn't
 * carry one); `upgrade` opts this requirement into replacing an older
 * installed copy.
 * @typedef {string|{spec: string, version: string, upgrade: boolean}} Requirement
 */

/**
 * @param {Requirement} requirement
 * @returns {{spec: string, version: (string|null), upgrade: boolean}}
 */
const normalize = (requirement) => {
	if (requirement && typeof requirement === "object") {
		return { spec: String(requirement.spec).trim(), version: requirement.version || null, upgrade: requirement.upgrade === true };
	}
	return { spec: String(requirement).trim(), version: null, upgrade: false };
};

// "pymp305==0.5.3" / "pymp305 @ git+https://..." -> "pymp305": requirements are pinned, imports aren't
const distName = (requirement) => normalize(requirement).spec.split(/[<>=!~;[\s@]/)[0];

// "numpy==2.5.3" -> "2.5.3" (only exact pins are compared); an object's `version` wins
const pinnedVersion = (requirement) => {
	const r = normalize(requirement);
	if (r.version) {
		return r.version;
	}
	const m = /==\s*([^\s;,]+)/.exec(r.spec);
	return m ? m[1] : null;
};

// "name @ git+https://...@<sha>#subdirectory=python" -> "<sha>"
const pinnedCommit = (requirement) => {
	const m = GIT_COMMIT_PIN.exec(normalize(requirement).spec);
	return m ? m[1] : null;
};

/**
 * Pinned = an exact version (`==x.y`) or a git direct reference to a full commit sha.
 */
const isPinned = (requirement) => {
	const spec = normalize(requirement).spec;
	return /==\s*\d/.test(spec) || pinnedCommit(spec) !== null;
};

/**
 * Compare release segments numerically ("0.10.1" > "0.9"). Pre/post/local
 * suffixes are ignored: enough to tell an old install from a newer pin, not a
 * full PEP 440 implementation.
 * @returns {number} <0, 0 or >0
 */
const compareVersions = (a, b) => {
	const parts = (v) => (/^\d+(\.\d+)*/.exec(String(v)) || ["0"])[0].split(".").map(Number);
	const pa = parts(a);
	const pb = parts(b);
	const diffs = Array.from({ length: Math.max(pa.length, pb.length) }, (_x, i) => (pa[i] || 0) - (pb[i] || 0));
	return diffs.find((d) => d !== 0) || 0;
};

const importName = (requirement) => {
	const name = distName(requirement);
	return IMPORT_NAMES[name] || name.replace(/-/g, "_");
};

/**
 * Decide what to pip install.
 *
 * - not importable: install the spec.
 * - importable, plain requirement: kept. Pins don't replace what's already
 *   there (a system numpy / SoapySDR stack must not be shadowed by a venv
 *   copy); a differing version is only reported.
 * - importable, `upgrade: true`: reinstalled when the installed version is
 *   older than the pin's, or (git commit pins) when it's the pinned version
 *   built from another commit (pip's direct_url.json commit_id). The pinned
 *   version from an index (no commit recorded) or a newer version is kept.
 *
 * @param {Requirement[]} requirements
 * @param {{missing: string[], dists: Object}} probe missing import names, and
 *   dist name -> {version, commit} for what's installed
 * @returns {{install: string[], upgrade: string[], reinstall: string[], warnings: string[]}} pip specs
 *   (reinstall: same version, other commit: forced, without touching dependencies)
 */
const plan = (requirements, probe) => {
	const missing = (probe && probe.missing) || [];
	const dists = (probe && probe.dists) || {};
	const result = { install: [], upgrade: [], reinstall: [], warnings: [] };
	[].concat(requirements || []).map(normalize).forEach((r) => {
		const name = distName(r);
		if (missing.indexOf(importName(r)) !== -1) {
			result.install.push(r.spec);
			return;
		}
		const have = dists[name];
		const want = pinnedVersion(r);
		if (!have || !have.version || !want) {
			return;
		}
		const commit = pinnedCommit(r);
		const cmp = compareVersions(have.version, want);
		if (r.upgrade && cmp < 0) {
			result.upgrade.push(r.spec);
			result.warnings.push(name + " " + have.version + " is installed, " + want + " is pinned: upgrading");
		} else if (r.upgrade && cmp === 0 && commit && have.commit && have.commit !== commit) {
			// same version: pip calls that satisfied, so this one is forced
			result.reinstall.push(r.spec);
			result.warnings.push(name + " " + have.version + " is installed from commit " + have.commit.slice(0, 12)
				+ ", commit " + commit.slice(0, 12) + " is pinned: reinstalling");
		} else if (have.version !== want) {
			result.warnings.push(name + " " + have.version + " is installed, " + want + " is pinned (kept: "
				+ (r.upgrade ? "newer than the pin" : "pins only apply to fresh installs") + ")");
		}
	});
	return result;
};

/**
 * Requirements whose installed version differs from the pin (warnings only).
 * @param {Requirement[]} requirements
 * @param {Object} versions dist name -> installed version (null = unknown)
 * @returns {string[]} warnings
 */
const pinMismatches = (requirements, versions) => {
	const dists = {};
	Object.keys(versions || {}).forEach((name) => {
		dists[name] = { version: versions[name], commit: null };
	});
	return plan(requirements, { missing: [], dists: dists }).warnings;
};

/**
 * Ask the venv's python what's importable and which versions are installed.
 * @param {Requirement[]} requirements
 * @returns {Promise<{missing: string[], dists: Object}>}
 */
const probeInstalled = (requirements) => {
	return new Promise((resolve, reject) => {
		const child = spawn(venvPython(), ["-c", PROBE].concat(requirements.map(importName), ["--"], requirements.map(distName)));
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err += d;
		});
		child.on("error", reject);
		child.on("close", () => {
			try {
				resolve(JSON.parse(out));
			} catch (_err) {
				reject(new Error("python package probe failed: " + (err.trim() || out.trim())));
			}
		});
	});
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
	 * Make sure the venv exists and `packages` are importable; installs what's
	 * missing and upgrades `upgrade: true` pins (see plan()).
	 * Serialized: two devices starting at once don't run pip concurrently.
	 * @param {Requirement[]} packages
	 * @param {function(string)} [log] progress lines
	 * @returns {Promise<string>} python path
	 */
	ensure: serialize((packages, log) => {
		if (!managed()) {
			return Promise.resolve(config.get("PYTHON"));
		}
		const say = (line) => {
			if (log) {
				log(line);
			}
		};
		let ready = Promise.resolve();
		if (!fs.existsSync(venvPython())) {
			say("creating mailab python venv in " + venvDir());
			fs.mkdirSync(config.get("DATA_DIR"), { recursive: true });
			ready = run(config.get("PYTHON"), ["-m", "venv", "--system-site-packages", venvDir()], log);
		}
		return ready.then(() => {
			const wanted = [].concat(packages || []);
			if (!wanted.length) {
				return venvPython();
			}
			// import check: system site packages count as installed
			return probeInstalled(wanted).then((probe) => {
				const todo = plan(wanted, probe);
				todo.warnings.forEach(say);
				let steps = Promise.resolve();
				if (todo.install.length) {
					say("installing " + todo.install.join(", ") + " into the mailab venv");
					steps = steps.then(() => run(venvPython(), PIP.concat(todo.install), log));
				}
				if (todo.upgrade.length) {
					// --upgrade replaces the older copy; its dependencies only move if the new one needs it
					steps = steps.then(() => run(venvPython(), PIP.concat(["--upgrade", "--upgrade-strategy", "only-if-needed"], todo.upgrade), log));
				}
				if (todo.reinstall.length) {
					steps = steps.then(() => run(venvPython(), PIP.concat(["--force-reinstall", "--no-deps"], todo.reinstall), log));
				}
				return steps.then(() => venvPython());
			});
		});
	}),

	importName: importName,
	distName: distName,
	pinnedVersion: pinnedVersion,
	pinnedCommit: pinnedCommit,
	isPinned: isPinned,
	compareVersions: compareVersions,
	plan: plan,
	pinMismatches: pinMismatches,

	_venvDir: venvDir
};

module.exports = pyenv;
