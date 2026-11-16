#!/usr/bin/env python3
"""Cynthion (Great Scott Gadgets) bridge for mailab.

- USB analyzer: drives the analyzer gateware the way Packetry does (vendor
  requests on interface 0 + bulk IN 0x81), decodes packets -> transactions ->
  transfers (python/usb_analyzer.py), keeps a pcap (LINKTYPE_USB_2_0) and
  publishes live stats, a transfer table and the decoded descriptors.
- Facedancer emulation (keyboard typing, mass storage, descriptor fuzzing)
  through the Cynthion "moondancer" backend.
- Board info, bundled/custom gateware, flashing (cynthion package helpers).

Hardware access imports cynthion / facedancer / pyusb lazily (the lab installs
them per feature). MAILAB_CYNTHION_FAKE=1 (or --fake) replaces the board with
a synthetic one: a generated enumeration streamed in the analyzer's wire
format, and emulation that only logs. Nothing here has run against a real
Cynthion yet.
"""

import argparse
import asyncio
import hashlib
import importlib
import importlib.metadata
import os
import random
import shutil
import signal
import threading
import time

import mailab_bridge as mb
import usb_analyzer as U

VID = 0x1D50
PID_CYNTHION = 0x615B
PID_APOLLO = 0x615C
SUBCLASS = {0x00: "apollo", 0x10: "analyzer", 0x20: "facedancer"}
SUBCLASS_ANALYZER = 0x10

REQ_GET_STATE = 0
REQ_SET_STATE = 1
REQ_GET_SPEEDS = 2
REQ_GET_MINOR_VERSION = 4
VENDOR_OUT = 0x41  # vendor | interface | host-to-device
VENDOR_IN = 0xC1
BULK_EP = 0x81
READ_SIZE = 0x10000
READ_TIMEOUT_MS = 100
STOP_DRAIN_S = 2.0

PUBLISH_S = 1.0
MAX_LOG_LINES = 20
TABLE_ROWS = 200
MAX_DECODE_ROWS = 2000
DEFAULT_MAX_PACKETS = 2_000_000

GATEWARE = ("analyzer", "facedancer", "selftest")
TOOLCHAIN = ("yosys", "nextpnr-ecp5", "ecppack")
PACKAGES = ("cynthion", "apollo-fpga", "facedancer", "pyusb", "amaranth", "luna-usb")

FAKE = os.environ.get("MAILAB_CYNTHION_FAKE") == "1"


def _hw_import(name):
    """Import a hardware library, seeing packages pip installed after we started."""
    importlib.invalidate_caches()
    try:
        return importlib.import_module(name)
    except ImportError as err:
        raise RuntimeError("%s is not installed (%s): the lab installs it with the first hardware command" % (name, err))


def _cynthion_call(fn, *args):
    """cynthion's CLI helpers sys.exit() on errors; turn that into an exception."""
    try:
        return fn(*args)
    except SystemExit as err:
        raise RuntimeError("cynthion helper failed (exit %s); see the log" % err.code)


# ---- analyzer backends --------------------------------------------------------

class HardwareAnalyzer:
    """Cynthion running the analyzer gateware (1d50:615b, interface subclass 0x10)."""

    def __init__(self, serial=None):
        self.usb = _hw_import("usb.core")
        self.util = _hw_import("usb.util")
        found = None
        for dev in self.usb.find(find_all=True, idVendor=VID, idProduct=PID_CYNTHION):
            if not _has_subclass(dev, SUBCLASS_ANALYZER):
                continue
            if serial and _safe(lambda: dev.serial_number) != serial:
                continue
            found = dev
            break
        if found is None:
            raise RuntimeError("no Cynthion running the analyzer gateware found (1d50:615b, interface subclass 0x10); "
                               "load it with gateware {name: \"analyzer\"} or check the CONTROL port cable")
        self.dev = found
        self.util.claim_interface(found, 0)

    def speeds(self):
        flags = self.dev.ctrl_transfer(VENDOR_IN, REQ_GET_SPEEDS, 0, 0, 1)[0]
        return [name for name, bit in U.SPEED_FLAGS.items() if flags & bit]

    def minor_version(self):
        return _safe(lambda: self.dev.ctrl_transfer(VENDOR_IN, REQ_GET_MINOR_VERSION, 0, 0, 1)[0])

    def start(self, speed):
        self.dev.ctrl_transfer(VENDOR_OUT, REQ_SET_STATE, 1 | (U.SPEED_BITS[speed] << 1), 0, None)

    def read(self):
        try:
            return bytes(self.dev.read(BULK_EP, READ_SIZE, READ_TIMEOUT_MS))
        except self.usb.USBTimeoutError:
            return b""

    def stop(self):
        self.dev.ctrl_transfer(VENDOR_OUT, REQ_SET_STATE, 0, 0, None)

    def close(self):
        _safe(lambda: self.util.release_interface(self.dev, 0))
        self.util.dispose_resources(self.dev)


class FakeAnalyzer:
    """Synthetic board: a keyboard enumerating, in the analyzer's wire format,
    handed out in odd-sized chunks so records straddle reads."""

    CHUNK = 37

    def __init__(self, serial=None):
        self.serial = serial
        self._chunks = []
        self._lock = threading.Lock()

    def speeds(self):
        return ["auto", "low", "full", "high"]

    def minor_version(self):
        return 1

    def start(self, speed):
        detected = "full" if speed == "auto" else speed
        records = [(0, "capture_start_" + speed), (120, "vbus_valid"), (600, "bus_reset"), (3000, "speed_" + detected)]
        for pkt in U.synthetic_enumeration():
            # SOF every 1 ms (60000 cycles), packets a few µs apart
            records.append((60000 if pkt[0] == U.pid_byte("SOF") else 300, pkt))
        stream = U.encode_stream(records)
        with self._lock:
            self._chunks = [stream[i:i + self.CHUNK] for i in range(0, len(stream), self.CHUNK)]

    def read(self):
        with self._lock:
            if self._chunks:
                return self._chunks.pop(0)
        time.sleep(0.02)
        return b""

    def stop(self):
        with self._lock:
            self._chunks.append(U.encode_stream([(10, "capture_stop")]))

    def close(self):
        pass


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def _has_subclass(dev, subclass):
    try:
        return any(intf.bInterfaceClass == 0xFF and intf.bInterfaceSubClass == subclass
                   for cfg in dev for intf in cfg)
    except Exception:
        return False


# ---- capture ------------------------------------------------------------------------

class Capture:
    """One capture: analyzer stream (or a loaded pcap) -> stored packets + decoder."""

    def __init__(self, analyzer=None, speed="auto", max_packets=DEFAULT_MAX_PACKETS):
        self.analyzer = analyzer
        self.speed = speed
        self.max_packets = max_packets
        self.parser = U.StreamParser()
        self.decoder = U.Decoder()
        self.packets = []
        self.dropped = 0
        self.lock = threading.Lock()
        self.start_ns = time.time_ns()
        self.running = False
        self.stop_seen = False
        self.error = None
        self.source = "analyzer" if analyzer else None
        self.changed = True
        self._halt = threading.Event()
        self._thread = None

    def start(self):
        self.analyzer.start(self.speed)
        self.running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        try:
            while not self._halt.is_set():
                chunk = self.analyzer.read()
                if chunk:
                    self.ingest(chunk)
        except Exception as err:  # unplugged, libusb error: report, stop reading
            self.error = str(err)
            mb.log("capture stopped: %s" % err, "error")
        finally:
            self.running = False

    def ingest(self, chunk):
        with self.lock:
            for rec in self.parser.feed(chunk):
                self.add(rec)
            self.changed = True

    def add(self, rec):
        if rec["kind"] == "event":
            if rec["name"] == "none":
                return
            self.decoder.event(rec["t"], rec["name"])
            if rec["name"].startswith("capture_stop"):
                self.stop_seen = True
            return
        if len(self.packets) < self.max_packets:
            self.packets.append((rec["t"], rec["data"]))
        else:
            self.dropped += 1
        self.decoder.packet(rec["t"], rec["data"])

    def load(self, packets, start_ns):
        self.source = "pcap"
        self.start_ns = start_ns
        with self.lock:
            for t, data in packets:
                self.add({"kind": "packet", "t": t, "data": data})
            self.decoder.flush()
            self.changed = True

    def stop(self):
        if self._thread is None:
            return
        if self.running:
            _safe(self.analyzer.stop)
            # the gateware flushes what it buffered, then a stop event
            deadline = time.monotonic() + STOP_DRAIN_S
            while self.running and not self.stop_seen and time.monotonic() < deadline:
                time.sleep(0.01)
        self._halt.set()
        self._thread.join(timeout=2)
        self._thread = None
        _safe(self.analyzer.close)
        with self.lock:
            self.decoder.flush()
            self.changed = True

    def summary(self):
        st = dict(self.decoder.stats)
        st["pids"] = dict(st["pids"])
        st["naks"] = dict(st["naks"])
        duration = ((st["last"] or 0) - (st["first"] or 0)) / 1e9
        st.update({"running": self.running, "source": self.source, "speedRequested": self.speed,
                   "stored": len(self.packets), "dropped": self.dropped, "error": self.error,
                   "durationS": round(duration, 6), "events": self.decoder.events[-20:],
                   "devices": {str(a): d.get("summary") for a, d in self.decoder.devices.items()}})
        return st

    def pcap(self):
        with self.lock:
            return U.write_pcap(self.packets, self.start_ns)


# ---- descriptor fuzzing ------------------------------------------------------------------

# (target, offset, label) of fields hosts trust while enumerating; offsets are
# into the keyboard's device / configuration descriptor (usb_analyzer.keyboard_descriptors)
FUZZ_FIELDS = [
    ("device", 0, "device.bLength"), ("device", 1, "device.bDescriptorType"),
    ("device", 7, "device.bMaxPacketSize0"), ("device", 14, "device.iManufacturer"),
    ("device", 17, "device.bNumConfigurations"), ("config", 0, "config.bLength"),
    ("config", 2, "config.wTotalLength.lo"), ("config", 3, "config.wTotalLength.hi"),
    ("config", 4, "config.bNumInterfaces"), ("config", 9, "interface.bLength"),
    ("config", 13, "interface.bNumEndpoints"), ("config", 18, "hid.bLength"),
    ("config", 25, "hid.wDescriptorLength.lo"), ("config", 27, "endpoint.bLength"),
    ("config", 31, "endpoint.wMaxPacketSize.lo"), ("config", 32, "endpoint.wMaxPacketSize.hi"),
]
FUZZ_VALUES = (0x00, 0x01, 0x7F, 0x80, 0xFE, 0xFF)


def fuzz_cases(count, seed=1):
    """Boundary values for every field first, then seeded random single-byte mutations."""
    cases = [{"target": t, "offset": o, "value": v, "label": "%s=0x%02x" % (label, v)}
             for t, o, label in FUZZ_FIELDS for v in FUZZ_VALUES]
    rng = random.Random(seed)
    while len(cases) < count:
        t, o, label = rng.choice(FUZZ_FIELDS)
        v = rng.randrange(256)
        cases.append({"target": t, "offset": o, "value": v, "label": "%s=0x%02x" % (label, v)})
    return cases[:count]


def fuzz_device(device, case, seen):
    """Patch a facedancer device instance to serve mutated descriptors. The
    DEVICE handler calls self.get_descriptor(); CONFIGURATION is a bound method
    captured in requestable_descriptors at construction, so it's replaced there."""
    get_device = device.get_descriptor
    get_config = device.requestable_descriptors[2]

    def device_descriptor():
        seen["device"] += 1
        return mutate(get_device(), case, "device")

    def config_descriptor(index):
        seen["config"] += 1
        return mutate(get_config(index), case, "config")
    device.get_descriptor = device_descriptor
    device.requestable_descriptors[2] = config_descriptor
    return device


def mutate(descriptor, case, target):
    data = bytearray(descriptor)
    if case and case["target"] == target and case["offset"] < len(data):
        data[case["offset"]] = case["value"]
    return bytes(data)


# ---- emulation ---------------------------------------------------------------------------

class Emulation:
    """One Facedancer emulation in a background thread (asyncio loop of its own)."""

    def __init__(self, mode, args):
        self.mode = mode
        self.args = args
        self.stop_event = threading.Event()
        self.thread = None
        self.started = time.time()
        self.state = "starting"
        self.detail = ""
        self.results = []

    def start(self, target):
        self.thread = threading.Thread(target=self._run, args=(target,), daemon=True)
        self.thread.start()

    def _run(self, target):
        try:
            self.state = "running"
            target(self)
            self.state = "stopped" if self.stop_event.is_set() else "done"
        except Exception as err:
            self.state = "error"
            self.detail = str(err)
            mb.log("emulation %s failed: %s" % (self.mode, err), "error")
        mb.event("emulation", {"mode": self.mode, "state": self.state, "detail": self.detail})

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=10)

    def status(self):
        return {"mode": self.mode, "state": self.state, "detail": self.detail,
                "runningS": round(time.time() - self.started, 1), "results": self.results[-50:],
                "fake": FAKE}


def _watch(emu, seconds=None):
    """Coroutine ending the emulation on stop (or after `seconds`)."""
    errors = _hw_import("facedancer.errors")

    async def watch():
        end = time.monotonic() + seconds if seconds else None
        while not emu.stop_event.is_set():
            if end and time.monotonic() >= end:
                break
            await asyncio.sleep(0.05)
        raise errors.EndEmulation("emulation finished")
    return watch()


def _keyboard_device():
    return _hw_import("facedancer.devices.keyboard").USBKeyboardDevice


def run_keyboard(emu):
    a = emu.args
    text = str(a.get("text", ""))
    delay = float(a.get("delay", 2.0))
    key_s = float(a.get("keyS", 0.05))
    stay = mb.parse_switch(a.get("stay", False), "stay")
    if FAKE:
        if emu.stop_event.wait(min(delay, 0.2)):
            return
        mb.log("[fake] typed %r" % text)
        emu.results.append({"typed": len(text)})
        return
    errors = _hw_import("facedancer.errors")
    device = _keyboard_device()()

    async def typer():
        await asyncio.sleep(delay)
        await device.type_string(text, duration=key_s)
        emu.results.append({"typed": len(text)})
        mb.log("typed %d characters" % len(text))
        if not stay:
            raise errors.EndEmulation("done typing")
    device.emulate(_watch(emu), typer())


def run_mass_storage(emu):
    a = emu.args
    path = a["path"]
    block = int(a.get("blockSize", 512))
    before = _sha(path)
    if FAKE:
        size = os.path.getsize(path)
        mb.log("[fake] exposing %d bytes (%d blocks of %d) as a mass storage device" % (size, size // block, block))
        emu.results.append({"bytes": size, "blocks": size // block})
        emu.stop_event.wait(float(a.get("duration", 0.2)))
    else:
        umass = _hw_import("facedancer.devices.umass.umass")
        disk = _hw_import("facedancer.devices.umass.disk_image")
        image = disk.RawDiskImage(path, block)
        device = umass.USBMassStorageDevice(image)
        try:
            device.emulate(_watch(emu, a.get("duration")))
        finally:
            image.close()
    if _sha(path) != before:
        name = a.get("save") or "emulated_disk"
        with open(path, "rb") as fh:
            mb.blob(name, fh.read())
        mb.log("the host wrote to the disk image: saved as blob %s" % name)
        emu.results.append({"written": True, "blob": name})


def run_fuzz(emu):
    a = emu.args
    cases = fuzz_cases(int(a.get("count", len(FUZZ_FIELDS) * len(FUZZ_VALUES))), int(a.get("seed", 1)))
    dwell = float(a.get("dwell", 3.0))
    device_d, config_d, _strings = U.keyboard_descriptors()
    base = None if FAKE else _keyboard_device()

    for i, case in enumerate(cases):
        if emu.stop_event.is_set():
            break
        result = {"case": i, "mutation": case["label"]}
        if FAKE:
            result["device"] = mutate(device_d, case, "device").hex()
            result["config"] = mutate(config_d, case, "config").hex()
        else:
            # a fresh keyboard per case (facedancer subclasses lose their inner
            # configurations, so the instance is patched instead)
            seen = {"device": 0, "config": 0}
            fuzz_device(base(), case, seen).emulate(_watch(emu, dwell))
            result["requests"] = dict(seen)
        emu.results.append(result)
        emu.detail = "case %d/%d %s" % (i + 1, len(cases), case["label"])
        mb.log("fuzz %s: %s" % (emu.detail, result.get("requests", "fake")))
    mb.value("fuzz", emu.results)


EMULATIONS = {"keyboard": run_keyboard, "mass_storage": run_mass_storage, "fuzz": run_fuzz}


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# ---- board info / gateware ---------------------------------------------------------------

def package_versions():
    out = {}
    for name in PACKAGES:
        try:
            out[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            out[name] = None
    return out


def toolchain():
    """LUNA / amaranth gateware builds need yosys + nextpnr-ecp5 + ecppack (not installed by mailab)."""
    tools = {name: shutil.which(name) for name in TOOLCHAIN}
    versions = package_versions()
    missing = [n for n, p in tools.items() if not p] + [n for n in ("amaranth", "luna-usb") if not versions.get(n)]
    return {"tools": tools, "amaranth": versions.get("amaranth"), "luna": versions.get("luna-usb"),
            "canBuild": not missing, "missing": missing,
            "note": "building LUNA gateware needs amaranth (pip) and yosys, nextpnr-ecp5, ecppack "
                    "(system packages or oss-cad-suite); mailab does not install system toolchains"}


def boards():
    if FAKE:
        return [{"product": "USB Analyzer", "manufacturer": "Cynthion Project", "serial": "FAKE0001",
                 "bcdDevice": "0104", "mode": "analyzer", "speeds": FakeAnalyzer().speeds(), "fake": True}]
    core = _hw_import("usb.core")
    out = []
    for dev in core.find(find_all=True, idVendor=VID):
        if dev.idProduct not in (PID_CYNTHION, PID_APOLLO):
            continue
        modes = []
        _safe(lambda: modes.extend(SUBCLASS.get(i.bInterfaceSubClass, "0x%02x" % i.bInterfaceSubClass)
                                   for cfg in dev for i in cfg if i.bInterfaceClass == 0xFF))
        entry = {"vidPid": "%04x:%04x" % (dev.idVendor, dev.idProduct), "bus": dev.bus, "address": dev.address,
                 "product": _safe(lambda: dev.product), "manufacturer": _safe(lambda: dev.manufacturer),
                 "serial": _safe(lambda: dev.serial_number), "bcdDevice": "%04x" % dev.bcdDevice,
                 "mode": "apollo" if dev.idProduct == PID_APOLLO else (
                     "analyzer" if "analyzer" in modes else ("facedancer" if "facedancer" in modes else "gateware")),
                 "interfaces": modes}
        if dev.idProduct == PID_APOLLO:
            entry.update(_apollo_info(dev))
        elif entry["mode"] == "analyzer":
            entry["speeds"] = _safe(lambda: [n for n, b in U.SPEED_FLAGS.items()
                                             if dev.ctrl_transfer(VENDOR_IN, REQ_GET_SPEEDS, 0, 0, 1)[0] & b])
            entry["protocolMinor"] = _safe(lambda: dev.ctrl_transfer(VENDOR_IN, REQ_GET_MINOR_VERSION, 0, 0, 1)[0])
        if dev.idProduct == PID_CYNTHION:
            entry["note"] = ("Apollo firmware details need Apollo to own the port; the running gateware is "
                             "left alone (gateware/flash report them)")
        out.append(entry)
    return out


def _apollo_info(dev=None, debugger=None):
    def collect():
        apollo = _hw_import("apollo_fpga")
        dbg = debugger or apollo.ApolloDebugger(device=dev)
        return {"hardware": _safe(dbg.get_hardware_name), "firmware": _safe(dbg.get_firmware_version),
                "compatibility": _safe(dbg.get_compatibility_string),
                "usbApi": _safe(dbg.get_usb_api_version_string),
                "revision": "r%d.%d" % (dbg.major, dbg.minor)}
    return _safe(collect, {"apolloError": "could not query Apollo"})


def _debugger():
    apollo = _hw_import("apollo_fpga")
    return apollo.ApolloDebugger(force_offline=True)


# ---- bridge ----------------------------------------------------------------------------

class CynthionBridge:
    def __init__(self, opts):
        self.opts = opts
        self.capture = None
        self.emulation = None
        self.logged = 0
        self.last_packets = 0
        self.last_publish = time.monotonic()
        self.fake_gateware = "analyzer"

    def analyzer(self):
        if FAKE:
            return FakeAnalyzer(self.opts.serial)
        return HardwareAnalyzer(self.opts.serial)

    # -- capture --

    def capture_start(self, args):
        if self.capture and self.capture.running:
            raise RuntimeError("a capture is already running (capture_stop first)")
        speed = str(args.get("speed", self.opts.speed)).lower()
        if speed not in U.SPEED_BITS:
            raise ValueError("speed must be auto, high, full or low")
        if FAKE and self.fake_gateware != "analyzer":
            raise RuntimeError("[fake] the board runs %s gateware, not the analyzer" % self.fake_gateware)
        dev = self.analyzer()
        supported = _safe(dev.speeds, [])
        if supported and speed not in supported:
            dev.close()
            raise RuntimeError("this gateware supports %s, not %s (auto needs Cynthion r0.6+)" % (", ".join(supported), speed))
        self.capture = Capture(dev, speed, int(args.get("maxPackets", self.opts.max_packets)))
        self.logged = 0
        self.last_packets = 0
        self.capture.start()
        mb.status("running", "capturing (%s speed)" % speed)
        return {"capturing": True, "speed": speed, "speeds": supported, "protocolMinor": _safe(dev.minor_version)}

    def capture_stop(self, args):
        cap = self._need_capture()
        cap.stop()
        self.publish(force=True)
        mb.status("running", "capture stopped")
        result = cap.summary()
        result.update(self._save(cap, args.get("name") or self.opts.name))
        return result

    def capture_save(self, args):
        return self._save(self._need_capture(), args.get("name") or self.opts.name)

    def _save(self, cap, name):
        data = cap.pcap()
        mb.blob(name, data)
        return {"blob": name, "pcapBytes": len(data), "linktype": U.LINKTYPE_USB_2_0,
                "note": "LINKTYPE_USB_2_0 pcap: opens in Packetry (packetry <file>) and Wireshark"}

    def capture_status(self, _args):
        return self._need_capture().summary()

    def load(self, args):
        if self.capture and self.capture.running:
            raise RuntimeError("stop the running capture first")
        with open(args["path"], "rb") as fh:
            linktype, start, packets = U.read_pcap(fh.read())
        if linktype != U.LINKTYPE_USB_2_0:
            raise ValueError("pcap linktype %d is not LINKTYPE_USB_2_0 (288)" % linktype)
        cap = Capture()
        cap.load(packets, start)
        self.capture = cap
        self.logged = 0
        self.publish(force=True)
        return cap.summary()

    def decode(self, args):
        cap = self._need_capture()
        view = args.get("view", "transfers")
        offset = int(args.get("offset", 0))
        limit = max(1, min(int(args.get("limit", 100)), MAX_DECODE_ROWS))
        addr = args.get("addr")
        ep = args.get("ep")

        def keep(item):
            return (addr is None or item.get("addr") == int(addr)) and (ep is None or item.get("ep") == int(ep))
        with cap.lock:
            if view == "transfers":
                rows = [dict(U.transfer_row(x), decoded=x.get("decoded"), setup=x.get("setup"))
                        for x in cap.decoder.transfers if keep(x)]
            elif view == "transactions":
                rows = [U.transaction_row(t) for t in cap.decoder.transactions if keep(t)]
                if not mb.parse_switch(args.get("sof", False), "sof"):
                    rows = [r for r in rows if r["token"] is not None or r["errors"]]
                if mb.parse_switch(args.get("hideNak", False), "hideNak"):
                    rows = [r for r in rows if r["handshake"] != "NAK"]
            elif view == "packets":
                rows = []
                for t, data in cap.packets:
                    pkt = U.decode_packet(data, t)
                    if (pkt["name"] == "SOF" and not mb.parse_switch(args.get("sof", False), "sof")) or not keep(pkt):
                        continue
                    if mb.parse_switch(args.get("errorsOnly", False), "errorsOnly") and not pkt["errors"]:
                        continue
                    rows.append({"t_ms": round(t / 1e6, 4), "pid": pkt["name"], "text": U.describe_packet(pkt),
                                 "hex": bytes(data[:48]).hex(), "errors": pkt["errors"] or None})
                    if len(rows) >= offset + limit:
                        break
            else:
                raise ValueError("view must be transfers, transactions or packets")
        return {"view": view, "total": len(rows), "offset": offset, "rows": rows[offset:offset + limit]}

    def descriptors(self, args):
        cap = self._need_capture()
        with cap.lock:
            doc = U.devices_doc(cap.decoder.devices)
        if args.get("addr") is not None:
            return doc.get(str(int(args["addr"])))
        return doc

    def _need_capture(self):
        if self.capture is None:
            raise RuntimeError("no capture: capture_start or load a pcap first")
        return self.capture

    def publish(self, force=False):
        cap = self.capture
        if cap is None or not (cap.changed or force):
            return
        now = time.monotonic()
        with cap.lock:
            cap.changed = False
            new = cap.decoder.take_new_transfers()
            summary = cap.summary()
            rows = [U.transfer_row(x) for x in cap.decoder.transfers[-TABLE_ROWS:]]
            devices = U.devices_doc(cap.decoder.devices)
        control = [x for x in new if x["type"] == "control"]
        for x in control[:MAX_LOG_LINES]:
            text = "%d.%d %s → %d bytes %s" % (x["addr"], x["ep"], x["request"], x["length"], x["status"])
            mb.log(text, "rx")
        if len(control) > MAX_LOG_LINES:
            mb.log("… %d more control transfers" % (len(control) - MAX_LOG_LINES), "rx")
        others = len(new) - len(control)
        if others:
            mb.log("%d bulk/interrupt transfers" % others, "rx")
        mb.value("capture", summary)
        mb.value("transfers", rows)
        mb.value("devices", devices)
        dt = max(now - self.last_publish, 1e-3)
        mb.sample("packet_rate", round((summary["packets"] - self.last_packets) / dt, 1), "pkt/s")
        self.last_packets = summary["packets"]
        self.last_publish = now

    # -- emulation --

    def emulate(self, args):
        mode = args.get("mode")
        if mode not in EMULATIONS:
            raise ValueError("mode must be one of %s" % ", ".join(EMULATIONS))
        if self.emulation and self.emulation.state in ("starting", "running"):
            raise RuntimeError("an emulation is already running (emulate_stop first)")
        if mode == "mass_storage" and not args.get("path"):
            raise ValueError("mass_storage needs a disk image: {blob: \"<lab blob>\"}")
        if mode == "keyboard" and not args.get("text"):
            raise ValueError("keyboard needs {text}")
        if self.capture and self.capture.running and not FAKE:
            raise RuntimeError("the analyzer is capturing; Facedancer needs the facedancer gateware (stop the capture)")
        loaded = self._ensure_facedancer(mb.parse_switch(args.get("gateware", True), "gateware"))
        os.environ["BACKEND"] = "cynthion"
        emu = Emulation(mode, args)
        self.emulation = emu
        emu.start(EMULATIONS[mode])
        return {"started": mode, "gatewareLoaded": loaded, "fake": FAKE,
                "note": "the emulated device appears on the TARGET C port"}

    def _ensure_facedancer(self, allowed):
        if FAKE:
            if self.fake_gateware != "facedancer":
                if not allowed:
                    raise RuntimeError("[fake] facedancer gateware is not loaded")
                self.fake_gateware = "facedancer"
                return True
            return False
        cyn = _hw_import("cynthion")
        if _safe(lambda: cyn.Cynthion().supports_api("moondancer"), False):
            return False
        if not allowed:
            raise RuntimeError("the Cynthion is not running the facedancer gateware (gateware {name: \"facedancer\"})")
        self.gateware({"name": "facedancer"})
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            time.sleep(0.5)
            if _safe(lambda: cyn.Cynthion().supports_api("moondancer"), False):
                return True
        raise RuntimeError("loaded the facedancer gateware but the moondancer API did not come up")

    def emulate_stop(self, _args):
        if not self.emulation:
            return {"stopped": False}
        self.emulation.stop()
        return self.emulation.status()

    def emulate_status(self, _args):
        return self.emulation.status() if self.emulation else {"state": "idle"}

    # -- board --

    def info(self, _args):
        return {"fake": FAKE, "packages": package_versions(), "boards": boards(), "toolchain": toolchain(),
                "gateware": self.fake_gateware if FAKE else None,
                "pcap": "captures are LINKTYPE_USB_2_0 (288) pcaps: open them in Packetry"}

    def gateware(self, args):
        name = args.get("name")
        path = args.get("path")
        if not path and name not in GATEWARE:
            raise ValueError("name must be one of %s, or pass a bitstream {blob}" % ", ".join(GATEWARE))
        if self.capture and self.capture.running:
            raise RuntimeError("stop the capture before reconfiguring the FPGA")
        label = name or "custom (%s)" % os.path.basename(path)
        if FAKE:
            if path:
                _check_bitstream(path)
            self.fake_gateware = name or "custom"
            mb.log("[fake] running %s gateware" % label)
            return {"gateware": label, "fake": True}
        util = _hw_import("cynthion.commands.util")
        dbg = _debugger()
        board = _apollo_info(debugger=dbg)
        if path:
            _check_bitstream(path)
            _cynthion_call(util.run_bitstream, dbg, path)
        elif name == "facedancer":
            # this is what `cynthion run facedancer` does: SoC firmware into its flash region + bitstream
            _cynthion_call(util.flash_soc_firmware, dbg, util.find_cynthion_asset("moondancer.bin"))
            _cynthion_call(util.run_bitstream, dbg, util.find_cynthion_bitstream(dbg, "facedancer.bit"))
        else:
            _cynthion_call(util.run_bitstream, dbg, util.find_cynthion_bitstream(dbg, name + ".bit"))
            if name == "selftest":
                return dict(self._selftest(dbg), board=board)
        return {"gateware": label, "board": board, "volatile": True}

    def _selftest(self, dbg):
        gw = _hw_import("cynthion.selftest.gateware")
        host = _hw_import("cynthion.selftest.host")
        dbg.close()
        tester = host.StandaloneTester(gw.SelftestDevice())
        result = _safe(tester.run_tests, "see log")
        return {"gateware": "selftest", "result": result, "note": "per-test output is in the device log"}

    def flash(self, args):
        name = args.get("name")
        path = args.get("path")
        if not path and name not in GATEWARE:
            raise ValueError("name must be one of %s, or pass a bitstream {blob}" % ", ".join(GATEWARE))
        if self.capture and self.capture.running:
            raise RuntimeError("stop the capture before flashing")
        if path:
            _check_bitstream(path)
        if FAKE:
            mb.log("[fake] flashed %s" % (name or path))
            return {"flashed": name or "custom", "fake": True}
        util = _hw_import("cynthion.commands.util")
        dbg = _debugger()
        if path:
            _cynthion_call(util.flash_bitstream, dbg, path)
        else:
            if name == "facedancer":
                _cynthion_call(util.flash_soc_firmware, dbg, util.find_cynthion_asset("moondancer.bin"))
            _cynthion_call(util.flash_bitstream, dbg, util.find_cynthion_bitstream(dbg, name + ".bit"))
        return {"flashed": name or "custom", "note": "the board boots this gateware from now on"}

    def shutdown(self):
        if self.capture and self.capture.running:
            self.capture.stop()
        if self.emulation:
            self.emulation.stop()


def _check_bitstream(path):
    """ECP5 bitstreams start with 0xFF padding then the 0xBDB3 preamble (or a comment block)."""
    with open(path, "rb") as fh:
        head = fh.read(4096)
    if len(head) < 64 or (b"\xff\x00" not in head[:4] and b"\xbd\xb3" not in head):
        raise ValueError("%s doesn't look like an ECP5 bitstream" % path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", default=None)
    parser.add_argument("--speed", default="auto")
    parser.add_argument("--name", default="capture")
    parser.add_argument("--max-packets", type=int, default=DEFAULT_MAX_PACKETS)
    parser.add_argument("--fake", action="store_true")
    opts = parser.parse_args()
    global FAKE
    FAKE = FAKE or opts.fake

    # cynthion / facedancer print to stdout; keep that out of the protocol
    mb.protect_stdout()
    cb = CynthionBridge(opts)
    bridge = mb.Bridge()
    commands = [
        ("info", "board(s), gateware, package + LUNA toolchain versions", cb.info),
        ("capture_start", "{speed: auto|high|full|low, maxPackets} start the analyzer", cb.capture_start),
        ("capture_stop", "{name} stop; saves the pcap blob <id>_<name> (default capture)", cb.capture_stop),
        ("capture_save", "{name} save the pcap so far", cb.capture_save),
        ("capture_status", "packet / transfer counts, speed, events", cb.capture_status),
        ("load", "{blob} decode a LINKTYPE_USB_2_0 pcap (e.g. saved by Packetry)", cb.load),
        ("decode", "{view: transfers|transactions|packets, addr, ep, offset, limit, sof, hideNak, errorsOnly}", cb.decode),
        ("descriptors", "{addr} what the captured device(s) enumerated as", cb.descriptors),
        ("emulate", "{mode: keyboard|mass_storage|fuzz, ...} Facedancer emulation (approval)", cb.emulate),
        ("emulate_stop", "stop the emulation", cb.emulate_stop),
        ("emulate_status", "emulation state and results", cb.emulate_status),
        ("gateware", "{name: analyzer|facedancer|selftest} or {blob} load into the FPGA (approval)", cb.gateware),
        ("flash", "{name} or {blob} write the configuration flash (approval)", cb.flash),
    ]
    for name, doc, fn in commands:
        bridge.command(name, doc)(fn)
    bridge.every(PUBLISH_S, cb.publish)
    # the lab stops helpers with SIGTERM: leave the run loop so the analyzer is stopped
    signal.signal(signal.SIGTERM, lambda *_: setattr(bridge, "stopping", True))
    mb.status("running", "fake Cynthion" if FAKE else "ready")
    try:
        bridge.run()
    finally:
        cb.shutdown()


if __name__ == "__main__":
    main()
