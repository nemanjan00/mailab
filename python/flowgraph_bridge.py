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
import socket
import time
import wave

import numpy as np

import liquid_dsp as dsp
import mailab_bridge as lab
import modem

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
    doc = ("RRC symbol timing recovery, one sample per symbol out. method liquid (polyphase, best for QAM64+) "
           "or gardner (matched filter + Gardner; use it for rectangular qam32, where the liquid loop mis-locks)")
    params = {"sps": (8, "samples per symbol"), "beta": (0.35, ""), "bandwidth": (0.02, "loop bandwidth (high-order QAM: 0.001-0.003)"),
              "method": ("liquid", "liquid | gardner")}

    def make(self, rate):
        sps = int(self.p["sps"])
        if self.p["method"] == "gardner":
            mf = dsp.MatchedFilter(sps, beta=float(self.p["beta"]))
            g = modem.Gardner(sps, float(self.p["bandwidth"]))
            return type("MfGardner", (), {"process": staticmethod(lambda x: g.process(mf.process(x)))})()
        return dsp.SymbolSync(sps, beta=float(self.p["beta"]), bandwidth=float(self.p["bandwidth"]))

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


# modem: bits, modulation, channel, recovery, bits out ------------------------

def _pattern_bits(pattern):
    """'hex:2dd4…' / 'text:hello' / 'bits:0110' -> one period of bits"""
    kind, _, body = pattern.partition(":")
    if kind == "hex":
        return modem.unpack_bits(bytes.fromhex(body))
    if kind == "text":
        return modem.unpack_bits(body.encode())
    if kind == "bits":
        return np.array([int(c) for c in body if c in "01"], dtype=np.uint8)
    raise ValueError("pattern must be prbsN, hex:…, text:… or bits:…")


class BitSource(Block):
    kind = "source"
    doc = "bits at `bitrate`: prbs7/9/15/23/31, or a repeated pattern (hex:… text:… bits:…), optionally behind a sync word"
    params = {"pattern": ("prbs9", "prbsN | hex:… | text:… | bits:…"), "bitrate": (9600, "bits per second"),
              "sync": ("", "hex sync word sent before each pattern period (framed mode)"), "preamble": ("", "hex preamble before the sync word")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        pattern = str(self.p["pattern"])
        self.prbs = modem.Prbs(int(pattern[4:])) if pattern.startswith("prbs") else None
        if not self.prbs:
            frame = _pattern_bits(pattern)
            head = np.zeros(0, dtype=np.uint8)
            for part in ("preamble", "sync"):
                if self.p[part]:
                    head = np.concatenate([head, modem.unpack_bits(bytes.fromhex(self.p[part]))])
            self.period = np.concatenate([head, frame])
            self.pos = 0
        self.t = time.monotonic()

    def produce(self):
        now = time.monotonic()
        rate = float(self.p["bitrate"])
        n = int((now - self.t) * rate)
        if n <= 0:
            return None
        self.t += n / rate
        if self.prbs:
            return self.prbs.bits(n), rate
        idx = (self.pos + np.arange(n)) % len(self.period)
        self.pos = int((self.pos + n) % len(self.period))
        return self.period[idx], rate


class Modulate(Block):
    doc = ("bits -> baseband IQ. Linear (liquid): bpsk qpsk psk8..256 dpsk* ask* qam4..256 apsk* ook pi4dqpsk V29 …; "
           "CPFSK: 2fsk 4fsk msk gfsk gmsk. Output rate = bitrate / bits-per-symbol * sps")
    params = {"scheme": ("qpsk", "modulation"), "sps": (8, "samples per symbol"), "beta": (0.35, "RRC roll-off (linear)"),
              "h": (None, "modulation index (CPFSK; default per scheme)"), "bt": (None, "Gaussian BT (gfsk/gmsk)")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        scheme = self.p["scheme"]
        if scheme in modem.CPFSK:
            self.mod = modem.CpfskModulator(scheme, int(self.p["sps"]), self.p["h"], self.p["bt"])
        else:
            self.mod = modem.LinearModulator(scheme, int(self.p["sps"]), float(self.p["beta"]))

    def work(self, x, rate):
        return self.mod.process(np.asarray(x, dtype=np.uint8)), rate / self.mod.bps * int(self.p["sps"])


class AnalogMod(Stateful):
    doc = "real audio -> AM / DSB / USB / LSB / FM / PM baseband"
    params = {"mode": ("fm", "am|dsb|usb|lsb|fm|pm"), "deviation": (5e3, "FM Hz"), "index": (0.8, "AM index / PM radians")}

    def make(self, rate):
        mode = self.p["mode"]
        if mode == "fm":
            return dsp.FmMod(float(self.p["deviation"]), rate)
        if mode == "pm":
            k = float(self.p["index"])
            return type("Pm", (), {"process": staticmethod(lambda m: np.exp(1j * k * np.asarray(m)).astype(np.complex64))})()
        kind = {"am": dsp.AM_DSB, "dsb": dsp.AM_DSB, "usb": dsp.AM_USB, "lsb": dsp.AM_LSB}[mode]
        return dsp.AmMod(kind, float(self.p["index"]), suppressed_carrier=mode != "am")

    def work(self, x, rate):
        return super().work(np.real(x), rate)


class Channel(Block):
    doc = "test channel: AWGN at snr_db (relative to signal power), carrier offset, phase, gain"
    params = {"snr_db": (20.0, ""), "cfo": (0.0, "Hz"), "phase": (0.0, "degrees"), "gain": (1.0, "")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.n = 0
        self.rng = np.random.default_rng()

    def work(self, x, rate):
        x = np.asarray(x, dtype=np.complex64) * float(self.p["gain"])
        k = np.arange(self.n, self.n + len(x))
        self.n += len(x)
        x = x * np.exp(1j * (2 * np.pi * float(self.p["cfo"]) / rate * k + np.radians(float(self.p["phase"]))))
        power = np.mean(np.abs(x) ** 2) or 1.0
        sigma = np.sqrt(power / 10 ** (float(self.p["snr_db"]) / 10) / 2)
        return (x + sigma * (self.rng.standard_normal(len(x)) + 1j * self.rng.standard_normal(len(x)))).astype(np.complex64), rate


class Discriminator(Block):
    doc = "FSK/FM discriminator -> real, scaled so CPFSK symbols are ±1 (±1/±3 for 4fsk); integrates over a symbol by default (fixes GMSK/GFSK ISI)"
    params = {"sps": (8, "samples per symbol"), "h": (1.0, "modulation index of the signal"), "integrate": (True, "average over one symbol")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.d = modem.Discriminator(int(self.p["sps"]), float(self.p["h"]), bool(self.p["integrate"]))

    def work(self, x, rate):
        return self.d.process(x), rate


class ClockRecovery(Block):
    doc = "Gardner timing recovery for real or complex input (FSK after discriminator, OOK magnitude): one sample per symbol out"
    params = {"sps": (8, "samples per symbol"), "bandwidth": (0.005, "loop gain"), "dc_block": (False, "remove the mean first (OOK)")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.g = modem.Gardner(float(self.p["sps"]), float(self.p["bandwidth"]), bool(self.p["dc_block"]))

    def work(self, x, rate):
        return self.g.process(x), rate / float(self.p["sps"])


class Slicer(Throttled):
    kind = "dsp"
    doc = ("symbols -> bits. Complex input: liquid demod of `scheme` (+ EVM -> channel <device>_<id>_evm). "
           "Real input: `levels` 2 (adaptive threshold) or 4 (4fsk gray)")
    params = {"scheme": ("qpsk", "linear scheme for complex input"), "levels": (2, "2|4 for real input"), "fps": (5, "EVM updates/s")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.modem = None
        self.levels = modem.LevelSlicer(int(self.p["levels"]))

    def work(self, x, rate):
        if np.iscomplexobj(x):
            if self.modem is None:
                self.modem = dsp.Modem(self.p["scheme"])
            bits, evm = modem.linear_demod_bits(self.modem, x, self.p["scheme"])
            if len(x) and self.due():
                lab.sample(self.id + "_evm", round(evm, 2), "dB")
            return bits, rate * self.modem.bps
        bits = self.levels.process(x)
        return bits, rate * (2 if int(self.p["levels"]) == 4 else 1)


class Ber(Throttled):
    kind = "sink"
    doc = "bit error rate against a PRBS (self-synchronizing, no alignment) -> channels <device>_<id> (BER) and _errors"
    params = {"prbs": (9, "PRBS order sent by the transmitter"), "window": (100000, "bits per BER estimate"), "fps": (2, "")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.check = modem.BerChecker(int(self.p["prbs"]))
        self.total_errors = 0.0

    def work(self, x, rate):
        self.check.feed(np.asarray(x, dtype=np.uint8))
        if self.check.checked >= int(self.p["window"]) or self.due():
            if self.check.checked:
                self.total_errors += self.check.errors / 3.0
                lab.sample(self.id, self.check.ber, "")
                lab.sample(self.id + "_errors", round(self.total_errors), "")
            self.check.reset()
        return None


class Framer(Block):
    kind = "sink"
    doc = "find a sync word in a bit stream, cut frames: value <device>_<id> (last frames: hex/ascii), blob of payloads, count channel"
    params = {"sync": ("2dd4", "sync word (hex)"), "max_errors": (0, "allowed bit errors in the sync word"),
              "frame_bytes": (16, "payload bytes after the sync word"), "keep": (20, "frames kept in the value")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.word = modem.unpack_bits(bytes.fromhex(self.p["sync"]))
        self.buf = np.zeros(0, dtype=np.uint8)
        self.frames = []
        self.count = 0
        self.payloads = b""

    def work(self, x, rate):
        self.buf = np.concatenate([self.buf, np.asarray(x, dtype=np.uint8)])
        need = len(self.word) + 8 * int(self.p["frame_bytes"])
        hits = [i for i in modem.find_sync(self.buf, self.word, int(self.p["max_errors"])) if i + need <= len(self.buf)]
        consumed = 0
        for i in hits:
            if i < consumed:
                continue
            payload = modem.pack_bits(self.buf[i + len(self.word):i + need])
            self.count += 1
            self.frames.append({"n": self.count, "t": time.time(), "hex": payload.hex(),
                                "ascii": "".join(chr(c) if 32 <= c < 127 else "." for c in payload)})
            self.payloads = (self.payloads + payload)[-65536:]
            consumed = i + need
        if hits:
            self.frames = self.frames[-int(self.p["keep"]):]
            lab.value(self.id, self.frames)
            lab.blob(self.id, self.payloads)
            lab.sample(self.id + "_count", self.count, "")
        # keep a tail long enough to hold a frame that straddles chunks
        self.buf = self.buf[max(consumed, len(self.buf) - need):]
        return None


class BitView(Throttled):
    kind = "sink"
    doc = "show a bit stream: value <device>_<id> with the last bits (binary + hex) and a running blob"
    params = {"bits": (256, "bits shown"), "fps": (4, "")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.buf = np.zeros(0, dtype=np.uint8)
        self.stream = b""

    def work(self, x, rate):
        self.buf = np.concatenate([self.buf, np.asarray(x, dtype=np.uint8)])
        if not self.due():
            return None
        whole = len(self.buf) - len(self.buf) % 8
        self.stream = (self.stream + modem.pack_bits(self.buf[:whole]))[-65536:]
        tail = self.buf[:whole][-int(self.p["bits"]):]
        self.buf = self.buf[whole:]
        lab.value(self.id, {"bitrate": rate, "bits": "".join(str(int(b)) for b in tail), "hex": modem.pack_bits(tail).hex()})
        lab.blob(self.id, self.stream)
        return None


class MatchedFilterBlock(Stateful):
    doc = "RRC receive (matched) filter, same sps/beta as the transmitter; then e.g. clock_recovery"
    params = {"sps": (8, ""), "beta": (0.35, "")}

    def make(self, rate):
        return dsp.MatchedFilter(int(self.p["sps"]), beta=float(self.p["beta"]))


class LevelTrigger(Block):
    doc = ("power squelch / level trigger: passes samples only while the level is above threshold_db (+ pretrigger, hold); "
           "each burst -> log, channel <device>_<id>_count, blob <device>_<id> (cf32 IQ) and trace <device>_<id>_burst (|x| dB)")
    params = {"threshold_db": (-30.0, "dBFS"), "pretrigger_ms": (2.0, ""), "hold_ms": (20.0, "stay open after the level drops"),
              "max_burst_ms": (2000.0, "cut very long bursts"), "pass": (True, "gate the stream to downstream blocks")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.history = np.zeros(0, dtype=np.complex64)
        self.burst = []
        self.open = False
        self.quiet = 0
        self.count = 0

    def finish(self, rate):
        data = np.concatenate(self.burst) if self.burst else np.zeros(0, dtype=np.complex64)
        self.burst, self.open = [], False
        if not len(data):
            return
        self.count += 1
        lab.log("%s: burst %d, %.1f ms, peak %.1f dBFS" % (self.id, self.count, len(data) / rate * 1e3,
                                                        10 * np.log10(np.max(np.abs(data) ** 2) + 1e-20)), "info")
        lab.sample(self.id + "_count", self.count, "")
        lab.event(self.id, {"burst": self.count, "ms": round(len(data) / rate * 1e3, 1),
                            "peak_dbfs": round(float(10 * np.log10(np.max(np.abs(data) ** 2) + 1e-20)), 1)})
        lab.blob(self.id, data.astype(np.complex64).tobytes())
        step = max(1, len(data) // 4000)
        env = 10 * np.log10(np.abs(data[::step]) ** 2 + 1e-20)
        lab.trace(self.id + "_burst", (np.arange(len(env)) * step / rate).tolist(), [{"label": "dBFS", "y": np.round(env, 2).tolist()}], "s", "dBFS")

    def work(self, x, rate):
        x = np.asarray(x, dtype=np.complex64)
        pre = int(float(self.p["pretrigger_ms"]) * rate / 1e3)
        hold = int(float(self.p["hold_ms"]) * rate / 1e3)
        limit = int(float(self.p["max_burst_ms"]) * rate / 1e3)
        above = 10 * np.log10(np.abs(x) ** 2 + 1e-20) > float(self.p["threshold_db"])
        passed = []
        if not self.open and np.any(above):
            first = int(np.argmax(above))
            self.open = True
            self.quiet = 0
            # pretrigger from history + this chunk before the edge
            self.burst = [np.concatenate([self.history, x[:first]])[-pre:] if pre else np.zeros(0, np.complex64)]
            x_rest, above_rest = x[first:], above[first:]
        else:
            x_rest, above_rest = x, above
        if self.open:
            last_above = np.nonzero(above_rest)[0]
            if len(last_above):
                self.quiet = len(above_rest) - 1 - int(last_above[-1])
            else:
                self.quiet += len(above_rest)
            self.burst.append(x_rest)
            passed.append(x_rest)
            if self.quiet > hold or sum(len(b) for b in self.burst) > limit:
                self.finish(rate)
        self.history = np.concatenate([self.history, x])[-max(pre, 1):]
        if self.p["pass"] and passed:
            return np.concatenate(passed), rate
        return None


class UartTx(Block):
    kind = "source"
    doc = "UART transmitter: text/hex -> line levels (idle high) at baud * sps; repeats every repeat_ms"
    params = {"text": ("hello mailab\r\n", "text to send (or use hex)"), "hex": ("", "bytes as hex"), "baud": (9600, ""),
              "bits": (8, "data bits"), "parity": ("none", "none|even|odd"), "stop": (1, "stop bits"),
              "sps": (8, "samples per bit (1 = bit stream)"), "repeat_ms": (500, "0 = send once")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        data = bytes.fromhex(self.p["hex"]) if self.p["hex"] else self.p["text"].encode().decode("unicode_escape").encode("latin1")
        frame = modem.uart_encode(data, int(self.p["bits"]), self.p["parity"], int(self.p["stop"]))
        self.frame = np.repeat(frame, int(self.p["sps"])).astype(np.float32)
        self.rate = float(self.p["baud"]) * int(self.p["sps"])
        self.queue = self.frame.copy()
        self.t = time.monotonic()
        self.next_send = self.t + float(self.p["repeat_ms"]) / 1000

    def produce(self):
        now = time.monotonic()
        n = int((now - self.t) * self.rate)
        if n <= 0:
            return None
        self.t += n / self.rate
        if not len(self.queue) and float(self.p["repeat_ms"]) > 0 and now >= self.next_send:
            self.queue = self.frame.copy()
            self.next_send = now + float(self.p["repeat_ms"]) / 1000
        out = np.ones(n, dtype=np.float32)
        take = min(n, len(self.queue))
        out[:take] = self.queue[:take]
        self.queue = self.queue[take:]
        return out, self.rate


class UartRx(Block):
    kind = "sink"
    doc = ("UART receiver on line levels (logic or analog, any oversampling) or bits: bytes -> value <device>_<id> "
           "(text + hex), blob, and each text line into the device log (for classifiers/notifications); error count channel")
    params = {"baud": (9600, ""), "bits": (8, ""), "parity": ("none", "none|even|odd"), "stop": (1, ""), "invert": (False, "")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.decoder = None
        self.line = b""
        self.history = b""
        self.errors = 0

    def work(self, x, rate):
        if self.decoder is None:
            sps = rate / float(self.p["baud"])
            self.decoder = modem.UartDecoder(sps, int(self.p["bits"]), self.p["parity"], int(self.p["stop"]), bool(self.p["invert"]))
        got = self.decoder.process(np.real(x))
        if not got:
            return None
        for byte, error in got:
            if error:
                self.errors += 1
            self.line += bytes([byte])
            if byte == 10:
                text = self.line.decode("utf8", "replace").rstrip("\r\n")
                if text:
                    lab.log(self.id + ": " + text, "uart")
                self.line = b""
        data = bytes(b for b, _ in got)
        self.history = (self.history + data)[-4096:]
        lab.value(self.id, {"text": self.history.decode("utf8", "replace")[-1024:], "hex": self.history[-64:].hex(),
                            "bytes": len(self.history), "errors": self.errors})
        lab.blob(self.id, self.history)
        lab.sample(self.id + "_errors", self.errors, "")
        return None


class Python(Block):
    doc = "scriptable block: params.code defines work(x, rate) -> y or (y, rate); np, dsp, modem, lab (sample/log/event/value/blob) and state are in scope"
    params = {"code": ("def work(x, rate):\n    return x * 2", "python source")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        scope = {"np": np, "dsp": dsp, "modem": modem, "lab": lab, "state": {}}
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


def measure(y, rate):
    """Scope-style measurements of a real waveform."""
    y = np.asarray(y, dtype=np.float64)
    if len(y) < 2:
        return {}
    vmax, vmin = float(np.max(y)), float(np.min(y))
    mid = (vmax + vmin) / 2
    hyst = (vmax - vmin) * 0.05
    out = {"vpp": vmax - vmin, "vmax": vmax, "vmin": vmin, "mean": float(np.mean(y)),
           "vrms": float(np.sqrt(np.mean(y ** 2))), "freq": None, "period": None, "duty": None}
    # rising crossings of the mid level, with hysteresis against noise
    state = y[0] > mid
    rises = []
    for i, v in enumerate(y):
        if state and v < mid - hyst:
            state = False
        elif not state and v > mid + hyst:
            state = True
            rises.append(i)
    if len(rises) >= 2 and vmax - vmin > 0:
        period = (rises[-1] - rises[0]) / (len(rises) - 1) / rate
        span = y[rises[0]:rises[-1]]
        out.update(freq=1.0 / period, period=period, duty=float(np.mean(span > mid)))
    return out


MEASURE_UNITS = {"vpp": "V", "vmax": "V", "vmin": "V", "mean": "V", "vrms": "V", "freq": "Hz", "period": "s", "duty": ""}


class Scope(Throttled):
    doc = ("oscilloscope -> trace <device>_<id>: trigger (rising/falling, level, auto/normal, pretrigger), "
           "traces live/max/min/avg, measurements (vpp vmax vmin mean vrms freq period duty) -> channels <device>_<id>_<m>")
    params = {"samples": (1000, "samples per capture"), "part": ("real", "real|imag|mag for complex input"),
              "trigger": ("rising", "rising|falling|none"), "level": (0.0, "trigger level"),
              "mode": ("auto", "auto (free-run without trigger) | normal (hold last trigger)"),
              "pretrigger": (0.1, "fraction of the capture before the trigger"),
              "traces": (["live"], "any of live, max, min, avg"), "average": (8, "captures in the avg trace"),
              "measure": (["vpp", "freq"], "measurements to publish as channels"), "fps": (10, "")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.buf = np.zeros(0, np.float32)
        self.hold = None
        self.last = None

    def part(self, x):
        if not np.iscomplexobj(x):
            return np.asarray(x, dtype=np.float32)
        return {"real": x.real, "imag": x.imag, "mag": np.abs(x)}[self.p["part"]].astype(np.float32)

    def triggered(self, n):
        """index where the capture starts, or None"""
        pre = int(n * float(self.p["pretrigger"]))
        y = self.buf
        if self.p["trigger"] == "none":
            return len(y) - n if len(y) >= n else None
        level = float(self.p["level"])
        a, b = y[pre:len(y) - (n - pre) - 1], y[pre + 1:len(y) - (n - pre)]
        if self.p["trigger"] == "falling":
            hits = np.nonzero((a > level) & (b <= level))[0]
        else:
            hits = np.nonzero((a < level) & (b >= level))[0]
        if not len(hits):
            return None
        # latest trigger keeps the display current
        return int(hits[-1]) + 1

    def work(self, x, rate):
        n = int(self.p["samples"])
        self.buf = np.concatenate([self.buf, self.part(x)])[-n * 8:]
        if not self.due() or len(self.buf) < n:
            return None
        start = self.triggered(n)
        if start is None:
            if self.p["mode"] == "normal":
                return None
            start = len(self.buf) - n
        capture = self.buf[start:start + n]
        alpha = 1.0 / max(1, int(self.p["average"]))
        if self.hold is None or len(self.hold["max"]) != n:
            self.hold = {"max": capture.copy(), "min": capture.copy(), "avg": capture.astype(np.float64)}
        self.hold["max"] = np.maximum(self.hold["max"], capture)
        self.hold["min"] = np.minimum(self.hold["min"], capture)
        self.hold["avg"] = self.hold["avg"] + alpha * (capture - self.hold["avg"])
        curves = {"live": capture, "max": self.hold["max"], "min": self.hold["min"], "avg": self.hold["avg"]}
        labels = {"live": "live", "max": "max hold", "min": "min hold", "avg": "avg %d" % int(self.p["average"])}
        pre = int(n * float(self.p["pretrigger"])) if self.p["trigger"] != "none" else 0
        t = ((np.arange(n) - pre) / rate).tolist()
        series = [{"label": labels[k], "y": np.round(curves[k], 5).tolist()} for k in self.p["traces"]]
        values = measure(capture, rate)
        measurements = [{"name": k, "value": values.get(k), "unit": MEASURE_UNITS.get(k, "")} for k in MEASURE_UNITS]
        lab.emit({"type": "trace", "name": self.id, "x": t, "series": series, "xUnit": "s", "yUnit": "V",
                  "mode": "line", "measurements": measurements})
        for k in self.p["measure"]:
            if values.get(k) is not None:
                lab.sample(self.id + "_" + k, round(values[k], 9), MEASURE_UNITS.get(k, ""))
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

# network IQ ---------------------------------------------------------------

def _decode_iq(data, fmt):
    """raw bytes -> complex64; returns (samples, leftover bytes)"""
    size = {"cf32": 8, "cs16": 4, "cu8": 2}[fmt]
    usable = len(data) - len(data) % size
    raw, rest = data[:usable], data[usable:]
    if fmt == "cf32":
        return np.frombuffer(raw, dtype=np.complex64).copy(), rest
    if fmt == "cs16":
        v = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    else:
        v = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 127.5) / 127.5
    return (v[0::2] + 1j * v[1::2]).astype(np.complex64), rest


def _encode_iq(x, fmt):
    x = np.asarray(x, dtype=np.complex64)
    if fmt == "cf32":
        return x.tobytes()
    inter = np.empty(len(x) * 2, dtype=np.float32)
    inter[0::2], inter[1::2] = x.real, x.imag
    if fmt == "cs16":
        return (np.clip(inter, -1, 1) * 32767).astype("<i2").tobytes()
    return (np.clip(inter * 127.5 + 127.5, 0, 255)).astype(np.uint8).tobytes()


class _NetEndpoint:
    """tcp-server (one client at a time), tcp-client or udp; all non-blocking."""

    def __init__(self, p, receiving):
        self.mode, self.host, self.port = p["mode"], p["host"], int(p["port"])
        self.conn = None
        self.peer = None
        if self.mode == "tcp-server":
            self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.listener.bind((self.host, self.port))
            self.listener.listen(1)
            self.listener.setblocking(False)
        elif self.mode == "udp":
            self.conn = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.conn.setblocking(False)
            if receiving:
                self.conn.bind((self.host, self.port))
            else:
                self.peer = (self.host, self.port)
        elif self.mode != "tcp-client":
            raise ValueError("mode must be tcp-server, tcp-client or udp")

    def ready(self):
        if self.conn is not None:
            return True
        try:
            if self.mode == "tcp-server":
                self.conn, addr = self.listener.accept()
                lab.log("net: client %s:%d connected" % addr)
            else:
                self.conn = socket.create_connection((self.host, self.port), timeout=0.2)
                lab.log("net: connected to %s:%d" % (self.host, self.port))
            self.conn.setblocking(False)
            return True
        except (BlockingIOError, OSError):
            self.conn = None
            return False

    def dropped(self):
        if self.mode != "udp" and self.conn is not None:
            self.conn.close()
            self.conn = None
            lab.log("net: peer disconnected", "warn")

    def recv(self):
        if not self.ready():
            return b""
        chunks = []
        while True:
            try:
                data = self.conn.recv(1 << 16)
            except BlockingIOError:
                break
            except OSError:
                self.dropped()
                break
            if not data:
                if self.mode != "udp":
                    self.dropped()
                break
            chunks.append(data)
        return b"".join(chunks)

    def send(self, data):
        if not self.ready():
            return
        try:
            if self.mode == "udp":
                # keep datagrams under a typical MTU-friendly size
                for i in range(0, len(data), 8192):
                    self.conn.sendto(data[i:i + 8192], self.peer)
            else:
                self.conn.sendall(data)
        except (BlockingIOError, BrokenPipeError, ConnectionResetError, OSError):
            self.dropped()

    def close(self):
        for s in (self.conn, getattr(self, "listener", None)):
            if s is not None:
                s.close()


NET_PARAMS = {"mode": ("tcp-server", "tcp-server|tcp-client|udp"), "host": ("127.0.0.1", "bind (server/udp in) or remote host"),
              "port": (5600, ""), "format": ("cf32", "cf32|cs16|cu8 interleaved I/Q")}


class NetSource(Block):
    kind = "source"
    doc = "IQ in over TCP/UDP (raw interleaved cf32/cs16/cu8), e.g. from GNU Radio, SDR++ or rtl_tcp-like streams"
    params = dict(NET_PARAMS, rate=(1e6, "sample rate of the incoming stream"))

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.net = _NetEndpoint(self.p, receiving=True)
        self.rest = b""

    def produce(self):
        data = self.rest + self.net.recv()
        if not data:
            return None
        x, self.rest = _decode_iq(data, self.p["format"])
        return x, float(self.p["rate"])

    def close(self):
        self.net.close()


class NetSink(Block):
    kind = "sink"
    doc = "IQ out over TCP/UDP (raw interleaved cf32/cs16/cu8)"
    params = dict(NET_PARAMS)

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.net = _NetEndpoint(self.p, receiving=False)

    def work(self, x, rate):
        self.net.send(_encode_iq(x, self.p["format"]))
        return None

    def close(self):
        self.net.close()



BLOCKS = {
    "signal": SignalSource, "modulated": ModulatedSource, "file": FileSource, "soapy": SoapySource,
    "shift": Shift, "resample": Resample, "lowpass": Lowpass, "agc": Agc, "fm_demod": FmDemod, "am_demod": AmDemod,
    "symbol_sync": SymbolSync, "carrier_recovery": CarrierRecovery, "demod": Demod, "mag": Mag, "decimate": Decimate,
    "python": Python,
    "spectrum": Spectrum, "constellation": Constellation, "eye": Eye, "scope": Scope, "measure": Measure,
    "audio": Audio, "wav": Wav, "net_source": NetSource, "net_sink": NetSink,
    "bits": BitSource, "mod": Modulate, "analog_mod": AnalogMod, "channel": Channel, "discriminator": Discriminator,
    "clock_recovery": ClockRecovery, "slicer": Slicer, "ber": Ber, "framer": Framer, "bitview": BitView,
    "matched_filter": MatchedFilterBlock, "level_trigger": LevelTrigger, "uart_tx": UartTx, "uart_rx": UartRx,
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
