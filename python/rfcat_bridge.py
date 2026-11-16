"""mailab bridge for RfCat dongles (YARD Stick One 1d50:605b, CC1111 USB
dongles) via rflib (pip install rfcat).

Packets (rx / listen) -> value table "packets" (hex, bytes, rssi, timestamp,
offset into blob "packets"), event "packet" per packet, channel "rssi".
specan -> trace "spectrum" (Hz / dBm). TX (tx / replay) only inside the
allowed bands (--region, --tx-bands); the lab asks a person to approve
tx / replay / power (safety DEFAULT_POLICY).

Hardware-untested: written against the rflib 2.0.1 source and exercised with
the fake dongle (MAILAB_RFCAT_FAKE=1, see FakeRfCat), no dongle at hand.

rflib notes (2.0.1):
- RfCat() retries forever when no dongle answers, so the dongle list is
  checked first and the constructor runs under a time limit
- rflib prints to stdout (the JSON channel); the lab logs such lines as
  "stdout", nothing breaks
"""

import argparse
import base64
import os
import threading
import time

import mailab_bridge as lab

# ---- constants -------------------------------------------------------------

# allowed TX bands per region, Hz (licence-free ISM / SRD only)
REGIONS = {
    "eu": [(433.05e6, 434.79e6), (868.0e6, 868.6e6)],
    "us": [(314.0e6, 316.0e6), (433.05e6, 434.79e6), (902.0e6, 928.0e6)],
    "none": [],
}
# CC1110 / CC1111 synthesizer ranges, Hz
TUNE_RANGES = [(300e6, 348e6), (391e6, 464e6), (782e6, 928e6)]
SPECAN_MAX_FREQ = 936e6

MODULATIONS = {"2FSK": 0x00, "GFSK": 0x10, "ASK_OOK": 0x30, "4FSK": 0x40, "MSK": 0x70}
# 4FSK exists in rflib (CC1101 heritage) but not in the CC1110/CC1111 datasheet
UNSUPPORTED_MODULATIONS = {"4FSK": "4FSK is not a CC1110/CC1111 modulation (CC1101 only)"}
SYNC_MODES = {
    "none": 0, "15/16": 1, "16/16": 2, "30/32": 3,
    "carrier": 4, "carrier+15/16": 5, "carrier+16/16": 6, "carrier+30/32": 7,
}
# MDMCFG1.NUM_PREAMBLE flag <-> preamble bytes
PREAMBLE_FLAGS = {2: 0x00, 3: 0x10, 4: 0x20, 6: 0x30, 8: 0x40, 12: 0x50, 16: 0x60, 24: 0x70}

PART_NAMES = {0x01: "CC1110", 0x11: "CC1111", 0x81: "CC2510", 0x91: "CC2511"}
# radio registers reported by `config` (rflib RadioConfig fields)
REGISTERS = ["sync1", "sync0", "pktlen", "pktctrl1", "pktctrl0", "addr", "channr", "fsctrl1", "fsctrl0",
             "freq2", "freq1", "freq0", "mdmcfg4", "mdmcfg3", "mdmcfg2", "mdmcfg1", "mdmcfg0", "deviatn",
             "mcsm2", "mcsm1", "mcsm0", "foccfg", "bscfg", "agcctrl2", "agcctrl1", "agcctrl0", "frend1",
             "frend0", "pa_table1", "pa_table0"]

RSSI_OFFSET_DB = 74          # CC1111 datasheet, approximate (depends on data rate)
CAPTURE_KEEP = 500           # packets kept for the table / blob / replay
MAX_PAYLOAD = 4096
MAX_REPEAT = 1000
MAX_DELAY_MS = 10000
MAX_TX_SECONDS = 60
MAX_RX_COUNT = 1000
MAX_RX_MS = 600000
LISTEN_POLL_MS = 50
LISTEN_PUBLISH_S = 0.5
LISTEN_RSSI_S = 0.25
OPEN_TIMEOUT_S = 15
APP_SPECAN = 0x43            # rflib ccspecan
SPECAN_QUEUE = 1
SPECAN_POLL_MS = 100

# ---- pure helpers (unit-tested in python/test_rfcat.py) ----------------------


def parse_number(value, name, lo=None, hi=None, integer=False):
    """Strict number: int/float or a numeric string; bools refused."""
    if isinstance(value, bool) or value is None:
        raise ValueError("%s must be a number, got %r" % (name, value))
    try:
        num = float(value)
    except (TypeError, ValueError):
        raise ValueError("%s must be a number, got %r" % (name, value))
    if num != num or num in (float("inf"), float("-inf")):
        raise ValueError("%s must be finite" % name)
    if integer:
        if num != int(num):
            raise ValueError("%s must be an integer, got %r" % (name, value))
        num = int(num)
    if lo is not None and num < lo:
        raise ValueError("%s must be >= %s, got %s" % (name, lo, num))
    if hi is not None and num > hi:
        raise ValueError("%s must be <= %s, got %s" % (name, hi, num))
    return num


_SUFFIX = {"k": 1e3, "m": 1e6, "g": 1e9}


def parse_freq(text):
    """"433.92M" / "433.92e6" / 433920000 -> Hz"""
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        return float(text)
    s = str(text).strip().lower().replace("hz", "")
    mult = 1.0
    if s and s[-1] in _SUFFIX:
        mult = _SUFFIX[s[-1]]
        s = s[:-1]
    return parse_number(s, "frequency") * mult


def parse_bands(text):
    """"433.05M-434.79M,868M-868.6M" (Hz, or k/M/G suffixes) -> [(lo, hi), ...]"""
    bands = []
    for part in str(text).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" not in part[1:]:
            raise ValueError("band %r: expected lo-hi" % part)
        cut = part.index("-", 1)
        lo, hi = parse_freq(part[:cut]), parse_freq(part[cut + 1:])
        if not lo < hi:
            raise ValueError("band %r: lo must be below hi" % part)
        bands.append((lo, hi))
    return bands


def allowed_bands(region, custom=None):
    """TX bands: the region's, or custom ones that must lie inside them
    (options can narrow the allow-list, never widen it)."""
    key = str(region).lower()
    if key not in REGIONS:
        raise ValueError("unknown region %r (one of %s)" % (region, ", ".join(sorted(REGIONS))))
    base = REGIONS[key]
    if not custom:
        return list(base)
    bands = parse_bands(custom) if isinstance(custom, str) else [tuple(b) for b in custom]
    for lo, hi in bands:
        if not any(blo <= lo and hi <= bhi for blo, bhi in base):
            raise ValueError("txBands %.6g-%.6g Hz is outside the %s bands %s"
                             % (lo, hi, key, format_bands(base) or "(none)"))
    return bands


def format_bands(bands):
    return ", ".join("%.3f-%.3f MHz" % (lo / 1e6, hi / 1e6) for lo, hi in bands)


def occupied_half_bw(modulation, drate, deviation):
    """Rough half occupied bandwidth: FSK = deviation + rate/2, OOK = rate."""
    if modulation == "ASK_OOK":
        return float(drate)
    return float(deviation) + float(drate) / 2.0


def check_tx(freq, half_bw, bands):
    """Raise unless [freq - half_bw, freq + half_bw] fits inside one band."""
    lo, hi = freq - half_bw, freq + half_bw
    for blo, bhi in bands:
        if blo <= lo and hi <= bhi:
            return True
    raise ValueError("TX refused: %.6f MHz (+-%.1f kHz) is outside the allowed bands (%s)"
                     % (freq / 1e6, half_bw / 1e3, format_bands(bands) or "none: region is 'none'"))


def check_tune(freq):
    if not any(lo <= freq <= hi for lo, hi in TUNE_RANGES):
        raise ValueError("%.6f MHz is outside the CC1111 ranges (300-348, 391-464, 782-928 MHz)" % (freq / 1e6))
    return freq


def rssi_dbm(raw):
    """CC1111 RSSI register byte (int or 1-byte bytes) -> dBm (approximate)"""
    if isinstance(raw, (bytes, bytearray)):
        raw = raw[0] if raw else 0
    v = raw - 256 if raw >= 128 else raw
    return v / 2.0 - RSSI_OFFSET_DB


def specan_dbm(frame):
    """rflib specan frame bytes -> dBm per channel (ccspecan's formula)"""
    return [((b ^ 0x80) / 2.0) - 88 for b in bytearray(frame)]


def specan_byte(dbm):
    """inverse of specan_dbm (the fake dongle's frames); -88..+39.5 dBm"""
    return (int(round((dbm + 88) * 2)) & 0xFF) ^ 0x80


def format_packet(n, data, t_ms, rssi=None, offset=None):
    data = bytes(data)
    row = {"n": n, "t": t_ms, "len": len(data), "hex": data.hex(), "bytes": list(data),
           "ascii": "".join(chr(c) if 32 <= c < 127 else "." for c in data), "rssi": rssi}
    if offset is not None:
        row["offset"] = offset
    return row


def parse_payload(args):
    """Exactly one of hex / text / data (base64) -> bytes"""
    given = [k for k in ("hex", "text", "data") if args.get(k) not in (None, "")]
    if len(given) != 1:
        raise ValueError("give exactly one of hex, text, data (base64), blob")
    key = given[0]
    if key == "hex":
        clean = "".join(ch for ch in str(args["hex"]) if ch not in " :-_\n\t")
        if clean.lower().startswith("0x"):
            clean = clean[2:]
        payload = bytes.fromhex(clean)
    elif key == "text":
        payload = str(args["text"]).encode("utf8")
    else:
        payload = base64.b64decode(args["data"], validate=True)
    if not payload:
        raise ValueError("empty payload")
    if len(payload) > MAX_PAYLOAD:
        raise ValueError("payload is %d bytes, max %d" % (len(payload), MAX_PAYLOAD))
    return payload


def parse_modulation(value):
    name = str(value).strip().upper().replace("-", "_").replace("/", "_")
    name = {"OOK": "ASK_OOK", "ASK": "ASK_OOK", "FSK": "2FSK", "2_FSK": "2FSK", "4_FSK": "4FSK"}.get(name, name)
    if name not in MODULATIONS:
        raise ValueError("modulation must be one of %s, got %r" % (", ".join(MODULATIONS), value))
    if name in UNSUPPORTED_MODULATIONS:
        raise ValueError(UNSUPPORTED_MODULATIONS[name])
    return name


def parse_sync_mode(value):
    if isinstance(value, str) and value.strip().lower() in SYNC_MODES:
        return SYNC_MODES[value.strip().lower()]
    return parse_number(value, "syncMode", 0, 7, integer=True)


def parse_sync_word(value):
    if isinstance(value, str):
        s = value.strip().lower()
        num = int(s, 16) if s.startswith("0x") or any(c in "abcdef" for c in s) else int(s)
    else:
        num = parse_number(value, "syncWord", integer=True)
    if not 0 <= num <= 0xFFFF:
        raise ValueError("syncWord must be 16 bits, got %r" % value)
    return num


def preamble_flag(nbytes):
    n = parse_number(nbytes, "preamble", integer=True)
    if n not in PREAMBLE_FLAGS:
        raise ValueError("preamble must be one of %s bytes" % sorted(PREAMBLE_FLAGS))
    return PREAMBLE_FLAGS[n]


def preamble_bytes(flag):
    for n, f in PREAMBLE_FLAGS.items():
        if f == flag:
            return n
    return None


def tx_plan(args):
    """repeat / delayMs from tx args, bounded"""
    repeat = parse_number(args.get("repeat", 1), "repeat", 1, MAX_REPEAT, integer=True)
    delay = parse_number(args.get("delayMs", 0), "delayMs", 0, MAX_DELAY_MS)
    if repeat * delay / 1000.0 > MAX_TX_SECONDS:
        raise ValueError("repeat * delayMs is over %d s" % MAX_TX_SECONDS)
    return repeat, delay


# ---- fake dongle (MAILAB_RFCAT_FAKE=1) ----------------------------------------


class FakeTimeout(Exception):
    pass


class FakeRadioConfig:
    def __init__(self):
        for reg in REGISTERS:
            setattr(self, reg, 0)
        self.sync1, self.sync0 = 0x0C, 0x4E
        self.pktlen, self.pktctrl0 = 0xFF, 0x05
        self.mdmcfg2, self.mdmcfg1 = 0x03, 0x22
        self.pa_table0 = 0xC0


class FakeRfCat:
    """Stands in for rflib.RfCat: the rflib methods the bridge calls, with an
    "air" loopback (transmitted packets come back on RX) and a few packets
    already in the air."""

    def __init__(self, idx=0):
        self.idx = idx
        self.radiocfg = FakeRadioConfig()
        self.freq = 433.92e6
        self.drate = 4800.0
        self.deviation = 5157.0
        self.chanbw = 101562.5
        self.chanspc = 199951.0
        self.crc = True
        self.manchester = False
        self.mode = "RX"
        self.air = [bytes.fromhex("aa5501020304"), b"hello rfcat"]
        self.sent = []
        self.specan = None
        self._lock = threading.Lock()

    # identity
    def ping(self, count=10, buf=b"", wait=1000, silent=False):
        return (count, 0, 0.001 * count)

    def getPartNum(self):
        return 0x11

    def getBuildInfo(self):
        return b"FAKE YARDSTICKONE r0000"

    def getDeviceSerialNumber(self):
        return b"fake0001"

    # config
    def getRadioConfig(self):
        # rflib returns the raw register bytes and refreshes .radiocfg
        return b""

    def setFreq(self, freq, mhz=24, radiocfg=None, applyConfig=True):
        self.freq = float(freq)

    def getFreq(self, mhz=24, radiocfg=None):
        return self.freq, hex(int(self.freq))

    def setMdmModulation(self, mod, radiocfg=None, invert=False):
        self.radiocfg.mdmcfg2 = (self.radiocfg.mdmcfg2 & ~0x70) | mod

    def getMdmModulation(self, radiocfg=None):
        return self.radiocfg.mdmcfg2 & 0x70

    def setMdmDRate(self, drate, mhz=24, radiocfg=None):
        self.drate = float(drate)

    def getMdmDRate(self, mhz=24, radiocfg=None):
        return self.drate

    def setMdmDeviatn(self, deviatn, mhz=24, radiocfg=None):
        self.deviation = float(deviatn)

    def getMdmDeviatn(self, mhz=24, radiocfg=None):
        return self.deviation

    def setMdmChanBW(self, bw, mhz=24, radiocfg=None):
        self.chanbw = float(bw)

    def getMdmChanBW(self, mhz=24, radiocfg=None):
        return self.chanbw

    def setMdmChanSpc(self, chanspc=None, chanspc_m=None, chanspc_e=None, mhz=24, radiocfg=None):
        self.chanspc = float(chanspc)

    def getMdmChanSpc(self, mhz=24, radiocfg=None):
        return self.chanspc

    def setMdmSyncWord(self, word, radiocfg=None):
        self.radiocfg.sync1, self.radiocfg.sync0 = (word >> 8) & 0xFF, word & 0xFF

    def getMdmSyncWord(self, radiocfg=None):
        return (self.radiocfg.sync1 << 8) | self.radiocfg.sync0

    def setMdmSyncMode(self, syncmode=1, radiocfg=None):
        self.radiocfg.mdmcfg2 = (self.radiocfg.mdmcfg2 & ~0x07) | syncmode

    def getMdmSyncMode(self, radiocfg=None):
        return self.radiocfg.mdmcfg2 & 0x07

    def makePktFLEN(self, flen=255, radiocfg=None):
        self.radiocfg.pktctrl0 &= ~0x03
        self.radiocfg.pktlen = flen

    def makePktVLEN(self, maxlen=255, radiocfg=None):
        self.radiocfg.pktctrl0 = (self.radiocfg.pktctrl0 & ~0x03) | 1
        self.radiocfg.pktlen = maxlen

    def getPktLEN(self):
        return (self.radiocfg.pktlen, self.radiocfg.pktctrl0 & 0x03)

    def setEnablePktCRC(self, enable=True, radiocfg=None):
        self.crc = bool(enable)

    def getEnablePktCRC(self, radiocfg=None):
        return self.crc

    def setEnableMdmManchester(self, enable=True, radiocfg=None):
        self.manchester = bool(enable)

    def getEnableMdmManchester(self, radiocfg=None):
        return self.manchester

    def setMdmNumPreamble(self, preamble=0x20, radiocfg=None):
        self.radiocfg.mdmcfg1 = (self.radiocfg.mdmcfg1 & ~0x70) | preamble

    def getMdmNumPreamble(self, radiocfg=None):
        return self.radiocfg.mdmcfg1 & 0x70

    def setPower(self, power=None, radiocfg=None, invert=False):
        if power is not None:
            self.radiocfg.pa_table0 = power

    def setMaxPower(self, radiocfg=None, invert=False):
        self.setPower(0xC2 if self.freq <= 400e6 or 464e6 < self.freq <= 900e6 else 0xC0)

    # modes
    def setModeIDLE(self):
        self.mode = "IDLE"

    def setModeRX(self):
        self.mode = "RX"

    def getRSSI(self):
        return b"\xa0"

    # data
    def RFxmit(self, data, repeat=0, offset=0):
        with self._lock:
            self.sent.append(bytes(data))
            self.air.append(bytes(data))

    def RFrecv(self, timeout=1000, blocksize=None):
        if self.mode != "RX":
            raise FakeTimeout("radio is not in RX")
        deadline = time.time() + timeout / 1000.0
        while True:
            with self._lock:
                if self.air:
                    return self.air.pop(0), time.time()
            if time.time() >= deadline:
                raise FakeTimeout("Timeout waiting for USB response.")
            time.sleep(0.005)

    # spectrum analyzer
    def _doSpecAn(self, centfreq, inc, count):
        base = centfreq - count * inc / 2.0
        self.specan = (base, inc, int(count))
        return base, inc

    def _stopSpecAn(self):
        self.specan = None

    def recv(self, app, cmd=None, wait=1000):
        if app != APP_SPECAN or not self.specan:
            raise FakeTimeout("nothing queued")
        time.sleep(0.02)
        count = self.specan[2]
        # noise floor at -85 dBm, a carrier in the middle at -40 dBm
        frame = bytes(specan_byte(-40 if i == count // 2 else -85) for i in range(count))
        return frame, time.time()


# ---- dongle access -------------------------------------------------------------


def open_dongle(index, serial):
    """rflib.RfCat for dongle `index` (or the one with `serial`), or the fake.
    Returns (dongle, timeout exception types)."""
    if os.environ.get("MAILAB_RFCAT_FAKE") == "1":
        lab.log("MAILAB_RFCAT_FAKE=1: using the fake dongle (no radio)", "warn")
        return FakeRfCat(index), (FakeTimeout,)
    import rflib
    from rflib import chipcon_usb

    try:
        devices = chipcon_usb.getRfCatDevices()
    except SystemExit:
        # rflib exits when a dongle sits in its bootloader
        raise RuntimeError("an RfCat dongle is in bootloader mode: flash / replug it first")
    if not devices:
        raise RuntimeError("no RfCat dongle found (YARD Stick One 1d50:605b, 1d50:6047/6048/ecc1, 0451:4715); "
                           "check USB and udev permissions")
    # rflib orders dongles by USB device number
    devices = sorted(devices, key=lambda d: d.devnum)
    idx = index
    if serial:
        # TODO(hardware-untested): legacy pyusb handle.getString for iSerialNumber
        serials = []
        for d in devices:
            try:
                serials.append(d.open().getString(d.iSerialNumber, 64))
            except Exception as err:  # unreadable serial (permissions)
                serials.append("?(%s)" % err)
        serials = [s.decode("utf8", "replace") if isinstance(s, bytes) else str(s) for s in serials]
        if serial not in serials:
            raise RuntimeError("no RfCat with serial %r (found %s)" % (serial, ", ".join(serials)))
        idx = serials.index(serial)
    if idx >= len(devices):
        raise RuntimeError("dongle index %d, but only %d RfCat dongle(s) found" % (idx, len(devices)))

    # RfCat() loops forever on failure (resetup): bound it
    box = {}

    def construct():
        try:
            box["d"] = rflib.RfCat(idx=idx)
        except Exception as err:
            box["err"] = err

    worker = threading.Thread(target=construct, daemon=True)
    worker.start()
    worker.join(OPEN_TIMEOUT_S)
    if "err" in box:
        raise box["err"]
    if "d" not in box:
        raise RuntimeError("RfCat dongle %d did not answer within %d s (busy in another program? permissions?)"
                           % (idx, OPEN_TIMEOUT_S))
    return box["d"], (chipcon_usb.ChipconUsbTimeoutException,)


# ---- device ----------------------------------------------------------------------

CONFIG_KEYS = ["freq", "modulation", "drate", "deviation", "chanbw", "syncWord", "syncMode",
               "pktLen", "variable", "crc", "manchester", "preamble"]


class RfcatDevice:
    def __init__(self, dongle, timeouts, bands, region):
        self.d = dongle
        self.timeouts = timeouts
        self.bands = bands
        self.region = region
        self.captured = []
        self.next_n = 1
        self.listening = False
        self.specan = None
        self.startup = {}
        self._last_publish = 0
        self._last_rssi = 0
        self._dirty = False

    # -- config --

    def apply(self, cfg):
        """Apply the given radio settings (CONFIG_KEYS), frequency first."""
        d = self.d
        applied = {}
        if cfg.get("freq") is not None:
            freq = check_tune(parse_freq(cfg["freq"]))
            d.setFreq(freq)
            applied["freq"] = freq
        if cfg.get("modulation") is not None:
            name = parse_modulation(cfg["modulation"])
            d.setMdmModulation(MODULATIONS[name])
            applied["modulation"] = name
        if cfg.get("drate") is not None:
            d.setMdmDRate(parse_number(cfg["drate"], "drate", 600, 500000))
            applied["drate"] = cfg["drate"]
        if cfg.get("deviation") is not None:
            d.setMdmDeviatn(parse_number(cfg["deviation"], "deviation", 1500, 381000))
            applied["deviation"] = cfg["deviation"]
        if cfg.get("chanbw") is not None:
            d.setMdmChanBW(parse_number(cfg["chanbw"], "chanbw", 50000, 850000))
            applied["chanbw"] = cfg["chanbw"]
        if cfg.get("syncWord") is not None:
            d.setMdmSyncWord(parse_sync_word(cfg["syncWord"]))
            applied["syncWord"] = cfg["syncWord"]
        if cfg.get("syncMode") is not None:
            d.setMdmSyncMode(parse_sync_mode(cfg["syncMode"]))
            applied["syncMode"] = cfg["syncMode"]
        if cfg.get("pktLen") is not None or cfg.get("variable") is not None:
            if cfg.get("pktLen") is not None:
                length = parse_number(cfg["pktLen"], "pktLen", 1, 255, integer=True)
            else:
                d.getRadioConfig()
                length = d.getPktLEN()[0]
            variable = lab.parse_switch(cfg["variable"], "variable") if cfg.get("variable") is not None else False
            if variable:
                d.makePktVLEN(length)
            else:
                d.makePktFLEN(length)
            applied["pktLen"] = length
            applied["variable"] = variable
        if cfg.get("crc") is not None:
            applied["crc"] = lab.parse_switch(cfg["crc"], "crc")
            d.setEnablePktCRC(applied["crc"])
        if cfg.get("manchester") is not None:
            applied["manchester"] = lab.parse_switch(cfg["manchester"], "manchester")
            d.setEnableMdmManchester(applied["manchester"])
        if cfg.get("preamble") is not None:
            d.setMdmNumPreamble(preamble_flag(cfg["preamble"]))
            applied["preamble"] = cfg["preamble"]
        return applied

    def modulation_name(self):
        mod = self.d.getMdmModulation()
        for name, value in MODULATIONS.items():
            if value == mod:
                return name
        return mod

    def effective(self):
        """Radio settings as rflib reads them back, plus raw registers."""
        d = self.d
        d.getRadioConfig()
        radiocfg = d.radiocfg
        pktlen, lenmode = d.getPktLEN()
        sync_mode = d.getMdmSyncMode()
        registers = {}
        for reg in REGISTERS:
            value = getattr(radiocfg, reg, None)
            if isinstance(value, int):
                registers[reg] = "0x%02x" % value
        return {
            "freq": d.getFreq()[0],
            "modulation": self.modulation_name(),
            "drate": d.getMdmDRate(),
            "deviation": d.getMdmDeviatn(),
            "chanbw": d.getMdmChanBW(),
            "syncWord": "0x%04x" % d.getMdmSyncWord(),
            "syncMode": next((k for k, v in SYNC_MODES.items() if v == sync_mode), sync_mode),
            "pktLen": pktlen,
            "variable": lenmode == 1,
            "crc": bool(d.getEnablePktCRC()),
            "manchester": bool(d.getEnableMdmManchester()),
            "preamble": preamble_bytes(d.getMdmNumPreamble()),
            "region": self.region,
            "txBands": format_bands(self.bands),
            "registers": registers,
        }

    # -- state guards --

    def no_specan(self):
        if self.specan:
            raise RuntimeError("the spectrum analyzer is running: specan_stop (or idle) first")

    def stop_modes(self):
        self.listening = False
        if self.specan:
            self.specan = None
            self.d._stopSpecAn()

    # -- packets --

    def recv(self, timeout_ms):
        try:
            data, ts = self.d.RFrecv(timeout=int(timeout_ms))
        except self.timeouts:
            return None
        rssi = None
        try:
            # rflib has no per-packet RSSI unless APPEND_STATUS is on: read the register right after
            rssi = rssi_dbm(self.d.getRSSI())
        except Exception:
            pass
        row = format_packet(self.next_n, data, round(ts * 1000, 3), rssi)
        self.next_n += 1
        self.captured.append((row, bytes(data)))
        del self.captured[:-CAPTURE_KEEP]
        self._dirty = True
        lab.event("packet", {k: row[k] for k in ("n", "t", "len", "hex", "rssi")})
        if rssi is not None:
            lab.sample("rssi", rssi, "dBm")
        return row

    def publish(self):
        """value table + blob "packets": the kept packets, offsets into the blob"""
        rows = []
        blob = bytearray()
        for row, data in self.captured:
            rows.append(dict(row, offset=len(blob)))
            blob += data
        lab.value("packets", rows)
        lab.blob("packets", bytes(blob))
        self._dirty = False

    def packet_bytes(self, n):
        for row, data in self.captured:
            if row["n"] == n:
                return data
        raise ValueError("no captured packet %d (kept: %s)" % (
            n, ", ".join(str(r["n"]) for r, _d in self.captured[-20:]) or "none"))

    # -- tx --

    def transmit(self, payload, args):
        self.no_specan()
        repeat, delay = tx_plan(args)
        freq = self.d.getFreq()[0]
        half = occupied_half_bw(self.modulation_name(), self.d.getMdmDRate(), self.d.getMdmDeviatn())
        check_tx(freq, half, self.bands)
        for i in range(repeat):
            if i and delay:
                time.sleep(delay / 1000.0)
            self.d.RFxmit(payload)
        lab.event("tx", {"freq": freq, "len": len(payload), "hex": payload[:64].hex(), "repeat": repeat})
        lab.log("TX %d bytes x%d at %.6f MHz" % (len(payload), repeat, freq / 1e6), "tx")
        return {"freq": freq, "bytes": len(payload), "repeat": repeat, "delayMs": delay, "hex": payload.hex()}

    # -- periodic --

    def poll(self):
        if self.listening:
            self.recv(LISTEN_POLL_MS)
            now = time.monotonic()
            if self._dirty and now - self._last_publish >= LISTEN_PUBLISH_S:
                self._last_publish = now
                self.publish()
            if now - self._last_rssi >= LISTEN_RSSI_S:
                self._last_rssi = now
                lab.sample("rssi", rssi_dbm(self.d.getRSSI()), "dBm")
        elif self.specan:
            self.specan_frame()

    def specan_frame(self):
        sp = self.specan
        try:
            frame, _ts = self.d.recv(APP_SPECAN, SPECAN_QUEUE, SPECAN_POLL_MS)
        except self.timeouts:
            return None
        dbm = specan_dbm(frame)
        sp["frames"] += 1
        sp["last"] = dbm
        now = time.monotonic()
        if now - sp["published"] >= 1.0 / sp["rate"]:
            sp["published"] = now
            x = [sp["base"] + i * sp["inc"] for i in range(len(dbm))]
            lab.trace("spectrum", x, [{"label": "dBm", "y": dbm}], "Hz", "dBm")
        return dbm


# ---- bridge ----------------------------------------------------------------------


def build(dev, opts):
    bridge = lab.Bridge()
    d = dev.d

    @bridge.command("info", "firmware build, part number, serial, frequency, TX bands")
    def info(_args):
        part = d.getPartNum()
        build_info = d.getBuildInfo()
        serial = d.getDeviceSerialNumber()
        return {
            "part": part, "chip": PART_NAMES.get(part, "unknown"),
            "build": build_info.decode("utf8", "replace").strip("\x00 ") if isinstance(build_info, bytes) else build_info,
            "serial": serial.hex() if isinstance(serial, bytes) else serial,
            "freq": d.getFreq()[0], "region": dev.region, "txBands": format_bands(dev.bands),
            "fake": isinstance(d, FakeRfCat),
        }

    @bridge.command("ping", "{count} USB round trips to the dongle firmware")
    def ping(args):
        count = parse_number(args.get("count", 3), "count", 1, 100, integer=True)
        good, bad, seconds = d.ping(count, silent=True)
        return {"good": good, "bad": bad, "seconds": seconds}

    @bridge.command("config", "{freq, modulation: 2FSK|GFSK|ASK_OOK|MSK, drate, deviation, chanbw, syncWord, "
                    "syncMode: none|15/16|16/16|30/32|carrier..., pktLen, variable, crc, manchester, preamble (bytes)} "
                    "apply (any subset) and read back the effective settings + registers; changes persist")
    def config(args):
        dev.no_specan()
        unknown = [k for k in args if k not in CONFIG_KEYS and k != "timeoutMs"]
        if unknown:
            raise ValueError("unknown config keys %s (TX power: the power command)" % ", ".join(unknown))
        applied = dev.apply(args)
        if applied:
            lab.emit({"type": "options", "options": applied})
        return dict(dev.effective(), applied=applied)

    @bridge.command("rx", "{timeoutMs (window, default 2000), count (default 10)} receive packets -> table + blob \"packets\", events")
    def rx(args):
        dev.no_specan()
        window = parse_number(args.get("windowMs", args.get("timeoutMs", 2000)), "timeoutMs", 1, MAX_RX_MS)
        count = parse_number(args.get("count", 10), "count", 1, MAX_RX_COUNT, integer=True)
        if not dev.listening:
            d.setModeRX()
        deadline = time.monotonic() + window / 1000.0
        got = []
        while len(got) < count:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            row = dev.recv(max(1, min(left * 1000, 1000)))
            if row:
                got.append(row)
        dev.publish()
        return {"count": len(got), "packets": got, "table": "packets", "blob": "packets"}

    @bridge.command("listen", "{on} continuous RX: packets -> events + table, rssi channel")
    def listen(args):
        on = lab.parse_switch(args.get("on"), "on")
        if on:
            dev.no_specan()
            d.setModeRX()
        dev.listening = on
        if not on and dev._dirty:
            dev.publish()
        return {"listening": on, "captured": len(dev.captured)}

    @bridge.command("tx", "{hex | text | data (base64) | blob, repeat (1), delayMs (0)} transmit (needs approval; allowed bands only)")
    def tx(args):
        return dev.transmit(parse_payload(args), args)

    @bridge.command("replay", "{index (packet n) | data/blob [, offset, length], repeat, delayMs} retransmit a capture (needs approval)")
    def replay(args):
        if args.get("index") is not None:
            payload = dev.packet_bytes(parse_number(args["index"], "index", 1, integer=True))
        else:
            payload = parse_payload({"data": args.get("data"), "hex": args.get("hex")})
            if args.get("offset") is not None or args.get("length") is not None:
                start = parse_number(args.get("offset", 0), "offset", 0, len(payload) - 1, integer=True)
                length = parse_number(args.get("length", len(payload) - start), "length", 1, len(payload) - start, integer=True)
                payload = payload[start:start + length]
        return dev.transmit(payload, args)

    @bridge.command("power", "{value: PA_TABLE byte 0-255 | max: true} TX power (needs approval)")
    def power(args):
        dev.no_specan()
        if args.get("max") is not None and lab.parse_switch(args["max"], "max"):
            d.setMaxPower()
        elif args.get("value") is not None:
            d.setPower(parse_number(args["value"], "value", 0, 255, integer=True))
        else:
            raise ValueError("give value (PA_TABLE byte) or max: true")
        d.getRadioConfig()
        cfg = d.radiocfg
        return {"pa_table0": getattr(cfg, "pa_table0", None), "pa_table1": getattr(cfg, "pa_table1", None)}

    @bridge.command("specan", "{center (Hz), span (Hz) or inc, count (<=255, default 100), rate (traces/s, default 5), "
                    "seconds (one-shot; omit = until specan_stop)} sweep -> trace \"spectrum\" (dBm)")
    def specan(args):
        if dev.specan:
            raise RuntimeError("specan already running: specan_stop first")
        center = parse_freq(args.get("center", d.getFreq()[0]))
        count = parse_number(args.get("count", 100), "count", 2, 255, integer=True)
        if args.get("inc") is not None:
            inc = parse_number(args["inc"], "inc", 1000, 1e6)
        else:
            inc = parse_number(args.get("span", 25e6), "span", 2000, 255e6) / count
        rate = parse_number(args.get("rate", 5), "rate", 0.1, 50)
        base = center - count * inc / 2.0
        check_tune(base)
        if base + count * inc > SPECAN_MAX_FREQ:
            raise ValueError("sweep ends above %.0f MHz" % (SPECAN_MAX_FREQ / 1e6))
        dev.listening = False
        freq, delta = d._doSpecAn(center, inc, count)
        dev.specan = {"base": freq, "inc": delta, "count": count, "rate": rate, "frames": 0, "last": None, "published": 0}
        result = {"base": freq, "inc": delta, "count": count, "trace": "spectrum"}
        if args.get("seconds") is None:
            return dict(result, running=True)
        seconds = parse_number(args["seconds"], "seconds", 0.05, 600)
        deadline = time.monotonic() + seconds
        try:
            while time.monotonic() < deadline:
                dev.specan_frame()
        finally:
            sp = dev.specan
            dev.stop_modes()
        if sp["last"]:
            x = [sp["base"] + i * sp["inc"] for i in range(len(sp["last"]))]
            lab.trace("spectrum", x, [{"label": "dBm", "y": sp["last"]}], "Hz", "dBm")
            peak = max(range(len(sp["last"])), key=lambda i: sp["last"][i])
            result.update(peakFreq=x[peak], peakDbm=sp["last"][peak])
        return dict(result, frames=sp["frames"], running=False)

    @bridge.command("specan_stop", "stop the spectrum analyzer (radio config restored)")
    def specan_stop(_args):
        running = bool(dev.specan)
        dev.stop_modes()
        return {"stopped": running}

    @bridge.command("rssi", "current RSSI (dBm, approximate) -> channel rssi")
    def rssi(_args):
        dev.no_specan()
        raw = d.getRSSI()
        value = rssi_dbm(raw)
        lab.sample("rssi", value, "dBm")
        return {"dbm": value, "raw": raw[0] if isinstance(raw, (bytes, bytearray)) and raw else raw}

    @bridge.command("idle", "stop listen / specan, radio to IDLE")
    def idle(_args):
        dev.stop_modes()
        d.setModeIDLE()
        return {"mode": "idle"}

    @bridge.command("reset", "stop listen / specan, re-apply the device options' radio settings, back to RX")
    def reset(_args):
        dev.stop_modes()
        d.setModeIDLE()
        dev.apply(dev.startup)
        d.setModeRX()
        return dev.effective()

    @bridge.command("packets", "{last} captured packets (n for replay)")
    def packets(args):
        last = parse_number(args.get("last", 50), "last", 1, CAPTURE_KEEP, integer=True)
        return [row for row, _d in dev.captured[-last:]]

    bridge.every(0, dev.poll)
    return bridge


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", type=int, default=0, help="dongle index (rflib order)")
    parser.add_argument("--serial", default=None, help="USB serial (several dongles)")
    parser.add_argument("--region", default="eu", help="TX allow-list region: %s" % ", ".join(sorted(REGIONS)))
    parser.add_argument("--tx-bands", default=None, help="narrower allow-list: lo-hi,lo-hi (Hz, k/M suffixes)")
    for key in CONFIG_KEYS:
        flag = "--" + "".join("-" + c.lower() if c.isupper() else c for c in key)
        parser.add_argument(flag, dest=key, default=None)
    opts = parser.parse_args()

    bands = allowed_bands(opts.region, opts.tx_bands)
    dongle, timeouts = open_dongle(opts.index, opts.serial)
    dev = RfcatDevice(dongle, timeouts, bands, str(opts.region).lower())
    dev.startup = {k: getattr(opts, k) for k in CONFIG_KEYS if getattr(opts, k) is not None}
    dev.apply(dev.startup)
    lab.log("RfCat ready: %.6f MHz, TX bands (%s): %s" % (dongle.getFreq()[0] / 1e6, dev.region, format_bands(bands) or "none"))
    lab.status("running")
    bridge = build(dev, opts)
    try:
        bridge.run()
    finally:
        try:
            dev.stop_modes()
            dongle.setModeIDLE()
        except Exception:
            pass


if __name__ == "__main__":
    main()
