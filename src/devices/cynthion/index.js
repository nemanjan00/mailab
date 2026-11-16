// Cynthion (Great Scott Gadgets) USB 2.0 analyzer / Facedancer emulator, via
// python/cynthion_bridge.py (decoding in python/usb_analyzer.py).
//
// Captures land in blob <id>_<name> as LINKTYPE_USB_2_0 (288) pcaps, which
// open in Packetry; live stats / transfer table / decoded descriptors go to
// values <id>_capture, <id>_transfers, <id>_devices. Emulation, gateware and
// flash need a person's approval (safety DEFAULT_POLICY).
//
// pip packages are installed per feature on first use (capture / board /
// emulation), not at start: decoding a pcap needs nothing beyond python.
// MAILAB_CYNTHION_FAKE=1 (or option fake) runs a synthetic board. Only tested
// with that fake; no Cynthion has been attached yet.

const fs = require("fs");
const os = require("os");
const path = require("path");
const processDriver = require("../process");
const pyenv = require("../../services/pyenv");
const tool = require("../../utils/tool");
const parseSwitch = require("../../utils/args").parseSwitch;
const sanitizeName = require("../../channels").sanitizeName;

const SCRIPT = path.join(__dirname, "..", "..", "..", "python", "cynthion_bridge.py");
const BOARD_REQUIRES = ["cynthion==0.2.5", "apollo-fpga==1.1.1"];
const FEATURES = {
	analyzer: BOARD_REQUIRES,
	board: BOARD_REQUIRES,
	emulation: BOARD_REQUIRES.concat(["facedancer==3.1.3"])
};
const COMMAND_FEATURES = {
	capture_start: "analyzer",
	info: "board",
	gateware: "board",
	flash: "board",
	emulate: "emulation"
};
// commands that take an image ({blob} | {file} | {data}), passed on as a temp file path
const IMAGE_COMMANDS = ["load", "gateware", "flash", "emulate"];
// the temp copy lives as long as the emulation (the host may write to a disk image)
const KEEP_IMAGE = ["emulate"];

const hasImage = (args) => Boolean(args.blob || args.file || (typeof args.data === "string" && args.data !== ""));

const isFake = (options) => {
	if (process.env.MAILAB_CYNTHION_FAKE === "1") {
		return true;
	}
	return options.fake === undefined ? false : parseSwitch(options.fake, "fake");
};

const create = (options, io) => {
	const fake = isFake(options);
	let inner = null;
	let keptDir = null;

	const dropKept = () => {
		if (keptDir) {
			fs.rmSync(keptDir, { recursive: true, force: true });
			keptDir = null;
		}
	};

	// the venv gets a feature's packages on its first use (fake needs none)
	const ensureFeature = (name) => {
		const feature = COMMAND_FEATURES[name];
		if (fake || !feature) {
			return Promise.resolve();
		}
		return pyenv.ensure(FEATURES[feature], (line) => io.log(line, "setup"));
	};

	/**
	 * Replace {blob | file | data} with {path} of a temp copy.
	 * @returns {{args: Object, cleanup: function}}
	 */
	const withImageFile = (name, args) => {
		if (IMAGE_COMMANDS.indexOf(name) === -1 || !hasImage(args)) {
			if (args.path !== undefined) {
				throw new Error("pass images as {blob}, {file} or {data}, not {path}");
			}
			return { args: args, cleanup: () => {} };
		}
		const data = tool.imageFrom(args, io);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-cynthion-"));
		const file = path.join(dir, "image.bin");
		fs.writeFileSync(file, data);
		const rest = Object.assign({}, args, { path: file });
		delete rest.blob;
		delete rest.file;
		delete rest.data;
		const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
		if (KEEP_IMAGE.indexOf(name) !== -1) {
			dropKept();
			keptDir = dir;
			return { args: rest, cleanup: () => {} };
		}
		return { args: rest, cleanup: cleanup };
	};

	const run = (name, args) => {
		const prepared = withImageFile(name, args);
		return inner.command(name, prepared.args).then((result) => {
			prepared.cleanup();
			return result;
		}, (err) => {
			prepared.cleanup();
			throw err;
		});
	};

	// blobs the bridge saves are <id>_<name> in the lab
	const qualify = (result) => {
		if (result && typeof result.blob === "string") {
			return Object.assign({}, result, { blob: io.id + "_" + sanitizeName(result.blob) });
		}
		return result;
	};

	return {
		start: () => {
			return pyenv.ensure([], (line) => io.log(line, "setup")).then((python) => {
				const args = [SCRIPT].concat(processDriver.toFlags(options, ["serial", "speed", "name", "maxPackets"]));
				inner = processDriver.create({
					command: python,
					args: args,
					env: { MAILAB_CYNTHION_FAKE: fake ? "1" : "0" }
				}, io);
				return inner.start();
			});
		},

		stop: () => {
			const done = inner ? inner.stop() : Promise.resolve();
			return done.then(() => {
				dropKept();
			});
		},

		command: (name, args) => {
			if (!inner) {
				return Promise.reject(new Error("not started"));
			}
			const a = args || {};
			return Promise.resolve()
				.then(() => {
					return ensureFeature(name);
				})
				.then(() => {
					return run(name, a);
				})
				.then((result) => {
					if (name === "emulate_stop") {
						dropKept();
					}
					return qualify(result);
				});
		}
	};
};

module.exports = {
	name: "cynthion",
	description: "Great Scott Gadgets Cynthion: USB 2.0 analyzer (pcap blobs for Packetry, decoded transfers + descriptors), Facedancer emulation, gateware (emulate/gateware/flash need approval)",
	options: {
		serial: "board serial number (default: first Cynthion found)",
		speed: "default capture speed: auto|high|full|low (default auto)",
		name: "capture blob name (default capture → blob <id>_capture)",
		maxPackets: "packets kept per capture (default 2000000; counting continues past it)",
		fake: "true = synthetic board, no hardware (also MAILAB_CYNTHION_FAKE=1)"
	},
	commands: {
		info: "board(s): mode (analyzer/facedancer/apollo), speeds, Apollo firmware; package versions; LUNA toolchain (amaranth, yosys, nextpnr-ecp5, ecppack) present or missing",
		capture_start: "{speed: auto|high|full|low, maxPackets} capture the TARGET port; live log + values <id>_capture, <id>_transfers, <id>_devices",
		capture_stop: "{name} stop; pcap (LINKTYPE_USB_2_0, opens in Packetry) → blob <id>_<name>",
		capture_save: "{name} save the pcap captured so far",
		capture_status: "packets, PIDs, NAKs, errors, speed, bus events",
		load: "{blob | file | data} decode an existing LINKTYPE_USB_2_0 pcap (e.g. saved by Packetry)",
		decode: "{view: transfers|transactions|packets, addr, ep, offset, limit, sof, hideNak, errorsOnly}",
		descriptors: "{addr} what the device(s) enumerated as: device / configuration / string descriptors",
		emulate: "{mode: keyboard {text, delay, keyS, stay} | mass_storage {blob, blockSize, duration, save} | fuzz {count, seed, dwell}, gateware: true} Facedancer on TARGET C; needs approval",
		emulate_stop: "stop the emulation",
		emulate_status: "emulation state and results",
		gateware: "{name: analyzer|facedancer|selftest} or {blob | file} custom bitstream: load into the FPGA (volatile); needs approval",
		flash: "{name: analyzer|facedancer|selftest} or {blob | file}: write the configuration flash; needs approval"
	},
	requires: FEATURES.emulation,
	create: create
};
