"""USB 2.0 packet-level decoding for the Cynthion analyzer (pure python, stdlib only).

Layers, each usable on its own:
  - packets:      PID check, token fields + CRC5, data payload + CRC16, SPLIT
  - stream:       the Cynthion analyzer gateware's bulk stream (packet headers,
                  events, 60 MHz cycle-delta timestamps) -> timed packets
  - transactions: token [+ data] [+ handshake]
  - transfers:    control transfers (SETUP / data / status, toggle de-dup) and
                  bulk/interrupt data, with descriptors decoded per address
                  (SET_ADDRESS follows the device from address 0)
  - pcap:         LINKTYPE_USB_2_0 (288) read/write; these files open in Packetry
  - synth:        packet builders and a synthetic enumeration, used by the
                  tests and the bridge's fake device

Stream format (cynthion 0.2.5 gateware/analyzer/analyzer.py, big-endian):
  packet: u16 length, u16 cycles since previous record, <length> bytes, pad to even
  event:  0xFF, u8 code, u16 cycles since previous record
"""

import struct

CLOCK_HZ = 60_000_000
LINKTYPE_USB_2_0 = 288

# 4-bit PID codes; the wire byte is code | (~code << 4)
PID_CODES = {
    "OUT": 0x1, "IN": 0x9, "SOF": 0x5, "SETUP": 0xD,
    "DATA0": 0x3, "DATA1": 0xB, "DATA2": 0x7, "MDATA": 0xF,
    "ACK": 0x2, "NAK": 0xA, "STALL": 0xE, "NYET": 0x6,
    "PRE": 0xC, "SPLIT": 0x8, "PING": 0x4, "EXT": 0x0,
}
PID_NAMES = {code: name for name, code in PID_CODES.items()}
TOKENS = ("OUT", "IN", "SETUP", "PING")
DATA = ("DATA0", "DATA1", "DATA2", "MDATA")
HANDSHAKES = ("ACK", "NAK", "STALL", "NYET")

EVENTS = {
    0: "none", 1: "capture_stop", 2: "capture_stop_full", 3: "capture_stop_error",
    4: "capture_start_high", 5: "capture_start_full", 6: "capture_start_low", 7: "capture_start_auto",
    8: "speed_high", 9: "speed_full", 10: "speed_low", 11: "speed_auto",
    12: "linestate_se0", 13: "linestate_chirp_j", 14: "linestate_chirp_k", 15: "linestate_chirp_se1",
    16: "linestate_ls_j", 17: "linestate_ls_k", 18: "linestate_fs_j", 19: "linestate_fs_k",
    20: "linestate_se1", 21: "vbus_invalid", 22: "vbus_valid", 23: "ls_attach", 24: "fs_attach",
    25: "bus_reset", 26: "device_chirp_valid", 27: "host_chirp_valid", 28: "suspend",
    29: "resume", 30: "ls_keepalive",
}
EVENT_CODES = {name: code for code, name in EVENTS.items()}

# analyzer state register speed field (gateware/analyzer/speeds.py)
SPEED_BITS = {"high": 0b00, "full": 0b01, "low": 0b10, "auto": 0b11}
# GET_SPEEDS bit flags
SPEED_FLAGS = {"auto": 0b0001, "low": 0b0010, "full": 0b0100, "high": 0b1000}

REQUESTS = {
    0: "GET_STATUS", 1: "CLEAR_FEATURE", 3: "SET_FEATURE", 5: "SET_ADDRESS",
    6: "GET_DESCRIPTOR", 7: "SET_DESCRIPTOR", 8: "GET_CONFIGURATION",
    9: "SET_CONFIGURATION", 10: "GET_INTERFACE", 11: "SET_INTERFACE", 12: "SYNCH_FRAME",
}
DESCRIPTOR_TYPES = {
    1: "DEVICE", 2: "CONFIGURATION", 3: "STRING", 4: "INTERFACE", 5: "ENDPOINT",
    6: "DEVICE_QUALIFIER", 7: "OTHER_SPEED_CONFIGURATION", 8: "INTERFACE_POWER",
    11: "INTERFACE_ASSOCIATION", 15: "BOS", 16: "DEVICE_CAPABILITY",
    0x21: "HID", 0x22: "HID_REPORT", 0x24: "CS_INTERFACE", 0x25: "CS_ENDPOINT",
}
CLASSES = {
    0x00: "per-interface", 0x01: "audio", 0x02: "CDC", 0x03: "HID", 0x05: "physical",
    0x06: "image", 0x07: "printer", 0x08: "mass storage", 0x09: "hub", 0x0A: "CDC data",
    0x0B: "smart card", 0x0D: "content security", 0x0E: "video", 0x0F: "healthcare",
    0x10: "audio/video", 0xDC: "diagnostic", 0xE0: "wireless", 0xEF: "misc",
    0xFE: "application specific", 0xFF: "vendor specific",
}
TRANSFER_TYPES = ("control", "isochronous", "bulk", "interrupt")
MAX_DATA_HEX = 256


# ---- CRCs -------------------------------------------------------------------

def crc5(value, nbits=11):
    """USB token CRC5 (poly x^5+x^2+1) over `nbits` bits, LSB first."""
    crc = 0x1F
    for i in range(nbits):
        if (crc ^ (value >> i)) & 1:
            crc = (crc >> 1) ^ 0x14
        else:
            crc >>= 1
    return crc ^ 0x1F


def crc16(data):
    """USB data CRC16 (poly 0x8005, reflected), sent little-endian after the payload."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc ^ 0xFFFF


# ---- packets ----------------------------------------------------------------

def pid_byte(name):
    code = PID_CODES[name]
    return code | ((~code & 0xF) << 4)


def decode_packet(data, t=0):
    """One packet (PID .. CRC) -> dict; `errors` lists what doesn't check out."""
    raw = bytes(data)
    pkt = {"t": t, "len": len(raw), "pid": None, "name": "?", "errors": []}
    if not raw:
        pkt["errors"].append("empty packet")
        return pkt
    pid = raw[0]
    pkt["pid"] = pid
    if (pid & 0x0F) != ((~pid >> 4) & 0x0F):
        pkt["errors"].append("PID check failed (0x%02x)" % pid)
        return pkt
    name = PID_NAMES[pid & 0x0F]
    pkt["name"] = name
    if name in TOKENS or name in ("SOF", "EXT"):
        if len(raw) != 3:
            pkt["errors"].append("token length %d, expected 3" % len(raw))
            return pkt
        field = raw[1] | (raw[2] << 8)
        if name == "SOF":
            pkt["frame"] = field & 0x7FF
        else:
            pkt["addr"] = field & 0x7F
            pkt["ep"] = (field >> 7) & 0x0F
        pkt["crc"] = field >> 11
        if crc5(field & 0x7FF) != pkt["crc"]:
            pkt["errors"].append("CRC5 mismatch")
    elif name == "SPLIT":
        if len(raw) != 4:
            pkt["errors"].append("SPLIT length %d, expected 4" % len(raw))
            return pkt
        field = raw[1] | (raw[2] << 8) | (raw[3] << 16)
        pkt["hub"] = field & 0x7F
        pkt["complete"] = bool((field >> 7) & 1)
        pkt["port"] = (field >> 8) & 0x7F
        pkt["endpointType"] = TRANSFER_TYPES[(field >> 17) & 0x3]
        pkt["crc"] = field >> 19
        if crc5(field & 0x7FFFF, 19) != pkt["crc"]:
            pkt["errors"].append("CRC5 mismatch")
    elif name in DATA:
        if len(raw) < 3:
            pkt["errors"].append("data packet too short")
            return pkt
        pkt["data"] = raw[1:-2]
        pkt["crc"] = raw[-2] | (raw[-1] << 8)
        if crc16(pkt["data"]) != pkt["crc"]:
            pkt["errors"].append("CRC16 mismatch")
    elif len(raw) != 1:
        pkt["errors"].append("handshake length %d, expected 1" % len(raw))
    return pkt


def describe_packet(pkt):
    name = pkt["name"]
    if "addr" in pkt:
        text = "%s %d.%d" % (name, pkt["addr"], pkt["ep"])
    elif "frame" in pkt:
        text = "SOF %d" % pkt["frame"]
    elif "data" in pkt:
        text = "%s %d bytes" % (name, len(pkt["data"]))
    else:
        text = name
    if pkt["errors"]:
        text += " [" + ", ".join(pkt["errors"]) + "]"
    return text


# ---- builders (synthetic traffic) -------------------------------------------

def token(name, addr, ep):
    field = (addr & 0x7F) | ((ep & 0xF) << 7)
    field |= crc5(field) << 11
    return bytes([pid_byte(name), field & 0xFF, field >> 8])


def sof(frame):
    field = frame & 0x7FF
    field |= crc5(field) << 11
    return bytes([pid_byte("SOF"), field & 0xFF, field >> 8])


def data_packet(name, payload):
    payload = bytes(payload)
    crc = crc16(payload)
    return bytes([pid_byte(name)]) + payload + bytes([crc & 0xFF, crc >> 8])


def handshake(name):
    return bytes([pid_byte(name)])


def setup_bytes(bm_request_type, request, value=0, index=0, length=0):
    return struct.pack("<BBHHH", bm_request_type, request, value, index, length)


def control_read(addr, setup, response, mps=64, naks=0):
    """Packets of a control IN transfer (GET_DESCRIPTOR & co)."""
    pkts = [token("SETUP", addr, 0), data_packet("DATA0", setup), handshake("ACK")]
    wlength = struct.unpack_from("<H", setup, 6)[0]
    body = bytes(response)[:wlength]
    toggle = 1
    chunks = [body[i:i + mps] for i in range(0, len(body), mps)] or [b""]
    if len(body) and len(body) % mps == 0 and len(body) < wlength:
        chunks.append(b"")  # short (zero-length) packet ends the data stage
    for chunk in chunks:
        for _ in range(naks):
            pkts += [token("IN", addr, 0), handshake("NAK")]
        pkts += [token("IN", addr, 0), data_packet("DATA%d" % toggle, chunk), handshake("ACK")]
        toggle ^= 1
    pkts += [token("OUT", addr, 0), data_packet("DATA1", b""), handshake("ACK")]
    return pkts


def control_nodata(addr, setup):
    """Packets of a control transfer without a data stage (SET_ADDRESS & co)."""
    return [token("SETUP", addr, 0), data_packet("DATA0", setup), handshake("ACK"),
            token("IN", addr, 0), data_packet("DATA1", b""), handshake("ACK")]


def string_descriptor(text):
    raw = text.encode("utf-16-le")
    return bytes([2 + len(raw), 3]) + raw


def keyboard_descriptors(vid=0x1209, pid=0x0001, strings=("Mailab", "Fake Keyboard", "0001")):
    device = struct.pack("<BBHBBBBHHHBBBB", 18, 1, 0x0200, 0, 0, 0, 64, vid, pid, 0x0100, 1, 2, 3, 1)
    interface = struct.pack("<BBBBBBBBB", 9, 4, 0, 0, 1, 3, 1, 1, 0)
    hid = struct.pack("<BBHBBBH", 9, 0x21, 0x0111, 0, 1, 0x22, 63)
    endpoint = struct.pack("<BBBBHB", 7, 5, 0x81, 3, 8, 10)
    body = interface + hid + endpoint
    config = struct.pack("<BBHBBBBB", 9, 2, 9 + len(body), 1, 1, 0, 0xA0, 50) + body
    return device, config, [string_descriptor(s) for s in strings]


def synthetic_enumeration(addr=5, vid=0x1209, pid=0x0001, strings=("Mailab", "Fake Keyboard", "0001"), reports=3):
    """Packets of a full-speed device enumerating then sending HID reports."""
    device, config, strs = keyboard_descriptors(vid, pid, strings)
    pkts = [sof(100)]
    pkts += control_read(0, setup_bytes(0x80, 6, 0x0100, 0, 64), device, naks=1)
    pkts += control_nodata(0, setup_bytes(0x00, 5, addr))
    pkts += [sof(101)]
    pkts += control_read(addr, setup_bytes(0x80, 6, 0x0100, 0, 18), device)
    pkts += control_read(addr, setup_bytes(0x80, 6, 0x0200, 0, 9), config)
    pkts += control_read(addr, setup_bytes(0x80, 6, 0x0200, 0, 255), config)
    pkts += control_read(addr, setup_bytes(0x80, 6, 0x0300, 0, 255), bytes([4, 3, 0x09, 0x04]))
    for i, s in enumerate(strs):
        pkts += control_read(addr, setup_bytes(0x80, 6, 0x0300 | (i + 1), 0x0409, 255), s)
    pkts += control_nodata(addr, setup_bytes(0x00, 9, 1))
    pkts += [sof(102)]
    toggle = 0
    for i in range(reports):
        pkts += [token("IN", addr, 1), handshake("NAK")]
        pkts += [token("IN", addr, 1), data_packet("DATA%d" % toggle, bytes([0, 0, 4 + i, 0, 0, 0, 0, 0])), handshake("ACK")]
        toggle ^= 1
    return pkts


def encode_stream(records):
    """[(cycles_delta, bytes) | (cycles_delta, "event_name")] -> analyzer stream bytes."""
    out = bytearray()
    for delta, item in records:
        if isinstance(item, str):
            out += bytes([0xFF, EVENT_CODES[item]]) + struct.pack(">H", delta)
        else:
            out += struct.pack(">HH", len(item), delta) + bytes(item)
            if len(item) & 1:
                out.append(0)
    return bytes(out)


# ---- analyzer stream ----------------------------------------------------------

class StreamParser:
    """Incremental parser for the analyzer's bulk stream; chunks may split records."""

    def __init__(self):
        self._buf = bytearray()
        self.cycles = 0

    @property
    def t_ns(self):
        return self.cycles * 1_000_000_000 // CLOCK_HZ

    def feed(self, chunk):
        self._buf += chunk
        records = []
        pos = 0
        buf = self._buf
        while len(buf) - pos >= 4:
            if buf[pos] == 0xFF:
                self.cycles += (buf[pos + 2] << 8) | buf[pos + 3]
                code = buf[pos + 1]
                records.append({"kind": "event", "t": self.t_ns, "code": code,
                                "name": EVENTS.get(code, "event_%d" % code)})
                pos += 4
                continue
            length = (buf[pos] << 8) | buf[pos + 1]
            padded = length + (length & 1)
            if len(buf) - pos < 4 + padded:
                break
            self.cycles += (buf[pos + 2] << 8) | buf[pos + 3]
            records.append({"kind": "packet", "t": self.t_ns, "data": bytes(buf[pos + 4:pos + 4 + length])})
            pos += 4 + padded
        del self._buf[:pos]
        return records


# ---- descriptors --------------------------------------------------------------

def _bcd(value):
    return "%x.%02x" % (value >> 8, value & 0xFF)


def parse_device_descriptor(data):
    names = ["bLength", "bDescriptorType", "bcdUSB", "bDeviceClass", "bDeviceSubClass",
             "bDeviceProtocol", "bMaxPacketSize0", "idVendor", "idProduct", "bcdDevice",
             "iManufacturer", "iProduct", "iSerialNumber", "bNumConfigurations"]
    sizes = [1, 1, 2, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1]
    out = {}
    pos = 0
    for name, size in zip(names, sizes):
        if pos + size > len(data):
            out["partial"] = True
            break
        out[name] = data[pos] if size == 1 else data[pos] | (data[pos + 1] << 8)
        pos += size
    if "idProduct" in out:
        out["id"] = "%04x:%04x" % (out["idVendor"], out["idProduct"])
    if "bcdUSB" in out:
        out["usb"] = _bcd(out["bcdUSB"])
    if "bDeviceClass" in out:
        out["class"] = CLASSES.get(out["bDeviceClass"], "0x%02x" % out["bDeviceClass"])
    return out


def parse_configuration(data):
    """Configuration descriptor with its interfaces, endpoints and class descriptors."""
    config = None
    iface = None
    pos = 0
    while pos + 2 <= len(data):
        length, dtype = data[pos], data[pos + 1]
        if length < 2:
            break
        d = bytes(data[pos:pos + length])
        if dtype == 2 and len(d) >= 9:
            total, nifaces, value, istr, attrs, power = struct.unpack_from("<HBBBBB", d, 2)
            config = {"wTotalLength": total, "bNumInterfaces": nifaces, "bConfigurationValue": value,
                      "iConfiguration": istr, "bmAttributes": attrs, "maxPowerMa": power * 2,
                      "selfPowered": bool(attrs & 0x40), "remoteWakeup": bool(attrs & 0x20),
                      "interfaces": [], "other": []}
            if len(data) < total:
                config["partial"] = True
        elif config is None:
            break
        elif dtype == 4 and len(d) >= 9:
            num, alt, neps, cls, sub, proto, istr = struct.unpack_from("<BBBBBBB", d, 2)
            iface = {"bInterfaceNumber": num, "bAlternateSetting": alt, "bNumEndpoints": neps,
                     "bInterfaceClass": cls, "bInterfaceSubClass": sub, "bInterfaceProtocol": proto,
                     "iInterface": istr, "class": CLASSES.get(cls, "0x%02x" % cls), "endpoints": [], "other": []}
            config["interfaces"].append(iface)
        elif dtype == 5 and len(d) >= 7:
            addr, attrs, mps, interval = struct.unpack_from("<BBHB", d, 2)
            ep = {"bEndpointAddress": addr, "address": "0x%02x" % addr, "number": addr & 0x0F,
                  "direction": "IN" if addr & 0x80 else "OUT", "type": TRANSFER_TYPES[attrs & 3],
                  "wMaxPacketSize": mps & 0x7FF, "transactionsPerMicroframe": ((mps >> 11) & 3) + 1,
                  "bInterval": interval}
            (iface["endpoints"] if iface else config["other"]).append(ep)
        else:
            entry = {"type": DESCRIPTOR_TYPES.get(dtype, "0x%02x" % dtype), "hex": d.hex()}
            if dtype == 0x21 and len(d) >= 9:
                entry["bcdHID"] = _bcd(d[2] | (d[3] << 8))
                entry["reportLength"] = d[7] | (d[8] << 8)
            if dtype == 11 and len(d) >= 8:
                entry["firstInterface"] = d[2]
                entry["interfaceCount"] = d[3]
                entry["class"] = CLASSES.get(d[4], "0x%02x" % d[4])
            (iface["other"] if iface else config["other"]).append(entry)
        pos += length
    return config


def parse_string(data, index):
    if len(data) < 2:
        return None
    body = bytes(data[2:min(len(data), data[0])])
    if index == 0:
        return [struct.unpack_from("<H", body, i)[0] for i in range(0, len(body) - 1, 2)]
    return body.decode("utf-16-le", errors="replace")


def describe_setup(s):
    kind = ("standard", "class", "vendor", "reserved")[(s["bmRequestType"] >> 5) & 3]
    recipient = ("device", "interface", "endpoint", "other")[min(s["bmRequestType"] & 0x1F, 3)]
    if kind == "standard":
        name = REQUESTS.get(s["bRequest"], "REQUEST_%d" % s["bRequest"])
        if s["bRequest"] in (6, 7):
            dtype = s["wValue"] >> 8
            name += " %s #%d" % (DESCRIPTOR_TYPES.get(dtype, "0x%02x" % dtype), s["wValue"] & 0xFF)
        elif s["bRequest"] in (5, 9, 11):
            name += " %d" % s["wValue"]
    else:
        name = "%s request 0x%02x value 0x%04x index 0x%04x" % (kind, s["bRequest"], s["wValue"], s["wIndex"])
    return {"kind": kind, "recipient": recipient, "text": name}


def parse_setup(data):
    bm, req, value, index, length = struct.unpack("<BBHHH", bytes(data[:8]))
    s = {"bmRequestType": bm, "bRequest": req, "wValue": value, "wIndex": index, "wLength": length,
         "direction": "IN" if bm & 0x80 else "OUT"}
    s.update(describe_setup(s))
    return s


# ---- transactions / transfers ----------------------------------------------------

class Decoder:
    """Packets -> transactions -> transfers, plus per-address device descriptors.

    Feed timed packets with `packet(t, data)` (bus events with `event`); read
    `transfers`, `devices`, `stats`. Everything is kept in memory up to
    `max_transactions`/`max_transfers` (older ones roll off; stats keep counting).
    """

    def __init__(self, max_transactions=200_000, max_transfers=50_000):
        self.max_transactions = max_transactions
        self.max_transfers = max_transfers
        self.transactions = []
        self.transfers = []
        self.devices = {}
        self.events = []
        self.stats = {"packets": 0, "bytes": 0, "errors": 0, "sof": 0, "transactions": 0,
                      "transfers": 0, "pids": {}, "naks": {}, "firstFrame": None, "lastFrame": None,
                      "speed": None, "first": None, "last": None}
        self._open = None
        self._split = None
        self._control = {}
        self._toggles = {}
        self._bulk = {}
        self._new_transfers = []

    # -- input --

    def event(self, t, name):
        self.events.append({"t": t, "event": name})
        if name.startswith("speed_") or name.startswith("capture_start_"):
            self.stats["speed"] = name.split("_")[-1]
        if name == "bus_reset":
            self._close()
            self._control = {}
            self._toggles = {}

    def packet(self, t, data):
        pkt = decode_packet(data, t)
        st = self.stats
        st["packets"] += 1
        st["bytes"] += len(data)
        st["pids"][pkt["name"]] = st["pids"].get(pkt["name"], 0) + 1
        if st["first"] is None:
            st["first"] = t
        st["last"] = t
        if pkt["errors"]:
            st["errors"] += 1
        name = pkt["name"]
        if name == "SOF":
            st["sof"] += 1
            if not pkt["errors"]:
                if st["firstFrame"] is None:
                    st["firstFrame"] = pkt["frame"]
                st["lastFrame"] = pkt["frame"]
            self._close()
        elif name == "SPLIT":
            self._close()
            self._split = pkt
        elif name in TOKENS and not pkt["errors"]:
            self._close()
            self._open = {"t": t, "token": name, "addr": pkt["addr"], "ep": pkt["ep"],
                          "data": None, "pid": None, "handshake": None, "errors": []}
            if self._split:
                self._open["split"] = {"hub": self._split["hub"], "port": self._split["port"],
                                       "complete": self._split["complete"]}
                self._split = None
        elif name in DATA:
            if self._open is None or self._open["pid"] is not None:
                self._close()
                self._open = {"t": t, "token": None, "addr": None, "ep": None, "data": None,
                              "pid": None, "handshake": None, "errors": ["data without token"]}
            self._open["pid"] = name
            self._open["data"] = pkt.get("data", b"")
            self._open["errors"] += pkt["errors"]
        elif name in HANDSHAKES:
            if self._open is None:
                self._open = {"t": t, "token": None, "addr": None, "ep": None, "data": None,
                              "pid": None, "handshake": None, "errors": ["handshake without token"]}
            self._open["handshake"] = name
            self._close()
        else:
            self._close()
        return pkt

    def flush(self):
        self._close()
        for key in list(self._bulk):
            self._flush_bulk(key)

    def take_new_transfers(self):
        out = self._new_transfers
        self._new_transfers = []
        return out

    # -- transactions --

    def _close(self):
        txn = self._open
        self._open = None
        if txn is None:
            return
        self.stats["transactions"] += 1
        self.transactions.append(txn)
        if len(self.transactions) > self.max_transactions:
            del self.transactions[:len(self.transactions) - self.max_transactions]
        if txn["handshake"] == "NAK" and txn["addr"] is not None:
            key = "%d.%d" % (txn["addr"], txn["ep"])
            self.stats["naks"][key] = self.stats["naks"].get(key, 0) + 1
        if txn["token"] is None or txn["errors"]:
            return
        if txn["token"] == "SETUP":
            self._setup(txn)
        elif txn["token"] in ("IN", "OUT") and txn["pid"] is not None:
            key = (txn["addr"], txn["ep"])
            if key in self._control:
                self._control_stage(key, txn)
            elif txn["handshake"] in ("ACK", None, "NYET"):
                self._bulk_data(txn)
        elif txn["handshake"] == "STALL" and (txn["addr"], txn["ep"]) in self._control:
            self._finish_control((txn["addr"], txn["ep"]), txn, "STALL")

    # -- control --

    def _setup(self, txn):
        if txn["handshake"] != "ACK" or txn["data"] is None or len(txn["data"]) != 8:
            return
        key = (txn["addr"], txn["ep"])
        setup = parse_setup(txn["data"])
        self._control[key] = {"t": txn["t"], "addr": txn["addr"], "ep": txn["ep"], "setup": setup,
                              "data": bytearray(), "toggle": None}

    def _control_stage(self, key, txn):
        ctl = self._control[key]
        setup = ctl["setup"]
        data_dir = setup["direction"] if setup["wLength"] else None
        if txn["handshake"] == "STALL":
            self._finish_control(key, txn, "STALL")
            return
        if txn["handshake"] not in ("ACK", None):
            return  # NAK/NYET: retried later
        if txn["token"] == data_dir:
            # retransmission after a lost ACK repeats the toggle: drop it
            if ctl["toggle"] == txn["pid"]:
                return
            ctl["toggle"] = txn["pid"]
            ctl["data"] += txn["data"]
            return
        # opposite direction (or no data stage): status stage
        self._finish_control(key, txn, "ACK" if not txn["data"] else "status with data")

    def _finish_control(self, key, txn, status):
        ctl = self._control.pop(key)
        setup = ctl["setup"]
        data = bytes(ctl["data"])
        xfer = {"t": ctl["t"], "addr": ctl["addr"], "ep": ctl["ep"], "type": "control",
                "dir": setup["direction"], "request": setup["text"], "length": len(data),
                "status": status, "setup": setup, "data": data[:MAX_DATA_HEX].hex(),
                "truncated": len(data) > MAX_DATA_HEX}
        if status == "ACK":
            decoded = self._apply_control(ctl["addr"], setup, data)
            if decoded is not None:
                xfer["decoded"] = decoded
        self._add_transfer(xfer)

    def _device(self, addr):
        dev = self.devices.get(addr)
        if dev is None:
            dev = {"address": addr, "device": None, "configurations": {}, "strings": {},
                   "languages": None, "configuration": None, "other": {}}
            self.devices[addr] = dev
        return dev

    def _apply_control(self, addr, setup, data):
        if setup["kind"] != "standard":
            return None
        req = setup["bRequest"]
        if req == 5 and setup["bmRequestType"] == 0x00:
            new = setup["wValue"] & 0x7F
            dev = self.devices.pop(addr, None) or self._device(addr)
            dev["address"] = new
            dev["previousAddress"] = addr
            # a re-enumeration replaces what was known at the new address
            self.devices[new] = dev
            self._summarize(dev)
            return {"address": new}
        if req == 9 and setup["bmRequestType"] == 0x00:
            dev = self._device(addr)
            dev["configuration"] = setup["wValue"] & 0xFF
            return {"configuration": dev["configuration"]}
        if req != 6 or not data:
            return None
        dtype, index = setup["wValue"] >> 8, setup["wValue"] & 0xFF
        dev = self._device(addr)
        if dtype == 1:
            parsed = parse_device_descriptor(data)
            if not parsed.get("partial") or dev["device"] is None or dev["device"].get("partial"):
                dev["device"] = parsed
        elif dtype == 2:
            parsed = parse_configuration(data)
            if parsed is None:
                return None
            old = dev["configurations"].get(index)
            if not parsed.get("partial") or old is None or old.get("partial"):
                dev["configurations"][index] = parsed
        elif dtype == 3:
            parsed = parse_string(data, index)
            if index == 0:
                dev["languages"] = parsed
            else:
                dev["strings"][index] = parsed
        else:
            parsed = {"type": DESCRIPTOR_TYPES.get(dtype, "0x%02x" % dtype), "hex": data.hex()}
            dev["other"]["%s #%d" % (parsed["type"], index)] = parsed
        self._summarize(dev)
        return parsed

    def _summarize(self, dev):
        d = dev["device"] or {}
        strings = dev["strings"]
        parts = [d.get("id", "????:????")]
        for key in ("iManufacturer", "iProduct"):
            if d.get(key) and strings.get(d[key]):
                parts.append(strings[d[key]])
        if d.get("iSerialNumber") and strings.get(d["iSerialNumber"]):
            parts.append("serial " + strings[d["iSerialNumber"]])
        if d.get("usb"):
            parts.append("USB " + d["usb"])
        classes = []
        if d.get("class") and d.get("bDeviceClass"):
            classes.append(d["class"])
        for cfg in dev["configurations"].values():
            for iface in cfg["interfaces"]:
                if iface["class"] not in classes:
                    classes.append(iface["class"])
        if classes:
            parts.append("(" + ", ".join(classes) + ")")
        dev["summary"] = " ".join(parts)

    # -- bulk / interrupt --

    def _max_packet(self, addr, ep, direction):
        dev = self.devices.get(addr)
        if not dev:
            return None
        want = ep | (0x80 if direction == "IN" else 0)
        for cfg in dev["configurations"].values():
            for iface in cfg["interfaces"]:
                for e in iface["endpoints"]:
                    if e["bEndpointAddress"] == want:
                        return e["wMaxPacketSize"], e["type"]
        return None

    def _bulk_data(self, txn):
        key = (txn["addr"], txn["ep"], txn["token"])
        if self._toggles.get(key) == txn["pid"] and txn["pid"] in ("DATA0", "DATA1"):
            return  # retransmission
        self._toggles[key] = txn["pid"]
        known = self._max_packet(txn["addr"], txn["ep"], txn["token"])
        acc = self._bulk.get(key)
        if acc is None:
            acc = {"t": txn["t"], "data": bytearray(), "packets": 0,
                   "type": known[1] if known else "bulk/interrupt"}
            self._bulk[key] = acc
        acc["data"] += txn["data"]
        acc["packets"] += 1
        n = len(txn["data"])
        if known and known[1] in ("interrupt", "isochronous"):
            full = False  # every report / frame is its own transfer
        elif known:
            full = n == known[0]
        else:
            full = n >= 8 and (n & (n - 1)) == 0 and len(acc["data"]) < 65536
        if not full:
            self._flush_bulk(key)

    def _flush_bulk(self, key):
        acc = self._bulk.pop(key, None)
        if acc is None:
            return
        data = bytes(acc["data"])
        self._add_transfer({"t": acc["t"], "addr": key[0], "ep": key[1], "type": acc["type"],
                            "dir": key[2], "request": "%d packet%s" % (acc["packets"], "" if acc["packets"] == 1 else "s"),
                            "length": len(data), "status": "ACK", "data": data[:MAX_DATA_HEX].hex(),
                            "truncated": len(data) > MAX_DATA_HEX})

    def _add_transfer(self, xfer):
        self.stats["transfers"] += 1
        self.transfers.append(xfer)
        self._new_transfers.append(xfer)
        if len(self.transfers) > self.max_transfers:
            del self.transfers[:len(self.transfers) - self.max_transfers]


def transfer_row(x):
    """Flat row for a table view."""
    return {"t_ms": round(x["t"] / 1e6, 3), "addr": x["addr"], "ep": x["ep"], "type": x["type"],
            "dir": x["dir"], "request": x["request"], "length": x["length"], "status": x["status"],
            "data": x["data"][:64] + ("…" if len(x["data"]) > 64 else "")}


def transaction_row(txn):
    return {"t_ms": round(txn["t"] / 1e6, 3), "token": txn["token"], "addr": txn["addr"], "ep": txn["ep"],
            "pid": txn["pid"], "length": len(txn["data"]) if txn["data"] is not None else None,
            "handshake": txn["handshake"], "data": (txn["data"] or b"")[:32].hex(),
            "errors": txn["errors"] or None}


def devices_doc(devices):
    """JSON-friendly copy of Decoder.devices (int keys -> strings)."""
    out = {}
    for addr, dev in sorted(devices.items()):
        d = dict(dev)
        d["configurations"] = {str(k): v for k, v in dev["configurations"].items()}
        d["strings"] = {str(k): v for k, v in dev["strings"].items()}
        out[str(addr)] = d
    return out


# ---- pcap ---------------------------------------------------------------------------

PCAP_MAGIC_US = 0xA1B2C3D4
PCAP_MAGIC_NS = 0xA1B23C4D


def write_pcap(packets, start_ns=0, linktype=LINKTYPE_USB_2_0):
    """[(t_ns, bytes)] -> nanosecond pcap (LINKTYPE_USB_2_0: PID .. CRC per record)."""
    out = bytearray(struct.pack("<IHHiIII", PCAP_MAGIC_NS, 2, 4, 0, 0, 65535, linktype))
    for t, data in packets:
        ts = start_ns + t
        out += struct.pack("<IIII", ts // 1_000_000_000, ts % 1_000_000_000, len(data), len(data))
        out += data
    return bytes(out)


def read_pcap(raw):
    """pcap bytes -> (linktype, start_ns, [(t_ns relative to the first record, bytes)])."""
    raw = bytes(raw)
    if len(raw) < 24:
        raise ValueError("not a pcap file (too short)")
    if raw[:4] == b"\x0a\x0d\x0d\x0a":
        raise ValueError("pcapng is not supported; save as pcap (Packetry: File > Save)")
    magic_le = struct.unpack_from("<I", raw)[0]
    magic_be = struct.unpack_from(">I", raw)[0]
    if magic_le in (PCAP_MAGIC_US, PCAP_MAGIC_NS):
        end, magic = "<", magic_le
    elif magic_be in (PCAP_MAGIC_US, PCAP_MAGIC_NS):
        end, magic = ">", magic_be
    else:
        raise ValueError("not a pcap file (magic 0x%08x)" % magic_le)
    scale = 1 if magic == PCAP_MAGIC_NS else 1000
    linktype = struct.unpack_from(end + "I", raw, 20)[0] & 0x0FFFFFFF
    pos = 24
    packets = []
    start = None
    while pos + 16 <= len(raw):
        sec, frac, incl, _orig = struct.unpack_from(end + "IIII", raw, pos)
        pos += 16
        if pos + incl > len(raw):
            break
        ts = sec * 1_000_000_000 + frac * scale
        if start is None:
            start = ts
        packets.append((ts - start, raw[pos:pos + incl]))
        pos += incl
    return linktype, start or 0, packets
