const fs = require("fs");
const os = require("os");
const path = require("path");
const minipro = require("..");
const parse = require("../parse");

// captured from minipro 0.7.4 without a programmer
const INFO = [
	"",
	"---------------Chip Info----------------",
	"Name: W25Q128JV@SOIC8",
	"Available on: TL866II, T48, T56",
	"Memory: 16777216 Bytes",
	"Package: DIP8",
	"ICSP: ICP009.JPG",
	"Protocol: 0x03",
	"Read buffer size: 4096 Bytes",
	"Write buffer size: 256 Bytes",
	"----------------------------------------",
	"Available SPI clock frequencies [MHz]: ",
	"4, 8, 15, 30",
	"----------------------------------------"
].join("\n");
const SEARCH = "BW25Q128A@SOP8\nBW25Q128A@WSON8\nW25Q128BV@SOIC8\nW25Q128BV(OTP)@SOIC8\n";
const NO_PROGRAMMER_PROMPT = "No device found. Which database do you want to display?\n1) TL866A/CS\n2) TL866II+/T48/T56\n3) T76\n4) Abort\nAborted.\n";
// from the minipro sources (not yet seen on hardware)
const ID_OK = "Found T48 01.1.32 (0x120)\nDevice code: 46A16257\nSerial code: HSSCVO9LARFMOWJ4SPJG\nUSB speed: 12Mbps (USB 1.1)\nChip ID: 0xEF4018  OK\n";
const ID_BAD = "Found T48 01.1.32 (0x120)\nChip ID mismatch: expected 0xEF4018, got 0xC22018 (unknown)\n";

describe("minipro output parsing", () => {
	test("chip info", () => {
		const info = parse.info(INFO);
		expect(info).toMatchObject({
			found: true,
			name: "W25Q128JV@SOIC8",
			availableOn: ["TL866II", "T48", "T56"],
			memoryBytes: 16777216,
			package: "DIP8",
			protocol: "0x03"
		});
		expect(parse.info("Device W25Q128 not found!\n").found).toBe(false);
	});

	test("search results, prompt noise dropped", () => {
		expect(parse.search(SEARCH)).toEqual(["BW25Q128A@SOP8", "BW25Q128A@WSON8", "W25Q128BV@SOIC8", "W25Q128BV(OTP)@SOIC8"]);
		expect(parse.search(NO_PROGRAMMER_PROMPT)).toEqual([]);
	});

	test("programmer presence", () => {
		expect(parse.presence("Supported programmers: TL866A/CS, TL866II+, T48, T56, T76\nNo programmer found.\n")).toEqual({ connected: false, model: null });
		expect(parse.presence("Found T48 01.1.32 (0x120)\n")).toEqual({ connected: true, model: "T48" });
	});

	test("chip id", () => {
		expect(parse.chipId(ID_OK)).toMatchObject({ id: "0xEF4018", match: true });
		expect(parse.chipId(ID_BAD)).toMatchObject({ id: "0xC22018", expected: "0xEF4018", match: false });
		expect(parse.failureHint(ID_BAD)).toMatch(/mismatch/);
	});

	test("chip arguments are validated", () => {
		expect(minipro._chipArgs({ chip: "AT28C256@DIP28", page: "data" })).toEqual(["-p", "AT28C256@DIP28", "-c", "data"]);
		expect(() => minipro._chipArgs({})).toThrow(/chip is required/);
		expect(() => minipro._chipArgs({ chip: "-w/etc/x" })).toThrow(/not a valid name/);
		expect(() => minipro._chipArgs({ chip: "AT28C256", page: "all" })).toThrow(/page/);
	});
});

describe("minipro driver with a fake binary", () => {
	test("read collects code, eeprom and fuses; write takes a lab blob", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minipro-fake-"));
		const fake = path.join(dir, "minipro");
		const argsLog = path.join(dir, "args");
		fs.writeFileSync(fake, [
			"#!/bin/sh",
			"echo \"$@\" >> " + JSON.stringify(argsLog),
			"while [ $# -gt 0 ]; do",
			"  if [ \"$1\" = \"-r\" ]; then printf 'CODE' > \"$2\"; printf 'EE' > \"$2.eeprom.bin\"; printf 'lfuse = 0x62\\n' > \"$2.fuses.conf\"; fi",
			"  if [ \"$1\" = \"-w\" ]; then cat \"$2\" > " + JSON.stringify(path.join(dir, "written")) + "; fi",
			"  shift",
			"done"
		].join("\n") + "\n", { mode: 0o755 });
		const blobs = { src_rom: Buffer.from("NEW!") };
		const values = {};
		const io = {
			id: "mp",
			blob: (name, data) => {
				blobs[name] = Buffer.from(data);
			},
			getBlob: (name) => blobs[name],
			value: (name, v) => {
				values[name] = v;
			},
			log: () => {}
		};
		const dev = minipro.create({ path: fake, chip: "ATMEGA328P@DIP28" }, io);
		return dev.command("read", {})
			.then((res) => {
				expect(blobs.rom.toString()).toBe("CODE");
				expect(blobs.rom_eeprom.toString()).toBe("EE");
				expect(values.rom_fuses).toBe("lfuse = 0x62\n");
				expect(res.blobs.map((b) => b.blob)).toEqual(["mp_rom", "mp_rom_eeprom"]);
				return dev.command("write", { blob: "src_rom", unprotect: true });
			})
			.then((res) => {
				expect(res).toMatchObject({ ok: true, bytes: 4 });
				expect(fs.readFileSync(path.join(dir, "written"), "utf8")).toBe("NEW!");
				const lines = fs.readFileSync(argsLog, "utf8").trim().split("\n");
				expect(lines[1]).toMatch(/^-p ATMEGA328P@DIP28 -w \S+image\.bin -u$/);
				fs.rmSync(dir, { recursive: true, force: true });
			});
	});
});
