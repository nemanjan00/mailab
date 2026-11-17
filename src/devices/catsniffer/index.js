// CatSniffer V3 (Electronic Cats): CC1352P7 + SX1262 + RP2040 sniffer.
// Firmware flashing via cc2538-bsl (CC13x2 UART bootloader) and sniff
// bridges (Sniffle BLE, 802.15.4, sub-GHz) as configurable child
// processes. Bridge packet lines ("JSON {ts,rssi,hex}" or "HEX <hex>")
// become io.event packets, an RSSI channel and a PCAP blob.
// Hardware-untested: flasher/bridge commands and the wire protocol are
// best-effort against public docs [HW].

const tty = require("../../services/tty");
const usb = require("../../services/usb");
const tool = require("../../utils/tool");

const RETRY_MS = 1000;

// pcap writer (little-endian, LINKTYPE_IEEE802_15_4 = 195 / USER0 = 147)
const PCAP_MAGIC = 0xa1b2c3d4;
const pcapHeader = (linktype) => {
	const b = Buffer.alloc(24);
	b.writeUInt32LE(PCAP_MAGIC, 0);
	b.writeUInt16LE(2, 4);
	b.writeUInt16LE(4, 6);
	b.writeInt32LE(0, 8);
	b.writeUInt32LE(0, 12);
	b.writeUInt32LE(65535, 16);
	b.writeUInt32LE(linktype, 20);
	return b;
};

const create = (options, io) => {
	const settings = {
		baud: Number(options.baud) || 921600,
		flasher: options.flasher || "python3",
		flasherArgs: options.flasherArgs || ["-m", "cc2538_bsl"],
		bridge: options.bridge || "sniffle",
		linktype: Number(options.linktype) || 195
	};
	let path = null;
	let port = null;
	let stopped = false;
	let retry = null;
	let sniffProc = null;
	let pcapChunks = null;
	let pcapBytes = 0;
	const stats = { packets: 0 };

	const resolve = () => {
		if (options.path) {
			return options.path;
		}
		const found = usb.findPort(usb.serialPorts(usb.inventory().buses), options.match || {});
		return found ? found.node : null;
	};

	const disconnect = () => {
		if (!port) {
			return Promise.resolve();
		}
		port = null;
		return tty.release(path, io.id);
	};

	const connect = () => {
		retry = null;
		if (stopped) {
			return;
		}
		const next = resolve();
		if (!next) {
			io.status("waiting", "CatSniffer not connected" + (options.match ? " (" + JSON.stringify(options.match) + ")" : ""));
			retry = setTimeout(connect, RETRY_MS);
			return;
		}
		try {
			path = next;
			port = tty.acquire(path, { baud: settings.baud, format: "8N1", flow: "none", owner: io.id });
		} catch (err) {
			port = null;
			io.status("waiting", err.message);
			retry = setTimeout(connect, RETRY_MS);
			return;
		}
		port.on("error", (err) => {
			io.log("disconnected: " + err.message, "warn");
			disconnect().then(() => {
				if (!stopped && !retry) {
					retry = setTimeout(connect, RETRY_MS);
				}
			});
		});
		io.status("running", path + " " + settings.baud);
	};

	// bridge packet line -> event + rssi channel + pcap blob chunk
	const handlePacketLine = (line) => {
		let pkt = null;
		const j = /^JSON\s+(.+)$/.exec(line);
		if (j) {
			try {
				pkt = JSON.parse(j[1]);
			} catch (_err) {
				return;
			}
		} else {
			const h = /^HEX\s+([0-9a-f]+)(\s+(-?\d+))?$/.exec(line);
			if (h) {
				pkt = { hex: h[1], rssi: h[3] !== undefined ? Number(h[3]) : undefined };
			}
		}
		if (!pkt || !pkt.hex) {
			return;
		}
		const data = Buffer.from(pkt.hex, "hex");
		const ts = Number(pkt.ts) || Date.now();
		const rssi = pkt.rssi !== undefined && pkt.rssi !== null ? Number(pkt.rssi) : null;
		stats.packets++;
		io.event("packet", { ts: ts, rssi: rssi, hex: pkt.hex, len: data.length });
		if (rssi !== null && Number.isFinite(rssi)) {
			io.sample("rssi", rssi, { unit: "dBm", t: ts });
		}
		const rec = Buffer.alloc(16);
		rec.writeUInt32LE(Math.floor(ts / 1000), 0);
		rec.writeUInt32LE((ts % 1000) * 1000, 4);
		rec.writeUInt32LE(data.length, 8);
		rec.writeUInt32LE(data.length, 12);
		pcapChunks.push(rec, data);
		pcapBytes += 16 + data.length;
		io.sample("packets", stats.packets, { t: ts });
	};

	const commands = {
		// flash firmware via the CC13x2 UART bootloader (cc2538-bsl):
		// put the board in BSL (hold BSL button, reset), then -e -w -r
		flash: (args) => {
			if (!port) {
				throw new Error("not connected");
			}
			return Promise.resolve(tool.imageFrom(args, io)).then((data) => {
				return tool.withTempDir((dir) => {
					const file = require("path").join(dir, "firmware.bin");
					require("fs").writeFileSync(file, data);
					const cli = settings.flasherArgs.concat(["-p", path, "-e", "-w", file, "-r"]);
					io.log("+ " + settings.flasher + " " + cli.join(" "), "tx");
					return tool.run(settings.flasher, cli, { timeoutMs: args.timeoutMs || 120000 }).then((r) => {
						r.output.trim().split("\n").slice(0, 60).forEach((line) => io.log(line, "rx"));
						if (r.code !== 0) {
							throw new Error("flasher exited " + r.code + ": " + r.stderr.trim().split("\n").pop());
						}
						return { ok: true, bytes: data.length };
					});
				});
			});
		},

		// sniff bridge: spawn the protocol bridge (Sniffle / 802.15.4 /
		// sub-GHz); its packet lines feed events/channels/pcap
		sniff: (args) => {
			if (args && args.on === false) {
				if (sniffProc) {
					sniffProc.kill();
					sniffProc = null;
				}
				if (pcapChunks) {
					io.blob("capture", Buffer.concat(pcapChunks));
					const name = "capture";
					pcapChunks = null;
					return { sniffing: false, blob: io.id + "_" + name, packets: stats.packets };
				}
				return { sniffing: false };
			}
			if (sniffProc) {
				throw new Error("already sniffing (sniff {on: false} first)");
			}
			if (!port) {
				throw new Error("not connected");
			}
			const bridge = args.bridge || settings.bridge;
			const rest = (args.args || []).map((a) => String(a));
			const cli = [path].concat(rest);
			io.log("+ " + bridge + " " + cli.join(" "), "tx");
			sniffProc = require("child_process").spawn(bridge, cli, { stdio: ["ignore", "pipe", "pipe"] });
			pcapChunks = [pcapHeader(Number(args.linktype) || settings.linktype)];
			pcapBytes = 24;
			let buf = "";
			const onLine = (line) => {
				io.log(line, "rx");
				handlePacketLine(line.trim());
			};
			sniffProc.stdout.on("data", (d) => {
				buf += d.toString("latin1");
				let i;
				while ((i = buf.indexOf("\n")) !== -1) {
					onLine(buf.slice(0, i));
					buf = buf.slice(i + 1);
				}
			});
			sniffProc.stderr.on("data", (d) => io.log(String(d).trim(), "warn"));
			sniffProc.on("exit", (code) => {
				sniffProc = null;
				if (pcapChunks) {
					io.blob("capture", Buffer.concat(pcapChunks));
					pcapChunks = null;
					io.log("capture saved to blob <id>_capture (" + pcapBytes + " bytes)", "info");
				}
				io.log("bridge exited " + code, code ? "warn" : "info");
			});
			return { sniffing: true, bridge: bridge, packets: 0 };
		},

		// raw UART console for manual bridge work
		write_hex: (args) => {
			if (!port) {
				throw new Error("not connected");
			}
			const clean = String(args.hex).replace(/0x/gi, "").replace(/[\s,:]/g, "");
			if (!/^([0-9a-f]{2})*$/i.test(clean) || !clean.length) {
				throw new Error("hex must be pairs of hex digits");
			}
			port.write(Buffer.from(clean, "hex"));
			return { ok: true, bytes: clean.length / 2 };
		},

		status: () => ({ path: path, connected: Boolean(port), sniffing: Boolean(sniffProc), packets: stats.packets, settings: settings })
	};

	return {
		port: () => (port ? path : null),
		start: () => {
			connect();
			return Promise.resolve();
		},
		stop: () => {
			stopped = true;
			clearTimeout(retry);
			if (sniffProc) {
				sniffProc.kill();
				sniffProc = null;
			}
			return disconnect();
		},
		command: (name, args) => {
			if (!commands[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		}
	};
};

module.exports = {
	name: "catsniffer",
	description: "CatSniffer V3 multiprotocol sniffer (CC1352P7 + SX1262): firmware flash via cc2538-bsl, sniff bridges (Sniffle BLE / 802.15.4 / sub-GHz) with packets -> events, RSSI channel and PCAP blob, raw UART console",
	options: {
		path: "fixed device node (or use match)",
		match: "{vid, pid, serial, ...}: stable identity from uart_ports",
		baud: "baud rate (default 921600)",
		flasher: "flasher binary (default python3)",
		flasherArgs: "flasher argv before the file args (default -m cc2538_bsl)",
		bridge: "default sniff bridge binary (default sniffle)",
		linktype: "PCAP linktype (default 195 = IEEE 802.15.4)"
	},
	commands: {
		flash: "{blob|file|data} firmware via the CC13x2 UART bootloader (BSL button + reset first)",
		sniff: "{on: false, bridge?, args?: [], linktype?} start/stop a sniff bridge; packets -> events + rssi channel + PCAP blob",
		write_hex: "{hex} raw bytes to the UART",
		status: "{} port, sniff state, packet count"
	},
	create: create,
	_test: { pcapHeader: pcapHeader }
};
