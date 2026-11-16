const pyenv = require("..");

const GIT = "pymp305 @ git+https://github.com/nemanjan00/pymp305@0437515fbc6eef0b875736b6a2c670ceeb246611#subdirectory=python";
const SHA = "0437515fbc6eef0b875736b6a2c670ceeb246611";

describe("pyenv", () => {
	test("import names strip version pins", () => {
		expect(pyenv.importName("pymp305==0.5.3")).toBe("pymp305");
		expect(pyenv.importName("hidapi==0.15.0")).toBe("hid");
		expect(pyenv.importName("pyserial>=3.5")).toBe("serial");
		expect(pyenv.importName("foo-bar[extra]~=1.0")).toBe("foo_bar");
		expect(pyenv.importName("numpy")).toBe("numpy");
		expect(pyenv.importName("opencv-python-headless==4.14.0.94")).toBe("cv2");
	});

	test("PEP 508 direct references and requirement objects", () => {
		expect(pyenv.distName(GIT)).toBe("pymp305");
		expect(pyenv.distName("pymp305@git+https://x/y@" + SHA)).toBe("pymp305");
		expect(pyenv.importName({ spec: "hidapi==0.15.0", upgrade: true })).toBe("hid");
		expect(pyenv.pinnedCommit(GIT)).toBe(SHA);
		expect(pyenv.pinnedCommit("pymp305 @ git+https://github.com/nemanjan00/pymp305@main")).toBeNull();
		expect(pyenv.pinnedVersion(GIT)).toBeNull();
		expect(pyenv.pinnedVersion({ spec: GIT, version: "0.6.3" })).toBe("0.6.3");
		expect(pyenv.pinnedVersion({ spec: "pymp305==0.6.3", upgrade: true })).toBe("0.6.3");
	});

	test("pinned means ==x.y or a git commit sha", () => {
		expect(pyenv.isPinned("numpy==2.5.3")).toBe(true);
		expect(pyenv.isPinned({ spec: "pymp305==0.6.3", upgrade: true })).toBe(true);
		expect(pyenv.isPinned(GIT)).toBe(true);
		expect(pyenv.isPinned("pymp305 @ git+https://github.com/nemanjan00/pymp305@v0.6.3")).toBe(false);
		expect(pyenv.isPinned("pymp305 @ git+https://github.com/nemanjan00/pymp305@0437515")).toBe(false);
		expect(pyenv.isPinned("pymp305>=0.6")).toBe(false);
		expect(pyenv.isPinned("numpy")).toBe(false);
	});

	test("every driver requirement is pinned", () => {
		const devices = require("../../../devices");
		const drivers = Object.values(devices.listMap());
		const extras = drivers.map((d) => [].concat(...Object.values(d.extras || {})));
		const requirements = [].concat(...drivers.map((d) => d.requires || []), ...extras);
		expect(requirements.length).toBeGreaterThan(4);
		requirements.forEach((r) => {
			expect([JSON.stringify(r), pyenv.isPinned(r)]).toEqual([JSON.stringify(r), true]);
		});
	});

	test("versions compare by release segments", () => {
		expect(pyenv.compareVersions("0.5.3", "0.6.3")).toBeLessThan(0);
		expect(pyenv.compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
		expect(pyenv.compareVersions("2.5", "2.5.0")).toBe(0);
		expect(pyenv.compareVersions("1.0.0rc1", "1.0.0")).toBe(0);
	});
});

describe("pins", () => {
	test("installed versions that differ from a plain pin are reported, not changed", () => {
		expect(pyenv.pinMismatches(["numpy==2.5.3", "pyserial==3.5", "hidapi==0.15.0", "loose"], { numpy: "2.2.4", pyserial: "3.5", hidapi: null }))
			.toEqual(["numpy 2.2.4 is installed, 2.5.3 is pinned (kept: pins only apply to fresh installs)"]);
		const todo = pyenv.plan(["numpy==2.5.3"], { missing: [], dists: { numpy: { version: "2.2.4", commit: null } } });
		expect(todo.install).toEqual([]);
		expect(todo.upgrade).toEqual([]);
	});

	test("missing imports are installed", () => {
		const todo = pyenv.plan([{ spec: "pymp305==0.6.3", upgrade: true }, "hidapi==0.15.0"], { missing: ["pymp305", "hid"], dists: {} });
		expect(todo.install).toEqual(["pymp305==0.6.3", "hidapi==0.15.0"]);
	});

	test("upgrade: an older install is replaced, a newer or equal one kept", () => {
		const req = [{ spec: "pymp305==0.6.3", upgrade: true }];
		const dists = (version, commit) => ({ missing: [], dists: { pymp305: { version: version, commit: commit || null } } });
		const old = pyenv.plan(req, dists("0.5.3"));
		expect(old.upgrade).toEqual(["pymp305==0.6.3"]);
		expect(old.warnings[0]).toMatch(/0\.5\.3 is installed, 0\.6\.3 is pinned: upgrading/);
		expect(pyenv.plan(req, dists("0.6.3"))).toEqual({ install: [], upgrade: [], reinstall: [], warnings: [] });
		const newer = pyenv.plan(req, dists("0.7.0"));
		expect(newer.upgrade).toEqual([]);
		expect(newer.warnings[0]).toMatch(/kept: newer than the pin/);
	});

	test("upgrade with a git commit pin: another commit of the same version is reinstalled", () => {
		const req = [{ spec: GIT, version: "0.6.3", upgrade: true }];
		const dists = (version, commit) => ({ missing: [], dists: { pymp305: { version: version, commit: commit } } });
		expect(pyenv.plan(req, dists("0.5.3", null)).upgrade).toEqual([GIT]);
		expect(pyenv.plan(req, dists("0.6.3", "6b288593b11bcf120abb729f3fbea87999a5c7ff")).reinstall).toEqual([GIT]);
		expect(pyenv.plan(req, dists("0.6.3", SHA))).toEqual({ install: [], upgrade: [], reinstall: [], warnings: [] });
		// the same version from PyPI has no commit: kept
		expect(pyenv.plan(req, dists("0.6.3", null)).reinstall).toEqual([]);
	});
});
