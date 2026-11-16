const fs = require("fs");
const os = require("os");
const path = require("path");
const execFileSync = require("child_process").execFileSync;
const flashrom = require("..");
const parse = require("../parse");
const safety = require("../../../safety");

// captured from flashrom v1.8.0 (dummy programmer and a missing CH341A)
const FOUND = [
	"flashrom v1.8.0 (git:v1.8.0) on Linux 7.2.8-zen1-2-zen (x86_64)",
	"flashrom is free software, get the source code at https://flashrom.org",
	"",
	"Found Winbond flash chip \"W25Q128.V\" (16384 kB, SPI) on dummy.",
	"No operations were specified."
].join("\n");
const MULTIPLE = [
	"Found Macronix flash chip \"MX25L6436E/MX25L6445E/MX25L6465E\" (8192 kB, SPI) on dummy.",
	"Found Macronix flash chip \"MX25L6473F\" (8192 kB, SPI) on dummy.",
	"Multiple flash chip definitions match the detected chip(s): \"MX25L6405\", \"MX25L6405D\", \"MX25L6436E/MX25L6445E/MX25L6465E\", \"MX25L6473F\"",
	"Please specify which chip definition to use with the -c <chipname> option."
].join("\n");
const NONE = "No EEPROM/flash device found.\nNote: flashrom can never write if the flash chip isn't found automatically.\n";
const NO_PROGRAMMER = "Couldn't open device 1a86:5512.\nError: Programmer initialization failed.\n";
const VERIFY_OK = "Found Winbond flash chip \"W25Q128.V\" (16384 kB, SPI) on dummy.\nVerifying flash... VERIFIED.\n";
const VERIFY_FAIL = "Found Winbond flash chip \"W25Q128.V\" (16384 kB, SPI) on dummy.\nVerifying flash... FAILED at 0x00001000! Expected=0x00, Found=0xff, failed byte count from 0x00000000-0x00ffffff: 0x1\n";

const hasFlashrom = (() => {
	try {
		execFileSync("flashrom", ["--version"], { stdio: "ignore" });
		return true;
	} catch (_err) {
		return false;
	}
})();

const fakeIo = (blobs) => {
	return {
		id: "fr",
		blob: (name, data) => {
			blobs[name] = Buffer.from(data);
		},
		getBlob: (name) => {
			if (!blobs[name]) {
				throw new Error("unknown blob: " + name);
			}
			return blobs[name];
		},
		log: () => {},
		status: () => {}
	};
};

describe("flashrom output parsing", () => {
	test("single chip", () => {
		expect(parse.detection(FOUND)).toEqual({
			found: true,
			chips: [{ vendor: "Winbond", name: "W25Q128.V", sizeKb: 16384, bus: "SPI", programmer: "dummy" }],
			candidates: [],
			multiple: false
		});
	});

	test("several matching definitions give chip candidates", () => {
		const det = parse.detection(MULTIPLE);
		expect(det.multiple).toBe(true);
		expect(det.chips.length).toBe(2);
		expect(det.candidates).toEqual(["MX25L6405", "MX25L6405D", "MX25L6436E/MX25L6445E/MX25L6465E", "MX25L6473F"]);
		expect(parse.failureHint(MULTIPLE, det)).toMatch(/pass chip: one of "MX25L6405"/);
	});

	test("no chip, no programmer", () => {
		expect(parse.detection(NONE).found).toBe(false);
		expect(parse.failureHint(NONE, parse.detection(NONE))).toMatch(/no flash chip found/);
		expect(parse.failureHint(NO_PROGRAMMER, parse.detection(NO_PROGRAMMER))).toBe("Couldn't open device 1a86:5512.");
	});

	test("verify result", () => {
		expect(parse.verified(VERIFY_OK)).toBe(true);
		expect(parse.verified(VERIFY_FAIL)).toBe(false);
		expect(parse.verified(FOUND)).toBeNull();
	});
});

describe("flashrom argument validation", () => {
	test("programmer and chip names", () => {
		expect(flashrom._baseArgs({ programmer: "linux_spi:dev=/dev/spidev0.0,spispeed=4000", chip: "MX25L6436E/MX25L6445E/MX25L6465E" }))
			.toEqual(["-p", "linux_spi:dev=/dev/spidev0.0,spispeed=4000", "-c", "MX25L6436E/MX25L6445E/MX25L6465E"]);
		expect(() => flashrom._baseArgs({ programmer: "ch341a_spi; reboot" })).toThrow(/programmer/);
		expect(() => flashrom._baseArgs({ programmer: "-w" })).toThrow(/programmer/);
		expect(() => flashrom._baseArgs({})).toThrow(/programmer/);
		expect(() => flashrom._baseArgs({ programmer: "ch341a_spi", chip: "-r/etc/passwd" })).toThrow(/chip/);
		expect(() => flashrom._baseArgs({ programmer: "ch341a_spi", chip: "a\nb" })).toThrow(/chip/);
	});

	test("write and erase need approval by default, read does not", () => {
		const s = safety.create({}, {});
		expect(s.needsApproval("fr", "flashrom", "write", {})).toBeTruthy();
		expect(s.needsApproval("fr", "flashrom", "erase", {})).toBeTruthy();
		expect(s.needsApproval("mp", "minipro", "write", {})).toBeTruthy();
		expect(s.needsApproval("mp", "minipro", "erase", {})).toBeTruthy();
		expect(s.needsApproval("fr", "flashrom", "read", {})).toBeNull();
		expect(s.needsApproval("x", "process", "write", {})).toBeNull();
	});
});

describe("flashrom driver with a fake binary", () => {
	test("read lands in a blob; a failed run reports the reason", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flashrom-fake-"));
		const fake = path.join(dir, "flashrom");
		// -r <file>: write 4 bytes; "-p none" fails like a missing programmer
		fs.writeFileSync(fake, [
			"#!/bin/sh",
			"if [ \"$2\" = \"none\" ]; then printf 'Couldn'\"'\"'t open device 1a86:5512.\\nError: Programmer initialization failed.\\n' >&2; exit 1; fi",
			"echo 'Found Winbond flash chip \"W25Q128.V\" (16384 kB, SPI) on fake.'",
			"while [ $# -gt 0 ]; do if [ \"$1\" = \"-r\" ]; then printf 'ABCD' > \"$2\"; echo 'Reading flash... done.'; fi; shift; done"
		].join("\n") + "\n", { mode: 0o755 });
		const blobs = {};
		const dev = flashrom.create({ path: fake, programmer: "ch341a_spi" }, fakeIo(blobs));
		return dev.command("read", {})
			.then((res) => {
				expect(res).toMatchObject({ blob: "fr_flash", bytes: 4, chips: [{ name: "W25Q128.V" }] });
				expect(blobs.flash.toString()).toBe("ABCD");
				return dev.command("read", { chip: "--help" }).then(() => {
					throw new Error("should fail");
				}, (err) => {
					expect(err.message).toMatch(/not a valid name/);
				});
			})
			.then(() => {
				const bad = flashrom.create({ path: fake, programmer: "none" }, fakeIo(blobs));
				return bad.command("erase", {}).then(() => {
					throw new Error("should fail");
				}, (err) => {
					expect(err.message).toBe("flashrom erase failed (exit 1): Couldn't open device 1a86:5512.");
				});
			})
			.then(() => {
				fs.rmSync(dir, { recursive: true, force: true });
			});
	});
});

(hasFlashrom ? describe : describe.skip)("flashrom dummy programmer (real flashrom, emulated chip)", () => {
	test("probe, read, verify, write, erase", () => {
		const blobs = {};
		const io = fakeIo(blobs);
		const dev = flashrom.create({ programmer: "dummy:emulate=W25Q128FV" }, io);
		return dev.start()
			.then(() => dev.command("probe", {}))
			.then((det) => {
				expect(det.chips[0]).toMatchObject({ vendor: "Winbond", name: "W25Q128.V", sizeKb: 16384 });
				return dev.command("read", { name: "dump" });
			})
			.then((res) => {
				expect(res.bytes).toBe(16 * 1024 * 1024);
				return dev.command("verify", { blob: "dump" });
			})
			.then((res) => {
				expect(res.verified).toBe(true);
				const changed = Buffer.from(blobs.dump);
				changed[4096] = 0;
				blobs.changed = changed;
				// the emulated chip is blank on every run, so this mismatches
				return dev.command("verify", { blob: "changed" }).then(() => {
					throw new Error("should fail");
				}, (err) => {
					expect(err.message).toMatch(/verify failed .*FAILED at 0x00001000/);
				});
			})
			.then(() => dev.command("write", { data: Buffer.alloc(16 * 1024 * 1024, 0xff).toString("base64") }))
			.then((res) => {
				expect(res.ok).toBe(true);
				return dev.command("erase", {});
			})
			.then((res) => {
				expect(res.ok).toBe(true);
				return dev.command("probe", {}).then(() => {
					const multi = flashrom.create({ programmer: "dummy:emulate=MX25L6436" }, io);
					return multi.command("read", {});
				});
			})
			.then(() => {
				throw new Error("should fail");
			}, (err) => {
				expect(err.message).toMatch(/several chip definitions match, pass chip/);
			});
	}, 60000);
});
