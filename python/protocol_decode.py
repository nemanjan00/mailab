"""Protocol decoding on logic sample streams (numpy only, no liquid-dsp).

Input is a stream of logic "words": sample k carries channel b in bit b
(an 8-channel logic analyzer capture is one uint8 per sample). Analog or
float input (a UART line from uart_tx, a scope trace) is thresholded into
channel 0 first.

Two engines produce the same annotation rows
    {"ss", "es", "t", "decoder", "class", "row", "text", "value"?}
- "sigrok": the real libsigrokdecode decoder scripts
  (/usr/share/libsigrokdecode/decoders/<id>/pd.py), run in-process by a small
  pure-Python implementation of the `sigrokdecode` module API (wait()
  conditions, put(), register(), stacking). The `sigrokdecode` module only
  exists embedded in libsigrokdecode, and sigrok-cli 0.7.2 against current
  libsigrokdecode-git aborts on any channel mapping ("g_variant_get_type:
  assertion 'value != NULL' failed"), so this is the path that works.
- "builtin": numpy decoders for uart, spi, i2c and manchester (no sigrok needed).

"auto" uses sigrok when the decoder scripts are installed, builtin otherwise.
"""

import importlib
import os
import sys
import threading

import numpy as np

SIGROK_DIRS = [os.environ.get("SIGROKDECODE_DIR", ""), "/usr/share/libsigrokdecode/decoders",
               "/usr/local/share/libsigrokdecode/decoders"]

# decoder channel -> bit in the input word, when the caller gives no mapping
DEFAULT_CHANNELS = {
    "uart": {"rx": 0},
    "spi": {"clk": 0, "mosi": 1, "miso": 2, "cs": 3},
    "i2c": {"scl": 0, "sda": 1},
    "manchester": {"data": 0},
}

# annotation classes whose text is a hex byte (-> "value", blob, byte log)
DATA_CLASSES = {"rx-data", "tx-data", "mosi-data", "miso-data", "data-read", "data-write",
                "address-read", "address-write", "data"}

# line levels assumed before the first sample (libsigrokdecode "initial_pins"),
# so a frame that starts right at sample 0 still has its edge
IDLE_LEVELS = {"uart": {"rx": 1, "tx": 1}, "i2c": {"scl": 1, "sda": 1}}

UNASSIGNED = 0xFF  # pin value of an unmapped optional channel (as libsigrokdecode)


def sigrok_dir():
    for d in SIGROK_DIRS:
        if d and os.path.isdir(d):
            return d
    return None


def sigrok_has(decoder):
    d = sigrok_dir()
    return bool(d) and os.path.isfile(os.path.join(d, decoder, "pd.py"))


def _hex_value(text):
    try:
        return int(text.split(":")[-1].strip(), 16)
    except (ValueError, AttributeError):
        return None


def annotation(decoder, cls, row, ss, es, texts, rate, value=None):
    text = texts[0] if texts else ""
    out = {"ss": int(ss), "es": int(es), "t": (ss / rate) if rate else None, "decoder": decoder,
           "class": cls, "row": row, "text": text}
    if value is None and cls in DATA_CLASSES:
        value = _hex_value(texts[-1] if texts else "")
    if value is not None:
        out["value"] = int(value)
    return out


def data_bytes(annotations, classes=None):
    """bytes carried by data annotations (optionally only some classes)"""
    return bytes(a["value"] & 0xFF for a in annotations
                 if "value" in a and a["class"] in (classes or DATA_CLASSES) and not a["class"].startswith("address"))


# ---- input conversion ---------------------------------------------------------

class LogicInput:
    """chunk -> integer words. Floats/complex are thresholded (adaptive mid level
    unless `threshold` is given) into bit 0; integers/bools pass through."""

    def __init__(self, threshold=None, invert=False):
        self.threshold = threshold
        self.invert = invert
        self.lo = None
        self.hi = None

    def process(self, x):
        x = np.asarray(x)
        if x.dtype.kind in "biu":
            words = x.astype(np.uint32)
        else:
            y = np.real(x).astype(np.float32)
            if self.threshold is not None:
                level = float(self.threshold)
            else:
                if len(y):
                    lo, hi = float(np.min(y)), float(np.max(y))
                    self.lo = lo if self.lo is None else min(self.lo * 0.99 + lo * 0.01, lo)
                    self.hi = hi if self.hi is None else max(self.hi * 0.99 + hi * 0.01, hi)
                if self.lo is None or self.hi - self.lo < 1e-9:
                    # flat so far: call it idle high only if it sits above 0.5
                    level = 0.5
                else:
                    level = (self.lo + self.hi) / 2
            words = (y > level).astype(np.uint32)
        if self.invert:
            words = words ^ 1
        return words


WORD_FORMATS = ("u8", "u16", "u32", "bits")


def words_from_bytes(data, fmt="u8"):
    """raw external capture -> words: u8/u16/u32 little-endian samples, or
    bits (packed MSB first, one channel)"""
    if fmt == "bits":
        return np.unpackbits(np.frombuffer(bytes(data), dtype=np.uint8)).astype(np.uint32)
    dtype = {"u8": np.uint8, "u16": "<u2", "u32": "<u4"}[fmt]
    size = np.dtype(dtype).itemsize
    raw = bytes(data)[: len(data) - len(data) % size]
    return np.frombuffer(raw, dtype=dtype).astype(np.uint32)


def words_to_bytes(x, fmt="u8"):
    """inverse of words_from_bytes (floats are thresholded at 0.5)"""
    x = np.asarray(x)
    words = x.astype(np.uint32) if x.dtype.kind in "biu" else (np.real(x) > 0.5).astype(np.uint32)
    if fmt == "bits":
        return np.packbits((words & 1).astype(np.uint8)).tobytes()
    return words.astype({"u8": np.uint8, "u16": "<u2", "u32": "<u4"}[fmt]).tobytes()


def _channel(words, bit):
    return ((words >> int(bit)) & 1).astype(np.uint8)


def _edges(words, prev, bits):
    """indices (in this chunk) where any of `bits` changes vs. the previous sample"""
    mask = 0
    for b in bits:
        mask |= 1 << int(b)
    w = words & mask
    before = np.concatenate([[prev & mask if prev is not None else w[0] if len(w) else 0], w[:-1]])
    return np.nonzero(w != before)[0]


# ---- builtin decoders -----------------------------------------------------------

class Builtin:
    name = ""
    channels = ()

    def __init__(self, options, channels, rate):
        self.o = dict(options or {})
        self.ch = channels
        self.rate = float(rate)
        self.pos = 0          # absolute index of the next sample
        self.prev = None      # last word seen

    def ann(self, cls, row, ss, es, texts, value=None):
        return annotation(self.name, cls, row, ss, es, texts, self.rate, value)

    def flush(self):
        return []


class UartBuiltin(Builtin):
    """Same sampling as sigrok's uart: falling edge = start bit, bits sampled at
    their centre. Runs one receiver per mapped line (rx / tx)."""
    name = "uart"

    def __init__(self, options, channels, rate):
        super().__init__(options, channels, rate)
        baud = float(self.o.get("baudrate", 115200))
        self.lines = {k: UartLine(rate / baud, int(self.o.get("data_bits", 8)), str(self.o.get("parity", "none")),
                                  float(self.o.get("stop_bits", 1)), self.o.get("bit_order", "lsb-first") == "msb-first")
                      for k in ("rx", "tx") if k in channels}
        if not self.lines:
            raise ValueError("uart: map rx and/or tx")
        self.invert = {k: self.o.get("invert_" + k, "no") in ("yes", True) for k in self.lines}

    def process(self, words):
        out = []
        for k, line in self.lines.items():
            levels = _channel(words, self.ch[k])
            if self.invert[k]:
                levels ^= 1
            for ss, es, byte, error in line.process(levels):
                out.append(self.ann(k + "-data", k + "-data-vals", ss, es, ["%02X" % byte], byte))
                if error == "parity":
                    out.append(self.ann(k + "-parity-err", k + "-data-vals", ss, es, ["Parity error"]))
                elif error:
                    out.append(self.ann(k + "-warning", k + "-warnings", ss, es, ["Frame error"]))
        out.sort(key=lambda a: a["ss"])
        return out

    def flush(self):
        # pad with idle so a frame ending right at the end of the capture completes
        pad = max(int(np.ceil(line.sps * 14)) for line in self.lines.values()) + 2
        mask = 0
        for k in self.lines:
            mask |= (0 if self.invert[k] else 1) << int(self.ch[k])
        return self.process(np.full(pad, mask, dtype=np.uint32))


class UartLine:
    """0/1 line levels (idle high) -> (ss, es, value, error) with absolute sample
    positions. A virtual idle level precedes the very first sample, so a frame
    starting at sample 0 is still found."""

    def __init__(self, sps, bits=8, parity="none", stop=1.0, msb_first=False):
        self.sps, self.bits, self.parity, self.stop, self.msb = float(sps), int(bits), parity, float(stop), msb_first
        pad = int(np.ceil(self.sps)) + 1
        self.buf = np.ones(pad, dtype=np.uint8)
        self.base = -pad      # absolute index of buf[0]

    def process(self, levels):
        self.buf = np.concatenate([self.buf, np.asarray(levels, dtype=np.uint8)])
        level = self.buf
        data_end = 1 + self.bits + (0 if self.parity in ("none",) else 1)
        frame_bits = data_end + self.stop
        span = int(np.ceil(frame_bits * self.sps))
        out = []
        falls = np.nonzero((level[:-1] == 1) & (level[1:] == 0))[0] + 1
        i = 1
        for f in falls:
            if f < i:
                continue
            if f + span >= len(level):
                i = f
                break
            sample = lambda k, f=f: int(level[int(f + (k + 0.5) * self.sps)])
            if sample(0) != 0:
                i = f + 1
                continue
            bits = [sample(1 + b) for b in range(self.bits)]
            if self.msb:
                bits = bits[::-1]
            value = sum(bit << b for b, bit in enumerate(bits))
            error = None
            k = 1 + self.bits
            if self.parity not in ("none",):
                p = sample(k)
                expect = {"even": sum(bits) % 2, "odd": 1 - sum(bits) % 2, "zero": 0, "one": 1}.get(self.parity, p)
                if p != expect:
                    error = "parity"
                k += 1
            if any(sample(k + s) != 1 for s in range(max(1, int(np.ceil(self.stop))))):
                error = error or "framing"
            out.append((self.base + f + int(self.sps), self.base + f + int(data_end * self.sps), value, error))
            i = f + int(frame_bits * self.sps)
        else:
            i = max(i, len(level) - span)
        keep = max(0, min(i, len(level)) - 1)
        self.buf = self.buf[keep:]
        self.base += keep
        return out


class SpiBuiltin(Builtin):
    name = "spi"

    def __init__(self, options, channels, rate):
        super().__init__(options, channels, rate)
        if "clk" not in channels or not ({"mosi", "miso"} & set(channels)):
            raise ValueError("spi: map clk and mosi and/or miso")
        cpol, cpha = int(self.o.get("cpol", 0)), int(self.o.get("cpha", 0))
        # data is sampled on the rising edge for modes 0 and 3
        self.sample_rising = cpol == cpha
        self.msb = self.o.get("bitorder", "msb-first") == "msb-first"
        self.size = int(self.o.get("wordsize", 8))
        self.cs_active = 0 if self.o.get("cs_polarity", "active-low") == "active-low" else 1
        self.lines = [k for k in ("miso", "mosi") if k in channels]
        self.bits = {k: [] for k in self.lines}
        self.first = None
        self.last_level = None

    def reset_word(self):
        self.bits = {k: [] for k in self.lines}
        self.first = None

    def process(self, words):
        out = []
        watch = [self.ch["clk"]] + ([self.ch["cs"]] if "cs" in self.ch else [])
        for i in _edges(words, self.prev, watch):
            w = int(words[i])
            p = int(self.prev) if i == 0 and self.prev is not None else int(words[i - 1]) if i else w
            n = self.pos + int(i)
            if "cs" in self.ch and ((w >> self.ch["cs"]) & 1) != ((p >> self.ch["cs"]) & 1):
                self.reset_word()
            if "cs" in self.ch and ((w >> self.ch["cs"]) & 1) != self.cs_active:
                continue
            clk, pclk = (w >> self.ch["clk"]) & 1, (p >> self.ch["clk"]) & 1
            if clk == pclk or bool(clk) != self.sample_rising:
                continue
            if self.first is None:
                self.first = n
            for k in self.lines:
                self.bits[k].append((w >> self.ch[k]) & 1)
            if len(self.bits[self.lines[0]]) == self.size:
                for k in self.lines:
                    b = self.bits[k] if not self.msb else self.bits[k][::-1]
                    value = sum(bit << j for j, bit in enumerate(b))
                    out.append(self.ann(k + "-data", k + "-data-vals", self.first, n, ["%02X" % value], value))
                self.reset_word()
        if len(words):
            self.prev = int(words[-1])
        self.pos += len(words)
        return out


class I2cBuiltin(Builtin):
    name = "i2c"

    def __init__(self, options, channels, rate):
        super().__init__(options, channels, rate)
        if "scl" not in channels or "sda" not in channels:
            raise ValueError("i2c: map scl and sda")
        self.shifted = self.o.get("address_format", "shifted") == "shifted"
        self.state = "idle"
        self.bits = []
        self.ss = None
        self.read = False

    def process(self, words):
        out = []
        scl_b, sda_b = self.ch["scl"], self.ch["sda"]
        for i in _edges(words, self.prev, [scl_b, sda_b]):
            w = int(words[i])
            p = int(self.prev) if i == 0 and self.prev is not None else int(words[i - 1]) if i else w
            n = self.pos + int(i)
            scl, sda, pscl, psda = (w >> scl_b) & 1, (w >> sda_b) & 1, (p >> scl_b) & 1, (p >> sda_b) & 1
            if scl and pscl and psda and not sda:
                repeat = self.state != "idle"
                out.append(self.ann("repeat-start" if repeat else "start", "addr-data", n, n,
                                    ["Start repeat" if repeat else "Start", "Sr" if repeat else "S"]))
                self.state, self.bits = "address", []
            elif scl and pscl and sda and not psda:
                out.append(self.ann("stop", "addr-data", n, n, ["Stop", "P"]))
                self.state, self.bits = "idle", []
            elif scl and not pscl and self.state != "idle":
                if not self.bits:
                    self.ss = n
                self.bits.append(sda)
                if len(self.bits) == 9:
                    byte = sum(bit << (7 - j) for j, bit in enumerate(self.bits[:8]))
                    if self.state == "address":
                        self.read = bool(byte & 1)
                        addr = byte >> 1 if self.shifted else byte
                        cls = "address-read" if self.read else "address-write"
                        label = "Address read" if self.read else "Address write"
                        out.append(self.ann(cls, "addr-data", self.ss, n, ["%s: %02X" % (label, addr), "%02X" % addr], addr))
                        self.state = "data"
                    else:
                        cls = "data-read" if self.read else "data-write"
                        label = "Data read" if self.read else "Data write"
                        out.append(self.ann(cls, "addr-data", self.ss, n, ["%s: %02X" % (label, byte), "%02X" % byte], byte))
                    ack = self.bits[8] == 0
                    out.append(self.ann("ack" if ack else "nack", "addr-data", n, n, ["ACK" if ack else "NACK"]))
                    self.bits = []
        if len(words):
            self.prev = int(words[-1])
        self.pos += len(words)
        return out


class ManchesterBuiltin(Builtin):
    """Manchester at a known bitrate. convention ieee (802.3: low->high mid-bit
    = 1) or thomas (G.E. Thomas: high->low = 1). Edges one bit apart are both
    mid-bit edges; the first such pair locks the clock, and the edges before
    it (half a bit apart) alternate mid-bit / boundary counting back from it.
    A frame of identical bits has no such pair: its first edge is taken as
    mid-bit. A gap of more than 1.5 bits ends the frame; bits are grouped into
    bytes (bitorder msb-first by default) from the frame start."""
    name = "manchester"

    def __init__(self, options, channels, rate):
        super().__init__(options, channels, rate)
        self.T = rate / float(self.o.get("bitrate", 9600))
        self.one_rising = self.o.get("convention", "ieee") == "ieee"
        self.msb = self.o.get("bitorder", "msb-first") == "msb-first"
        self.last_mid = None
        self.pending = []     # edges of a frame before the clock is locked
        self.bits = []
        self.byte_ss = None

    def bit(self, n, rising):
        one = rising == self.one_rising
        out = [self.ann("bit", "bits", n - self.T / 2, n + self.T / 2, ["1" if one else "0"])]
        if not self.bits:
            self.byte_ss = int(n - self.T / 2)
        self.bits.append(1 if one else 0)
        if len(self.bits) == 8:
            b = self.bits if not self.msb else self.bits[::-1]
            value = sum(bit << j for j, bit in enumerate(b))
            out.append(self.ann("data", "data", self.byte_ss, int(n + self.T / 2), ["%02X" % value], value))
            self.bits = []
        self.last_mid = n
        return out

    def resolve(self, mids_from):
        out = []
        for n, rising in self.pending[mids_from::2]:
            out += self.bit(n, rising)
        self.pending = []
        return out

    def end_frame(self):
        out = self.resolve(0) if self.pending else []
        if self.bits:
            out.append(self.ann("warning", "warnings", self.byte_ss, self.last_mid, ["%d trailing bits" % len(self.bits)]))
        self.bits, self.last_mid = [], None
        return out

    def process(self, words):
        out = []
        b = self.ch["data"]
        for i in _edges(words, self.prev, [b]):
            n = self.pos + int(i)
            rising = bool((int(words[i]) >> b) & 1)
            last = self.last_mid if self.last_mid is not None else self.pending[-1][0] if self.pending else None
            if last is not None and n - last > 1.5 * self.T:
                out += self.end_frame()
                last = None
            if self.last_mid is None:
                if last is not None and n - last >= 0.75 * self.T:
                    # pending[-1] and this edge are both mid-bit
                    out += self.resolve((len(self.pending) - 1) % 2)
                    out += self.bit(n, rising)
                else:
                    self.pending.append((n, rising))
                continue
            if n - self.last_mid < 0.75 * self.T:
                continue      # boundary edge between equal bits
            out += self.bit(n, rising)
        if len(words):
            self.prev = int(words[-1])
        self.pos += len(words)
        return out

    def flush(self):
        return self.end_frame()


BUILTIN = {"uart": UartBuiltin, "spi": SpiBuiltin, "i2c": I2cBuiltin, "manchester": ManchesterBuiltin}


# ---- libsigrokdecode decoders, run in-process -----------------------------------

class _End(EOFError):
    pass


def _install_srd_module():
    """A `sigrokdecode` module with the API the decoder scripts use."""
    if "sigrokdecode" in sys.modules and getattr(sys.modules["sigrokdecode"], "MAILAB_SHIM", False):
        return sys.modules["sigrokdecode"]
    mod = type(sys)("sigrokdecode")
    mod.MAILAB_SHIM = True
    mod.OUTPUT_ANN, mod.OUTPUT_PYTHON, mod.OUTPUT_BINARY, mod.OUTPUT_LOGIC, mod.OUTPUT_META = 0, 1, 2, 3, 4
    mod.SRD_CONF_SAMPLERATE = 10000

    class Decoder:
        def register(self, output_type, meta=None, proto_id=None):
            return self._srd.register(output_type)

        def put(self, ss, es, output_id, data):
            self._srd.put(self, ss, es, output_id, data)

        def wait(self, conds=None):
            return self._srd.wait(self, conds)

        def has_channel(self, index):
            return self._srd.pin_map[index] is not None

    mod.Decoder = Decoder
    sys.modules["sigrokdecode"] = mod
    return mod


def _load_decoder_class(decoder):
    d = sigrok_dir()
    if not d or not sigrok_has(decoder):
        raise ValueError("sigrok decoder %r not found (looked in %s)" % (decoder, [x for x in SIGROK_DIRS if x]))
    _install_srd_module()
    if d not in sys.path:
        sys.path.insert(0, d)
    return importlib.import_module(decoder).Decoder


def _coerce(value, default):
    if isinstance(default, bool):
        return value in (True, "yes", "true", 1)
    if isinstance(default, int):
        return int(value)
    if isinstance(default, float):
        return float(value)
    return str(value)


class _Instance:
    """one decoder instance plus its stacked children"""

    def __init__(self, runner, decoder, options):
        cls = _load_decoder_class(decoder)
        self.runner, self.id = runner, decoder
        inst = cls.__new__(cls)
        inst._srd = runner
        opts = {o["id"]: o["default"] for o in getattr(cls, "options", ())}
        for k, v in (options or {}).items():
            if k not in opts:
                raise ValueError("%s: unknown option %r (has %s)" % (decoder, k, sorted(opts)))
            opts[k] = _coerce(v, opts[k])
        inst.options = opts
        inst.samplenum = 0
        inst.matched = None
        inst.__init__()
        self.inst = inst
        self.children = []
        self.ann_ids = [a[0] for a in getattr(cls, "annotations", ())]
        self.rows = {}
        for row in getattr(cls, "annotation_rows", ()):
            for c in row[2]:
                self.rows[int(c)] = row[0]
        self.outputs = {}    # output id -> type
        inst._srd_owner = self


class SigrokRunner:
    """Streams words through a libsigrokdecode decoder script (plus stacked
    decoders). decode() runs in its own thread and blocks inside wait() until
    feed() supplies enough samples, like libsigrokdecode's session."""

    def __init__(self, decoder, options, channels, rate, stack=None, idle=None):
        self.rate = float(rate)
        self.outputs = []
        self.pending = []
        self.error = None
        self._current = None
        self.root = _Instance(self, decoder, options)
        cls = type(self.root.inst)
        chans = list(getattr(cls, "channels", ())) + list(getattr(cls, "optional_channels", ()))
        ids = [c["id"] for c in chans]
        for k in channels:
            if k not in ids:
                raise ValueError("%s has no channel %r (channels: %s)" % (decoder, k, ids))
        for c in getattr(cls, "channels", ()):
            if c["id"] not in channels:
                raise ValueError("%s: required channel %r is not mapped" % (decoder, c["id"]))
        self.pin_map = [channels.get(i) for i in ids]
        initial = getattr(self.root.inst, "initial_pins", None)
        if initial is None:
            idle = idle or {}
            inverted = {k for k in ids if str(self.root.inst.options.get("invert_" + k, "no")) in ("yes", "True", "true")}
            initial = [(idle[k] ^ 1 if k in inverted else idle[k]) if k in idle and channels.get(k) is not None else 2
                       for k in ids]
        self.initial = list(initial)
        parent = self.root
        for spec in stack or []:
            spec = {"id": spec} if isinstance(spec, str) else spec
            child = _Instance(self, spec["id"], spec.get("options"))
            parent.children.append(child)
            parent = child
        self.instances = []
        stack_all = [self.root]
        while stack_all:
            i = stack_all.pop()
            self.instances.append(i)
            stack_all += i.children
        for i in self.instances:
            self._current = i
            if hasattr(i.inst, "start"):
                i.inst.start()
            if hasattr(i.inst, "metadata"):
                i.inst.metadata(10000, self.rate)
        self._current = None
        self.pins = np.zeros((0, len(ids)), dtype=np.uint8)
        self.base = 0
        self.first_wait = True
        self.ended = False
        self.done = False
        self.thread = None
        self._go = threading.Semaphore(0)
        self._idle = threading.Semaphore(0)

    # decoder API -------------------------------------------------------------
    def register(self, output_type):
        owner = self._current
        oid = len(self.outputs)
        self.outputs.append((owner, output_type))
        return oid

    def put(self, inst, ss, es, output_id, data):
        owner, kind = self.outputs[output_id]
        if kind == 0:
            cls_idx, texts = data[0], list(data[1])
            self.pending.append(annotation(owner.id, owner.ann_ids[cls_idx] if cls_idx < len(owner.ann_ids) else str(cls_idx),
                                           owner.rows.get(cls_idx, ""), ss, es, texts, self.rate))
        elif kind == 1:
            for child in owner.children:
                child.inst.decode(ss, es, data)

    def _pins(self, words):
        cols = [(_channel(words, b) if b is not None else np.full(len(words), UNASSIGNED, np.uint8)) for b in self.pin_map]
        return np.stack(cols, axis=1) if cols else np.zeros((len(words), 0), np.uint8)

    def _match(self, conds, start, stop, target_base):
        """first absolute index in [start, stop) matching any condition, + matched flags"""
        a, b = start - self.base, stop - self.base
        cur = self.pins[a:b]
        if a >= 1:
            prev = self.pins[a - 1:b - 1]
        else:
            first = self.pins[0:1].copy()
            for j, level in enumerate(self.initial):
                if level in (0, 1):
                    first[0, j] = level
            prev = np.concatenate([first, self.pins[0:b - 1]])
        idx = np.arange(start, stop)
        masks = []
        for cond in conds:
            m = np.ones(len(cur), dtype=bool)
            for key, want in cond.items():
                if key == "skip":
                    m &= idx == target_base + int(want)
                    continue
                c, p = cur[:, int(key)], prev[:, int(key)]
                if want == "h":
                    m &= c == 1
                elif want == "l":
                    m &= c == 0
                elif want == "r":
                    m &= (p == 0) & (c == 1)
                elif want == "f":
                    m &= (p == 1) & (c == 0)
                elif want == "e":
                    m &= p != c
                elif want in ("s", "n"):
                    m &= p == c
                else:
                    raise ValueError("unsupported wait condition %r" % want)
            masks.append(m)
        hit = np.logical_or.reduce(masks) if masks else np.ones(len(cur), dtype=bool)
        if not hit.any():
            return None, None
        i = int(np.argmax(hit))
        return start + i, tuple(bool(m[i]) for m in masks)

    def wait(self, inst, conds):
        if conds is None:
            conds = [{}]
        elif isinstance(conds, dict):
            conds = [conds]
        conds = [dict(c) for c in conds] or [{}]
        target_base = inst.samplenum
        start = 0 if self.first_wait else inst.samplenum + 1
        self.first_wait = False
        # skip: 0 means "this sample"
        for c in conds:
            if "skip" in c and target_base + int(c["skip"]) < start:
                c["skip"] = start - target_base
        window = 64
        while True:
            end = self.base + len(self.pins)
            while start < end:
                stop = min(end, start + window)
                where, matched = self._match(conds, start, stop, target_base)
                if where is not None:
                    inst.samplenum = where
                    inst.matched = matched
                    return tuple(int(v) for v in self.pins[where - self.base])
                start = stop
                window = min(window * 4, 1 << 20)
            if self.ended:
                raise _End()
            self._idle.release()
            self._go.acquire()

    # driving -------------------------------------------------------------------
    def _run(self):
        try:
            self.root.inst.decode()
        except _End:
            pass
        except Exception as err:   # decoder errors (missing samplerate, bad channels...)
            self.error = "%s: %s" % (type(err).__name__, err)
        finally:
            self.done = True
            self._idle.release()

    def process(self, words):
        if self.done:
            return self._take()
        # the decoder only moves forward; keep one sample before its position for edges
        keep_from = max(self.base, self.root.inst.samplenum - 1)
        self.pins = np.concatenate([self.pins[keep_from - self.base:], self._pins(np.asarray(words, dtype=np.uint32))])
        self.base = keep_from
        if self.thread is None:
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
        else:
            self._go.release()
        self._idle.acquire()
        return self._take()

    def flush(self):
        if self.thread is not None and not self.done:
            self.ended = True
            self._go.release()
            self._idle.acquire()
        return self._take()

    def _take(self):
        out, self.pending = self.pending, []
        return out


# ---- facade -----------------------------------------------------------------------

def pick_engine(decoder, engine="auto"):
    if engine == "auto":
        return "sigrok" if sigrok_has(decoder) else "builtin"
    if engine == "builtin" and decoder not in BUILTIN:
        raise ValueError("no builtin decoder %r (builtin: %s)" % (decoder, sorted(BUILTIN)))
    if engine not in ("sigrok", "builtin"):
        raise ValueError("engine must be auto, sigrok or builtin")
    return engine


class ProtocolDecoder:
    """feed(chunk) -> new annotations; flush() at the end of a capture."""

    def __init__(self, decoder, rate, options=None, channels=None, engine="auto", stack=None, threshold=None):
        self.decoder = decoder
        self.engine = pick_engine(decoder, engine)
        if channels:
            chans = {k: int(v) for k, v in channels.items()}
        elif decoder in DEFAULT_CHANNELS:
            chans = dict(DEFAULT_CHANNELS[decoder])
        else:
            chans = None
        self.input = LogicInput(threshold)
        if self.engine == "sigrok":
            if chans is None:
                cls = _load_decoder_class(decoder)
                chans = {c["id"]: i for i, c in enumerate(getattr(cls, "channels", ()))}
            self.impl = SigrokRunner(decoder, options, chans, rate, stack, IDLE_LEVELS.get(decoder))
        else:
            self.impl = BUILTIN[decoder](options, chans or {}, rate)
        self.channels = chans

    @property
    def error(self):
        return getattr(self.impl, "error", None)

    def feed(self, x):
        words = self.input.process(x)
        if not len(words):
            return []
        return self.impl.process(words)

    def flush(self):
        return self.impl.flush()


def decode(x, rate, decoder, **kw):
    """one-shot: whole capture -> annotations"""
    d = ProtocolDecoder(decoder, rate, **kw)
    out = d.feed(x) + d.flush()
    if d.error:
        raise ValueError(d.error)
    return out
