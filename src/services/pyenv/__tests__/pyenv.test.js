const pyenv = require("..");

describe("pyenv", () => {
	test("import names strip version pins", () => {
		expect(pyenv.importName("pymp305==0.5.3")).toBe("pymp305");
		expect(pyenv.importName("hidapi==0.15.0")).toBe("hid");
		expect(pyenv.importName("pyserial>=3.5")).toBe("serial");
		expect(pyenv.importName("foo-bar[extra]~=1.0")).toBe("foo_bar");
		expect(pyenv.importName("numpy")).toBe("numpy");
	});

	test("every driver requirement is pinned", () => {
		const devices = require("../../../devices");
		const requirements = [].concat(...Object.values(devices.listMap()).map((d) => d.requires || []));
		expect(requirements.length).toBeGreaterThan(4);
		requirements.forEach((r) => expect(r).toMatch(/==\d/));
	});
});
