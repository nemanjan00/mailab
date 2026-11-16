// Runs the python protocol decoder checks (python/test_decode.py): UART, SPI,
// I2C, Manchester waveforms through the builtin decoders, and through the real
// libsigrokdecode decoder scripts when they are installed. Skipped without numpy.

const fs = require("fs");
const path = require("path");
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");
const flowgraph = require("..");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");
const SIGROK_DECODERS = "/usr/share/libsigrokdecode/decoders/uart/pd.py";

const available = () => {
	const probe = spawnSync(config.get("PYTHON"), ["-c", "import numpy"], { cwd: PYTHON_DIR });
	return probe.status === 0;
};

const maybe = available() ? test : test.skip;

maybe("protocol decoders recover the bytes", () => {
	const run = spawnSync(config.get("PYTHON"), ["test_decode.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 120000 });
	if (run.status !== 0) {
		throw new Error(run.stdout + run.stderr);
	}
	["uart builtin", "spi builtin", "i2c builtin", "manchester builtin", "external"].forEach((name) => {
		expect(run.stdout).toMatch(new RegExp("ok " + name));
	});
	if (fs.existsSync(SIGROK_DECODERS)) {
		["uart sigrok", "spi sigrok", "i2c sigrok"].forEach((name) => {
			expect(run.stdout).toMatch(new RegExp("ok " + name));
		});
	} else {
		expect(run.stdout).toMatch(/skip sigrok/);
	}
}, 150000);

describe("blob arguments", () => {
	const io = {
		getBlob: (name) => {
			if (name !== "la_logic") {
				throw new Error("unknown blob: " + name);
			}
			return Buffer.from([1, 2, 3]);
		}
	};

	test("decode / feed get the blob bytes as base64 data", () => {
		expect(flowgraph._resolveBlob(io, "decode", { blob: "la_logic", samplerate: 1 })).toEqual({ data: "AQID", samplerate: 1 });
		expect(flowgraph._resolveBlob(io, "feed", { blob: "la_logic", block: "d" })).toEqual({ data: "AQID", block: "d" });
	});

	test("other commands and blob-less calls pass through", () => {
		const args = { blob: "la_logic" };
		expect(flowgraph._resolveBlob(io, "set_graph", args)).toBe(args);
		expect(flowgraph._resolveBlob(io, "decode", { hex: "00" })).toEqual({ hex: "00" });
	});

	test("unknown blobs fail", () => {
		expect(() => flowgraph._resolveBlob(io, "decode", { blob: "nope" })).toThrow(/unknown blob/);
	});
});
