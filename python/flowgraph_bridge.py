"""mailab flowgraph: GNU Radio-style composable DSP blocks (numpy + liquid-dsp).

A graph is {"blocks": [{"id", "type", "params"}], "links": [["from", "to"], ...]}.
Each block has at most one input; an output can feed several blocks. Samples
flow as (array, rate) chunks; blocks keep state between chunks.

Sinks publish to the lab: traces (spectrum, constellation, eye, scope),
channels (measurements such as EVM), audio streams and WAV files. The graph
and per-block stats are published as lab values "<device>_graph" / "_stats".
"""

import argparse
import base64
import json
import time
import wave

import numpy as np

import liquid_dsp as dsp
import mailab_bridge as lab

TICK = 0.02


# ---- block library ------------------------------------------------------------

class Block:
    kind = "dsp"          # source | dsp | sink
    params = {}           # name -> (default, doc)
    doc = ""

    def __init__(self, bid, params):
        self.id = bid
        self.p = {k: v[0] for k, v in self.params.items()}
        self.p.update(params or {})
        self.samples_in = 0
        self.samples_out = 0
        self.rate = None      # used by Stateful to rebuild on rate changes
        self.in_rate = None   # last input rate, for stats

    def work(self, x, rate):
        """-> (y, out_rate) or None to stop the chunk here"""
        return x, rate

    def close(self):
        pass


class Throttled(Block):
    kind = "sink"

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self._last = 0.0

    def due(self):
        now = time.monotonic()
        if now - self._last >= 1.0 / float(self.p.get("fps", 10)):
            self._last = now
            return True
        return False


# sources ------------------------------------------------------------------

class SignalSource(Block):
    kind = "source"
    doc = "complex tone plus noise"
    params = {"rate": (100e3, "sample rate"), "freq": (10e3, "tone Hz"), "amp": (1.0, ""), "noise": (0.01, "noise rms")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.n = 0
        self.t = time.monotonic()

    def produce(self):
        now = time.monotonic()
        rate = float(self.p["rate"])
        count = int((now - self.t) * rate)
        if count <= 0:
            return None
        self.t += count / rate
        k = np.arange(self.n, self.n + count)
        self.n += count
        x = float(self.p["amp"]) * np.exp(2j * np.pi * float(self.p["freq"]) / rate * k)
        x += float(self.p["noise"]) * (np.random.randn(count) + 1j * np.random.randn(count)) / np.sqrt(2)
        return x.astype(np.complex64), rate


class ModulatedSource(Block):
    kind = "source"
    doc = "random symbols, RRC-shaped (test signal for constellation/eye/demod)"
    params = {"scheme": ("qpsk", "bpsk|qpsk|psk8|qam16|qam64|apsk16..."), "rate": (100e3, "sample rate"),
              "sps": (8, "samples per symbol"), "beta": (0.35, "RRC roll-off"), "snr_db": (25.0, ""),
              "cfo": (0.0, "carrier offset Hz"), "phase": (0.0, "degrees")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.modem = dsp.Modem(self.p["scheme"])
        self.interp = dsp.RrcInterpolator(int(self.p["sps"]), beta=float(self.p["beta"]))
        self.t = time.monotonic()
        self.n = 0
        self.rng = np.random.default_rng()

    def produce(self):
        now = time.monotonic()
        rate = float(self.p["rate"])
        sps = int(self.p["sps"])
        symbols = int((now - self.t) * rate / sps)
        if symbols <= 0:
            return None
        self.t += symbols * sps / rate
        x = self.interp.process(self.modem.modulate(self.rng.integers(0, len(self.modem.table), symbols)))
        k = np.arange(self.n, self.n + len(x))
        self.n += len(x)
        x = x * np.exp(1j * (2 * np.pi * float(self.p["cfo"]) / rate * k + np.radians(float(self.p["phase"]))))
        power = np.mean(np.abs(x) ** 2) or 1.0
        sigma = np.sqrt(power / 10 ** (float(self.p["snr_db"]) / 10) / 2)
        x = x + sigma * (self.rng.standard_normal(len(x)) + 1j * self.rng.standard_normal(len(x)))
        return x.astype(np.complex64), rate


class FileSource(Block):
    kind = "source"
    doc = "raw cf32 IQ file, played back in real time"
    params = {"path": ("", "cf32 file"), "rate": (1e6, "sample rate"), "loop": (True, "")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.data = np.fromfile(self.p["path"], dtype=np.complex64)
        self.pos = 0
        self.t = time.monotonic()

    def produce(self):
        now = time.monotonic()
        rate = float(self.p["rate"])
        count = int((now - self.t) * rate)
        if count <= 0 or not len(self.data):
            return None
        self.t += count / rate
        out = self.data[self.pos:self.pos + count]
        self.pos += count
        if self.pos >= len(self.data):
            if self.p["loop"]:
                self.pos = 0
            elif not len(out):
                return None
        return out, rate


class SoapySource(Block):
    kind = "source"
    doc = "SoapySDR receiver (bladeRF, HackRF, RTL-SDR...)"
    params = {"args": ("", "e.g. driver=bladerf"), "freq": (100e6, ""), "rate": (2e6, ""), "gain": (30.0, "")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        import SoapySDR
        from SoapySDR import SOAPY_SDR_RX, SOAPY_SDR_CF32
        self.sdr = SoapySDR.Device(self.p["args"])
        self.sdr.setSampleRate(SOAPY_SDR_RX, 0, float(self.p["rate"]))
        self.sdr.setFrequency(SOAPY_SDR_RX, 0, float(self.p["freq"]))
        self.sdr.setGain(SOAPY_SDR_RX, 0, float(self.p["gain"]))
        self.stream = self.sdr.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
        self.sdr.activateStream(self.stream)
        self.buf = np.empty(int(float(self.p["rate"]) * TICK * 2), dtype=np.complex64)

    def produce(self):
        sr = self.sdr.readStream(self.stream, [self.buf], len(self.buf), timeoutUs=int(TICK * 1e6))
        if sr.ret <= 0:
            return None
        return self.buf[:sr.ret].copy(), float(self.p["rate"])

    def close(self):
        self.sdr.deactivateStream(self.stream)
        self.sdr.closeStream(self.stream)


# dsp ----------------------------------------------------------------------

class Stateful(Block):
    """Block whose liquid object depends on the input rate; rebuilt when it changes."""

    def make(self, rate):
        raise NotImplementedError

    def work(self, x, rate):
        if self.rate != rate:
            self.rate = rate
            self.obj = self.make(rate)
        return self.obj.process(x), self.out_rate(rate)

    def out_rate(self, rate):
        return rate


class Shift(Stateful):
    doc = "move a signal at +offset Hz to baseband"
    params = {"offset": (0.0, "Hz")}

    def make(self, rate):
        return dsp.Mixer(float(self.p["offset"]), rate)


class Resample(Stateful):
    doc = "arbitrary-rate resampler"
    params = {"rate": (48e3, "output sample rate")}

    def make(self, rate):
        return dsp.Resampler(float(self.p["rate"]) / rate)

    def out_rate(self, rate):
        return float(self.p["rate"])


class Lowpass(Stateful):
    doc = "Kaiser FIR low-pass"
    params = {"cutoff": (10e3, "Hz"), "taps": (63, "")}

    def make(self, rate):
        return dsp.Lowpass(min(0.49, float(self.p["cutoff"]) / rate), int(self.p["taps"]))


class Agc(Stateful):
    doc = "automatic gain control (normalizes to unit power)"
    params = {"bandwidth": (1e-3, "loop bandwidth")}

    def make(self, rate):
        return dsp.Agc(float(self.p["bandwidth"]))


class FmDemod(Stateful):
    doc = "FM demodulator -> real audio"
    params = {"deviation": (5e3, "Hz")}

    def make(self, rate):
        return dsp.FmDemod(float(self.p["deviation"]), rate)


class AmDemod(Stateful):
    doc = "AM/SSB demodulator -> real audio"
    params = {"mode": ("am", "am|usb|lsb")}

    def make(self, rate):
        return dsp.AmDemod({"am": dsp.AM_DSB, "usb": dsp.AM_USB, "lsb": dsp.AM_LSB}[self.p["mode"]])


class SymbolSync(Stateful):
    doc = "RRC symbol timing recovery: one sample per symbol out"
    params = {"sps": (8, "samples per symbol"), "beta": (0.35, ""), "bandwidth": (0.02, "loop bandwidth")}

    def make(self, rate):
        return dsp.SymbolSync(int(self.p["sps"]), beta=float(self.p["beta"]), bandwidth=float(self.p["bandwidth"]))

    def out_rate(self, rate):
        return rate / int(self.p["sps"])


class CarrierRecovery(Block):
    doc = "decision-directed PLL on symbols (removes carrier offset / phase)"
    params = {"scheme": ("qpsk", ""), "bandwidth": (0.02, "loop bandwidth")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.modem = dsp.Modem(self.p["scheme"])
        self.phase = 0.0
        self.freq = 0.0

    def work(self, x, rate):
        bw = float(self.p["bandwidth"])
        alpha, beta = bw, bw * bw / 4
        table = self.modem.table
        out = np.empty(len(x), dtype=np.complex64)
        for i, v in enumerate(x):
            y = v * np.exp(-1j * self.phase)
            ref = table[np.argmin(np.abs(table - y))]
            err = np.angle(y * np.conj(ref))
            self.freq += beta * err
            self.phase += self.freq + alpha * err
            out[i] = y
        return out, rate


class Demod(Throttled):
    kind = "dsp"
    doc = "symbol decisions + EVM; outputs symbol indices, EVM -> channel <device>_<id>_evm"
    params = {"scheme": ("qpsk", ""), "fps": (5, "EVM updates per second")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.modem = dsp.Modem(self.p["scheme"])

    def work(self, x, rate):
        symbols, evm = self.modem.demodulate(x)
        if len(x) and self.due():
            lab.sample(self.id + "_evm", round(evm, 2), "dB")
        return symbols.astype(np.float32), rate


class Mag(Block):
    doc = "|x|"

    def work(self, x, rate):
        return np.abs(x).astype(np.float32), rate


class Decimate(Block):
    doc = "keep every n-th sample (no filtering; put a lowpass first)"
    params = {"n": (10, "")}

    def work(self, x, rate):
        n = int(self.p["n"])
        return x[::n], rate / n


class Python(Block):
    doc = "scriptable block: params.code defines work(x, rate) -> y or (y, rate); np, dsp and state are in scope"
    params = {"code": ("def work(x, rate):\n    return x * 2", "python source")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        scope = {"np": np, "dsp": dsp, "state": {}}
        exec(self.p["code"], scope)
        if "work" not in scope:
            raise ValueError("python block %s: code must define work(x, rate)" % bid)
        self.fn = scope["work"]

    def work(self, x, rate):
        y = self.fn(x, rate)
        if y is None:
            return None
        if isinstance(y, tuple):
            return y
        return np.asarray(y), rate


# sinks --------------------------------------------------------------------

# window name -> (coefficients(n), equivalent noise bandwidth in bins)
def _cosine_window(coeffs):
    def make(n):
        k = np.arange(n) / n * 2 * np.pi
        return sum(((-1) ** i) * a * np.cos(i * k) for i, a in enumerate(coeffs))
    return make


WINDOWS = {
    "rect": (lambda n: np.ones(n), 1.0),
    "hann": (np.hanning, 1.5),
    "blackmanharris": (_cosine_window([0.35875, 0.48829, 0.14128, 0.01168]), 2.0044),
    "flattop": (_cosine_window([0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368]), 3.7702),
}


class Spectrum(Throttled):
    doc = ("spectrum analyzer -> trace <device>_<id> (dBFS): RBW or FFT size, window, "
           "traces live / max / min / avg (power average over `average` frames), display points with peak/sample detector")
    params = {"rbw": (0.0, "resolution bandwidth Hz (0 = use fft)"), "fft": (1024, "FFT size when rbw is 0"),
              "window": ("hann", "hann|blackmanharris|flattop|rect"), "traces": (["live"], "any of live, max, min, avg"),
              "average": (8, "frames in the avg trace (exponential, power domain)"), "points": (0, "display points (0 = all bins)"),
              "detector": ("peak", "peak|sample when reducing to points"), "fps": (10, ""), "center": (0.0, "Hz added to x axis")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.buf = np.zeros(0, np.complex64)
        self.hold = {}
        self.logged_n = None

    def fft_size(self, rate):
        window, enbw = WINDOWS[self.p["window"]]
        rbw = float(self.p["rbw"])
        if rbw > 0:
            # RBW = ENBW * rate / N  ->  N, rounded up to a power of two
            return int(2 ** np.ceil(np.log2(max(16, enbw * rate / rbw))))
        return int(self.p["fft"])

    def reduce(self, values, points, detector):
        if not points or points >= len(values):
            return values
        edges = np.linspace(0, len(values), points + 1).astype(int)
        if detector == "sample":
            return values[edges[:-1]]
        return np.maximum.reduceat(values, edges[:-1])

    def work(self, x, rate):
        n = self.fft_size(rate)
        self.buf = np.concatenate([self.buf, x.astype(np.complex64)])[-n * 64:]
        if not self.due():
            return None
        frames = len(self.buf) // n
        if not frames:
            return None
        make_window, enbw = WINDOWS[self.p["window"]]
        window = make_window(n)
        blocks = self.buf[:frames * n].reshape(frames, n)
        # keep the incomplete tail frame for next time
        self.buf = self.buf[frames * n:]
        spectra = np.abs(np.fft.fftshift(np.fft.fft(blocks * window, axis=1), axes=1)) ** 2 / np.sum(window) ** 2
        alpha = 1.0 / max(1, int(self.p["average"]))
        if self.hold.get("n") != n:
            self.hold = {"n": n, "max": spectra[0], "min": spectra[0], "avg": spectra[0]}
        for frame in spectra:
            self.hold["max"] = np.maximum(self.hold["max"], frame)
            self.hold["min"] = np.minimum(self.hold["min"], frame)
            self.hold["avg"] = self.hold["avg"] + alpha * (frame - self.hold["avg"])
        curves = {"live": spectra[-1], "max": self.hold["max"], "min": self.hold["min"], "avg": self.hold["avg"]}
        labels = {"live": "live", "max": "max hold", "min": "min hold", "avg": "avg %d" % int(self.p["average"])}
        points = int(self.p["points"])
        freqs = float(self.p["center"]) + np.fft.fftshift(np.fft.fftfreq(n, 1 / rate))
        if points and points < n:
            freqs = freqs[np.linspace(0, n, points + 1).astype(int)[:-1]]
        series = []
        for name in self.p["traces"]:
            db = 10 * np.log10(self.reduce(curves[name], points, self.p["detector"]) + 1e-20)
            series.append({"label": labels[name], "y": np.round(db, 2).tolist()})
        lab.trace(self.id, freqs.tolist(), series, "Hz", "dBFS")
        if self.logged_n != n:
            self.logged_n = n
            lab.log("%s: fft %d, rbw %.1f Hz (%s)" % (self.id, n, enbw * rate / n, self.p["window"]))
        return None


class Constellation(Throttled):
    doc = "I/Q scatter -> trace <device>_<id> (mode constellation)"
    params = {"points": (2000, ""), "fps": (10, "")}

    def work(self, x, rate):
        self.buf = np.concatenate([getattr(self, "buf", np.zeros(0, np.complex64)), x.astype(np.complex64)])[-int(self.p["points"]):]
        if self.due():
            lab.trace(self.id, [], [{"label": "IQ", "x": np.round(self.buf.real, 4).tolist(), "y": np.round(self.buf.imag, 4).tolist()}], "I", "Q", "constellation")
        return None


class Eye(Throttled):
    doc = "eye diagram -> trace <device>_<id> (mode eye); input at sps samples/symbol"
    params = {"sps": (8, "samples per symbol"), "traces": (64, ""), "fps": (5, ""), "part": ("real", "real|imag")}

    def work(self, x, rate):
        sps = int(self.p["sps"])
        span = 2 * sps
        self.buf = np.concatenate([getattr(self, "buf", np.zeros(0, np.complex64)), x.astype(np.complex64)])[-span * int(self.p["traces"]) - span:]
        if not self.due() or len(self.buf) < span + 1:
            return None
        values = self.buf.real if self.p["part"] == "real" else self.buf.imag
        segments = [values[i:i + span + 1] for i in range(0, len(values) - span, sps)][-int(self.p["traces"]):]
        tx = (np.arange(span + 1) / sps).tolist()
        lab.trace(self.id, tx, [{"label": "", "y": np.round(s, 4).tolist()} for s in segments], "symbols", "", "eye")
        return None


class Scope(Throttled):
    doc = "time-domain view -> trace <device>_<id> (real/imag or real)"
    params = {"samples": (1000, ""), "fps": (10, "")}

    def work(self, x, rate):
        if not self.due():
            return None
        y = x[-int(self.p["samples"]):]
        t = (np.arange(len(y)) / rate).tolist()
        if np.iscomplexobj(y):
            series = [{"label": "I", "y": np.round(y.real, 4).tolist()}, {"label": "Q", "y": np.round(y.imag, 4).tolist()}]
        else:
            series = [{"label": "x", "y": np.round(y, 4).tolist()}]
        lab.trace(self.id, t, series, "s", "")
        return None


class Measure(Throttled):
    doc = "statistic of the stream -> channel <device>_<id>"
    params = {"stat": ("power_db", "power_db|rms|mean|peak|last"), "fps": (10, ""), "unit": ("", "")}

    def work(self, x, rate):
        if not len(x) or not self.due():
            return None
        stat = self.p["stat"]
        a = np.abs(x) if np.iscomplexobj(x) else x
        value = {
            "power_db": lambda: 10 * np.log10(np.mean(np.abs(x) ** 2) + 1e-20),
            "rms": lambda: np.sqrt(np.mean(np.abs(x) ** 2)),
            "mean": lambda: np.mean(a),
            "peak": lambda: np.max(np.abs(x)),
            "last": lambda: a[-1],
        }[stat]()
        lab.sample(self.id, float(value), self.p["unit"] or ("dB" if stat == "power_db" else ""))
        return None


class Audio(Block):
    kind = "sink"
    doc = "play in the browser (audio pane on stream <device>_<id>); real input, resampled to `rate`"
    params = {"rate": (24000, "output sample rate"), "gain": (1.0, "")}

    def work(self, x, rate):
        y = np.real(x).astype(np.complex64)
        if rate != float(self.p["rate"]):
            if not hasattr(self, "rs") or self.rs_in != rate:
                self.rs = dsp.Resampler(float(self.p["rate"]) / rate)
                self.rs_in = rate
            y = self.rs.process(y)
        pcm = np.clip(np.real(y) * float(self.p["gain"]), -1, 1)
        lab.emit({"type": "audio", "name": self.id, "rate": float(self.p["rate"]),
                  "data": base64.b64encode((pcm * 32767).astype("<i2").tobytes()).decode()})
        return None


class Wav(Block):
    kind = "sink"
    doc = "record real samples to a WAV file"
    params = {"path": ("/tmp/mailab.wav", "")}

    def work(self, x, rate):
        if not hasattr(self, "w"):
            self.w = wave.open(self.p["path"], "wb")
            self.w.setnchannels(1)
            self.w.setsampwidth(2)
            self.w.setframerate(int(rate))
        self.w.writeframes((np.clip(np.real(x), -1, 1) * 32767).astype("<i2").tobytes())
        return None

    def close(self):
        if hasattr(self, "w"):
            self.w.close()


BLOCKS = {
    "signal": SignalSource, "modulated": ModulatedSource, "file": FileSource, "soapy": SoapySource,
    "shift": Shift, "resample": Resample, "lowpass": Lowpass, "agc": Agc, "fm_demod": FmDemod, "am_demod": AmDemod,
    "symbol_sync": SymbolSync, "carrier_recovery": CarrierRecovery, "demod": Demod, "mag": Mag, "decimate": Decimate,
    "python": Python,
    "spectrum": Spectrum, "constellation": Constellation, "eye": Eye, "scope": Scope, "measure": Measure,
    "audio": Audio, "wav": Wav,
}


# ---- graph ----------------------------------------------------------------------

class Graph:
    def __init__(self):
        self.spec = {"blocks": [], "links": []}
        self.blocks = {}
        self.children = {}
        self.running = True
        self.errors = {}

    def load(self, spec):
        spec = {"blocks": list(spec.get("blocks", [])), "links": [list(l) for l in spec.get("links", [])]}
        ids = [b["id"] for b in spec["blocks"]]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate block ids")
        for b in spec["blocks"]:
            if b.get("type") not in BLOCKS:
                raise ValueError("unknown block type %r (see blocks)" % b.get("type"))
        inputs = {}
        for a, b in spec["links"]:
            if a not in ids or b not in ids:
                raise ValueError("link %s -> %s: unknown block" % (a, b))
            if b in inputs:
                raise ValueError("block %s already has an input (%s)" % (b, inputs[b]))
            if BLOCKS[self._type(spec, b)].kind == "source":
                raise ValueError("block %s is a source and takes no input" % b)
            if BLOCKS[self._type(spec, a)].kind == "sink":
                raise ValueError("block %s is a sink and has no output" % a)
            inputs[b] = a
        self._check_acyclic(spec)
        built = {}
        for b in spec["blocks"]:
            built[b["id"]] = BLOCKS[b["type"]](b["id"], b.get("params"))
        self.close()
        self.spec, self.blocks, self.errors = spec, built, {}
        self.children = {}
        for a, b in spec["links"]:
            self.children.setdefault(a, []).append(b)
        publish()

    @staticmethod
    def _type(spec, bid):
        return next(b["type"] for b in spec["blocks"] if b["id"] == bid)

    @staticmethod
    def _check_acyclic(spec):
        children = {}
        for a, b in spec["links"]:
            children.setdefault(a, []).append(b)
        state = {}

        def visit(n):
            if state.get(n) == 1:
                raise ValueError("graph has a cycle through %s" % n)
            if state.get(n) == 2:
                return
            state[n] = 1
            for c in children.get(n, []):
                visit(c)
            state[n] = 2
        for b in spec["blocks"]:
            visit(b["id"])

    def close(self):
        for block in self.blocks.values():
            try:
                block.close()
            except Exception as err:
                lab.log("close %s: %s" % (block.id, err), "warn")

    def push(self, bid, x, rate):
        block = self.blocks[bid]
        block.samples_in += len(x)
        block.in_rate = rate
        try:
            out = block.work(x, rate)
        except Exception as err:
            if bid not in self.errors:
                lab.log("block %s: %s" % (bid, err), "error")
            self.errors[bid] = str(err)
            return
        if out is None:
            return
        y, out_rate = out
        block.samples_out += len(y)
        for child in self.children.get(bid, []):
            self.push(child, y, out_rate)

    def tick(self):
        if not self.running:
            return
        for block in list(self.blocks.values()):
            if block.kind != "source":
                continue
            try:
                chunk = block.produce()
            except Exception as err:
                self.errors[block.id] = str(err)
                continue
            if chunk is not None and len(chunk[0]):
                block.samples_out += len(chunk[0])
                for child in self.children.get(block.id, []):
                    self.push(child, chunk[0], chunk[1])


graph = Graph()


def publish():
    """Persist the graph into the device options and publish it as a value."""
    lab.emit({"type": "options", "options": {"graph": graph.spec}})
    lab.emit({"type": "value", "name": "graph", "value": graph.spec})


def stats():
    return {bid: {"type": next(s["type"] for s in graph.spec["blocks"] if s["id"] == bid), "in": b.samples_in,
                  "out": b.samples_out, "rate": b.in_rate, "error": graph.errors.get(bid)} for bid, b in graph.blocks.items()}


# ---- commands -------------------------------------------------------------------

bridge = lab.Bridge()


@bridge.command("blocks", "block catalog: kind, doc, params with defaults")
def blocks(_args):
    return {name: {"kind": cls.kind, "doc": cls.doc, "params": {k: {"default": v[0], "doc": v[1]} for k, v in cls.params.items()}}
            for name, cls in BLOCKS.items()}


@bridge.command("get_graph", "current graph")
def get_graph(_args):
    return graph.spec


@bridge.command("set_graph", "{graph: {blocks: [{id, type, params}], links: [[from, to]]}} replace the whole graph")
def set_graph(args):
    graph.load(args["graph"])
    return {"blocks": len(graph.blocks)}


@bridge.command("add_block", "{id, type, params, from?} add a block, optionally linked from an existing one")
def add_block(args):
    spec = json.loads(json.dumps(graph.spec))
    spec["blocks"].append({"id": args["id"], "type": args["type"], "params": args.get("params", {})})
    if args.get("from"):
        spec["links"].append([args["from"], args["id"]])
    graph.load(spec)
    return graph.spec


@bridge.command("remove_block", "{id} remove a block and its links")
def remove_block(args):
    spec = json.loads(json.dumps(graph.spec))
    spec["blocks"] = [b for b in spec["blocks"] if b["id"] != args["id"]]
    spec["links"] = [l for l in spec["links"] if args["id"] not in l]
    graph.load(spec)
    return graph.spec


@bridge.command("connect", "{from, to}")
def connect(args):
    spec = json.loads(json.dumps(graph.spec))
    spec["links"].append([args["from"], args["to"]])
    graph.load(spec)
    return graph.spec


@bridge.command("disconnect", "{from, to}")
def disconnect(args):
    spec = json.loads(json.dumps(graph.spec))
    spec["links"] = [l for l in spec["links"] if l != [args["from"], args["to"]]]
    graph.load(spec)
    return graph.spec


@bridge.command("set_param", "{block, key, value} change a parameter (the block restarts)")
def set_param(args):
    spec = json.loads(json.dumps(graph.spec))
    block = next((b for b in spec["blocks"] if b["id"] == args["block"]), None)
    if block is None:
        raise ValueError("unknown block: %s" % args["block"])
    block.setdefault("params", {})[args["key"]] = args["value"]
    graph.load(spec)
    return block


@bridge.command("run", "{on} pause / resume the graph")
def run(args):
    graph.running = lab.parse_switch(args["on"], "on")
    return {"running": graph.running}


@bridge.command("stats", "per-block samples in/out, rate, last error")
def get_stats(_args):
    return stats()


def publish_stats():
    lab.emit({"type": "value", "name": "stats", "value": stats()})


parser = argparse.ArgumentParser()
parser.add_argument("--graph", default="", help="initial graph JSON")
opts = parser.parse_args()
if opts.graph:
    try:
        graph.load(json.loads(opts.graph))
    except Exception as err:
        lab.log("initial graph rejected: %s" % err, "error")
lab.status("running")
bridge.every(TICK, graph.tick)
bridge.every(1.0, publish_stats)
try:
    bridge.run()
finally:
    graph.close()
