const pyenv = require("..");

describe("pyenv", () => {
	test("import names strip version pins", () => {
		expect(pyenv.importName("pymp305==0.5.3")).toBe("pymp305");
		expect(pyenv.importName("hidapi==0.15.0")).toBe("hid");
		expect(pyenv.importName("pyserial>=3.5")).toBe("serial");
		expect(pyenv.importName("foo-bar[extra]~=1.0")).toBe("foo_bar");
		expect(pyenv.importName("numpy")).toBe("numpy");
		expect(pyenv.importName("opencv-python-headless==4.14.0.94")).toBe("cv2");
	});

	test("every driver requirement is pinned", () => {
		const devices = require("../../../devices");
		const requirements = [].concat(...Object.values(devices.listMap()).map((d) => d.requires || []));
		expect(requirements.length).toBeGreaterThan(4);
		requirements.forEach((r) => expect(r).toMatch(/==\d/));
	});
});

describe("pins", () => {
	test("installed versions that differ from the pin are reported, not changed", () => {
		expect(pyenv.pinMismatches(["numpy==2.5.3", "pyserial==3.5", "hidapi==0.15.0", "loose"], { numpy: "2.2.4", pyserial: "3.5", hidapi: null }))
			.toEqual(["numpy 2.2.4 is installed, numpy==2.5.3 is pinned (kept: pins only apply to fresh installs)"]);
	});
});
