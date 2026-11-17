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
import collections
import hashlib
import json
import os
import socket
import struct
import subprocess
import time
import wave

import numpy as np

import audio_blocks
import liquid_dsp as dsp
import mailab_bridge as lab
import modem
import ofdm
import protocol_decode as pdec

TICK = 0.02


# ---- TX band gate (soapy_sink) ------------------------------------------------
# The final allow-list (lab region + MAILAB_RF_TX_EXTRA, already intersected
# with device options) arrives as --tx-bands-final; --chamber (set by the lab
# driver under MAILAB_RF_CHAMBER / MAILAB_UNSAFE) skips the check. This is the
# second line of defense - the lab's shared TX policy (src/txpolicy) is the first.
TX_BANDS = []
TX_CHAMBER = False


def _parse_bands(text):
    bands = []
    for part in str(text).split(","):
        part = part.strip()
        if not part:
            continue
        cut = part.index("-", 1)
        lo, hi = lab.parse_number(part[:cut], "tx band"), lab.parse_number(part[cut + 1:], "tx band")
        if lo >= hi:
            raise ValueError("tx band %r: lo must be below hi" % part)
        bands.append((lo, hi))
    return bands


def _tx_bands_check(freq_hz, half_bw):
    if TX_CHAMBER:
        return
    lo, hi = freq_hz - half_bw, freq_hz + half_bw
    for blo, bhi in TX_BANDS:
        if blo <= lo and hi <= bhi:
            return
    raise ValueError("TX refused: %.6f MHz (+-%.1f kHz) is outside the allowed bands (%s)"
                     % (freq_hz / 1e6, half_bw / 1e3,
                        ", ".join("%.3f-%.3f MHz" % (b[0] / 1e6, b[1] / 1e6) for b in TX_BANDS) or "none"))


# ---- block library ------------------------------------------------------------

class Block:
    kind = "dsp"          # source | dsp | sink
    params = {}           # name -> (default, doc)
    doc = ""
    inputs = ""           # what the block expects (catalog / docs; "" for sources)
    outputs = ""          # what it produces: downstream stream and/or lab traces, channels, values...

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
    inputs = ""
    outputs = "complex IQ at `rate`"
    kind = "source"
    doc = "complex tone plus noise"
    params = {"rate": (100e3, "sample rate"), "freq": (10e3, "tone Hz"), "amp": (1.0, "tone amplitude (1.0 = 0 dBFS)"), "noise": (0.01, "noise rms")}

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
    inputs = ""
    outputs = "complex IQ at `rate` (RRC-shaped symbols, `sps` samples each)"
    kind = "source"
    doc = "random symbols, RRC-shaped (test signal for constellation/eye/demod)"
    params = {"scheme": ("qpsk", "bpsk|qpsk|psk8|qam16|qam64|apsk16..."), "rate": (100e3, "sample rate"),
              "sps": (8, "samples per symbol"), "beta": (0.35, "RRC roll-off"), "snr_db": (25.0, "AWGN SNR in dB (relative to signal power)"),
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


def _media_path(path, must_exist=True):
    """resolve a media path; only inside MAILAB_MEDIA_ROOTS (set by mailab, not by device options),
    so an AI's graph can't read or overwrite arbitrary files"""
    roots = [os.path.realpath(r) for r in os.environ.get("MAILAB_MEDIA_ROOTS", "").split(":") if r]
    real = os.path.realpath(str(path))
    if not os.path.isabs(str(path)) or not any(real == r or real.startswith(r + os.sep) for r in roots):
        raise ValueError("file paths must be inside " + (", ".join(roots) or "the media dirs") + " (MAILAB_MEDIA_DIRS)")
    if must_exist and not os.path.isfile(real):
        raise ValueError("no such file: " + str(path))
    return real


class FileSource(Block):
    inputs = ""
    outputs = "complex IQ at `rate` (cf32 samples from the file)"
    kind = "source"
    doc = "raw cf32 IQ file, played back in real time"
    params = {"path": ("", "cf32 file inside DATA_DIR/media or MAILAB_MEDIA_DIRS"), "rate": (1e6, "sample rate"), "loop": (True, "restart at the end of the file (false = stop)")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.data = np.fromfile(_media_path(self.p["path"]), dtype=np.complex64)
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


class AudioFileSource(Block):
    inputs = ""
    outputs = "real audio at `rate` (carried as complex with zero imaginary part)"
    kind = "source"
    doc = "audio file (wav/flac/mp3/ogg/… or a video's audio, decoded by ffmpeg) as real float samples"
    params = {"path": ("", "file inside DATA_DIR/media or MAILAB_MEDIA_DIRS"), "rate": (48000, "output sample rate"),
              "channel": (0, "channel to take (0 = mix down to mono)"), "loop": (True, "restart at the end of the file (false = stop)"),
              "realtime": (True, "pace like a live source; false = as fast as the graph runs"), "gain": (1.0, "linear gain applied to the samples")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        path = _media_path(self.p["path"])
        rate = int(float(self.p["rate"]))
        ch = int(self.p["channel"])
        # mono mix or one channel picked with the pan filter
        af = ["-ac", "1"] if ch <= 0 else ["-af", "pan=mono|c0=c%d" % (ch - 1)]
        out = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe",
                              "-i", "file:" + path, "-vn"] + af + ["-ar", str(rate), "-f", "f32le", "pipe:1"],
                             capture_output=True, timeout=120)
        if out.returncode != 0:
            raise ValueError("ffmpeg: " + out.stderr.decode(errors="replace").strip()[-300:])
        self.data = (np.frombuffer(out.stdout, dtype="<f4") * float(self.p["gain"])).astype(np.complex64)
        self.rate_out = float(rate)
        self.pos = 0
        self.t = time.monotonic()

    def produce(self):
        if not len(self.data):
            return None
        if self.p["realtime"]:
            now = time.monotonic()
            count = int((now - self.t) * self.rate_out)
            if count <= 0:
                return None
            self.t += count / self.rate_out
        else:
            count = int(self.rate_out * TICK)
        out = self.data[self.pos:self.pos + count]
        self.pos += count
        if self.pos >= len(self.data):
            if self.p["loop"]:
                self.pos = 0
            elif not len(out):
                return None
        return out, self.rate_out


class SoapySource(Block):
    inputs = ""
    outputs = "complex IQ at `rate` (baseband around `freq`)"
    kind = "source"
    doc = "SoapySDR receiver (bladeRF, HackRF, RTL-SDR...)"
    params = {"args": ("", "e.g. driver=bladerf"), "freq": (100e6, "center frequency Hz"), "rate": (2e6, "sample rate"), "gain": (30.0, "RX gain dB (overall, driver distributes it)")}

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


class SoapySink(Block):
    inputs = "complex IQ at `rate` (baseband around `freq`)"
    outputs = ""
    kind = "sink"
    doc = ("SoapySDR transmitter (bladeRF, HackRF, ...). Gated twice: the lab refuses to start a graph "
           "with a soapy_sink outside the TX policy (band allow-list, gain/time caps, approval, auto-stop), "
           "and the bridge re-checks the band here unless --chamber was passed")
    params = {"args": ("", "e.g. driver=bladerf"), "freq": (100e6, "center frequency Hz"),
              "rate": (2e6, "sample rate"), "gain": (30.0, "TX gain dB (overall, driver distributes it)")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        import SoapySDR
        from SoapySDR import SOAPY_SDR_TX, SOAPY_SDR_CF32
        _tx_bands_check(float(self.p["freq"]), float(self.p["rate"]) / 2.0)
        self.sdr = SoapySDR.Device(self.p["args"])
        self.sdr.setSampleRate(SOAPY_SDR_TX, 0, float(self.p["rate"]))
        self.sdr.setFrequency(SOAPY_SDR_TX, 0, float(self.p["freq"]))
        self.sdr.setGain(SOAPY_SDR_TX, 0, float(self.p["gain"]))
        self.stream = self.sdr.setupStream(SOAPY_SDR_TX, SOAPY_SDR_CF32)
        self.sdr.activateStream(self.stream)

    def work(self, x, rate):
        x = np.ascontiguousarray(x, dtype=np.complex64)
        self.sdr.writeStream(self.stream, [x], len(x), timeoutUs=int(TICK * 1e6))
        return None

    def close(self):
        self.sdr.deactivateStream(self.stream)
        self.sdr.closeStream(self.stream)


class AudioIn(Block):
    inputs = ""
    outputs = "real audio in [-1, 1) at the lab stream's rate"
    kind = "source"
    doc = ("lab audio stream in (e.g. a browser mic <device>_mic, or another graph's audio sink): "
           "real samples in [-1, 1) at the stream's rate")
    params = {"stream": ("", "lab audio stream name"), "channel": ("mix", "stereo streams: mix|left|right"),
              "max_queue": (32, "chunks buffered before the oldest is dropped")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.queue = collections.deque(maxlen=max(1, int(self.p["max_queue"])))
        self.dropped = 0

    def feed(self, data, rate, channels):
        """int16 LE PCM bytes (interleaved when stereo) -> queued float32 mono"""
        x = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
        if channels == 2:
            x = x[:len(x) - len(x) % 2].reshape(-1, 2)
            x = {"left": x[:, 0], "right": x[:, 1]}.get(self.p["channel"], x.mean(axis=1))
        if len(self.queue) == self.queue.maxlen:
            self.dropped += 1
        self.queue.append((np.ascontiguousarray(x, dtype=np.float32), float(rate)))

    def produce(self):
        if not self.queue:
            return None
        chunks = list(self.queue)
        self.queue.clear()
        # a rate change mid-queue: keep the chunks at the newest rate
        rate = chunks[-1][1]
        return np.concatenate([c for c, r in chunks if r == rate]), rate


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
    inputs = "complex IQ"
    outputs = "complex IQ, same rate"
    doc = "move a signal at +offset Hz to baseband"
    params = {"offset": (0.0, "Hz")}

    def make(self, rate):
        return dsp.Mixer(float(self.p["offset"]), rate)


class Resample(Stateful):
    inputs = "complex IQ or real"
    outputs = "same kind at `rate`"
    doc = "arbitrary-rate resampler"
    params = {"rate": (48e3, "output sample rate")}

    def make(self, rate):
        return dsp.Resampler(float(self.p["rate"]) / rate)

    def out_rate(self, rate):
        return float(self.p["rate"])


class Lowpass(Stateful):
    inputs = "complex IQ or real"
    outputs = "same kind, same rate"
    doc = "Kaiser FIR low-pass"
    params = {"cutoff": (10e3, "Hz"), "taps": (63, "FIR length (more = sharper transition, more delay)")}

    def make(self, rate):
        return dsp.Lowpass(min(0.49, float(self.p["cutoff"]) / rate), int(self.p["taps"]))


class Agc(Stateful):
    inputs = "complex IQ"
    outputs = "complex IQ normalized to unit power, same rate"
    doc = "automatic gain control (normalizes to unit power)"
    params = {"bandwidth": (1e-3, "loop bandwidth")}

    def make(self, rate):
        return dsp.Agc(float(self.p["bandwidth"]))


class FmDemod(Stateful):
    inputs = "complex IQ (FM centered at 0 Hz)"
    outputs = "real audio, same rate"
    doc = "FM demodulator -> real audio"
    params = {"deviation": (5e3, "Hz")}

    def make(self, rate):
        return dsp.FmDemod(float(self.p["deviation"]), rate)


class AmDemod(Stateful):
    inputs = "complex IQ (AM/SSB centered at 0 Hz)"
    outputs = "real audio, same rate"
    doc = "AM/SSB demodulator -> real audio"
    params = {"mode": ("am", "am|usb|lsb")}

    def make(self, rate):
        return dsp.AmDemod({"am": dsp.AM_DSB, "usb": dsp.AM_USB, "lsb": dsp.AM_LSB}[self.p["mode"]])


class SymbolSync(Stateful):
    inputs = "complex IQ at `sps` samples per symbol (RRC-shaped)"
    outputs = "complex symbols, one per symbol (rate / sps)"
    doc = ("RRC symbol timing recovery, one sample per symbol out. method liquid (polyphase, best for QAM64+) "
           "or gardner (matched filter + Gardner; use it for rectangular qam32, where the liquid loop mis-locks)")
    params = {"sps": (8, "samples per symbol"), "beta": (0.35, "RRC roll-off (same as the transmitter)"), "bandwidth": (0.02, "loop bandwidth (high-order QAM: 0.001-0.003)"),
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
    inputs = "complex symbols (one sample per symbol)"
    outputs = "phase/frequency-corrected complex symbols"
    doc = "decision-directed PLL on symbols (removes carrier offset / phase)"
    params = {"scheme": ("qpsk", "constellation the decisions are made against (bpsk|qpsk|psk8|qam16...)"), "bandwidth": (0.02, "loop bandwidth")}

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
    inputs = "complex symbols (one sample per symbol)"
    outputs = "symbol indices (float); channel <device>_<id>_evm (dB)"
    kind = "dsp"
    doc = "symbol decisions + EVM; outputs symbol indices, EVM -> channel <device>_<id>_evm"
    params = {"scheme": ("qpsk", "constellation (bpsk|qpsk|psk8|qam16|qam64|apsk16...)"), "fps": (5, "EVM updates per second")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.modem = dsp.Modem(self.p["scheme"])

    def work(self, x, rate):
        symbols, evm = self.modem.demodulate(x)
        if len(x) and self.due():
            lab.sample(self.id + "_evm", round(evm, 2), "dB")
        return symbols.astype(np.float32), rate


class Mag(Block):
    inputs = "complex IQ or real"
    outputs = "real |x|, same rate"
    doc = "|x|"

    def work(self, x, rate):
        return np.abs(x).astype(np.float32), rate


class Decimate(Block):
    inputs = "any"
    outputs = "same kind at rate / n"
    doc = "keep every n-th sample (no filtering; put a lowpass first)"
    params = {"n": (10, "decimation factor (output rate = input rate / n)")}

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
    inputs = ""
    outputs = "bits (0/1 values) at `bitrate`"
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
    inputs = "bits (0/1)"
    outputs = "complex IQ at bitrate / bits-per-symbol * sps"
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
    inputs = "real audio (complex: real part)"
    outputs = "complex baseband IQ, same rate"
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
    inputs = "complex IQ (real input becomes complex)"
    outputs = "complex IQ, same rate"
    doc = "test channel: AWGN at snr_db (relative to signal power), carrier offset, phase, gain"
    params = {"snr_db": (20.0, "AWGN SNR in dB (relative to the signal power)"), "cfo": (0.0, "carrier frequency offset Hz"), "phase": (0.0, "degrees"), "gain": (1.0, "linear gain")}

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
    inputs = "complex IQ (FSK/FM at `sps` samples per symbol)"
    outputs = "real, ±1 per symbol level"
    doc = "FSK/FM discriminator -> real, scaled so CPFSK symbols are ±1 (±1/±3 for 4fsk); integrates over a symbol by default (fixes GMSK/GFSK ISI)"
    params = {"sps": (8, "samples per symbol"), "h": (1.0, "modulation index of the signal"), "integrate": (True, "average over one symbol")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.d = modem.Discriminator(int(self.p["sps"]), float(self.p["h"]), bool(self.p["integrate"]))

    def work(self, x, rate):
        return self.d.process(x), rate


class ClockRecovery(Block):
    inputs = "real or complex at `sps` samples per symbol"
    outputs = "one sample per symbol (rate / sps)"
    doc = "Gardner timing recovery for real or complex input (FSK after discriminator, OOK magnitude): one sample per symbol out"
    params = {"sps": (8, "samples per symbol"), "bandwidth": (0.005, "loop gain"), "dc_block": (False, "remove the mean first (OOK)")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.g = modem.Gardner(float(self.p["sps"]), float(self.p["bandwidth"]), bool(self.p["dc_block"]))

    def work(self, x, rate):
        return self.g.process(x), rate / float(self.p["sps"])


class Slicer(Throttled):
    inputs = "complex symbols (linear schemes) or real symbols (FSK)"
    outputs = "bits (0/1); channel <device>_<id>_evm for complex input"
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
    inputs = "bits (0/1) carrying the PRBS"
    outputs = "channels <device>_<id> (BER) and <device>_<id>_errors"
    kind = "sink"
    doc = "bit error rate against a PRBS (self-synchronizing, no alignment) -> channels <device>_<id> (BER) and _errors"
    params = {"prbs": (9, "PRBS order sent by the transmitter"), "window": (100000, "bits per BER estimate"), "fps": (2, "channel updates per second")}

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


class BaudEst(Throttled):
    inputs = "real discriminated FSK / FM or complex IQ"
    outputs = "value <device>_<id> (baud, rate)"
    kind = "sink"
    doc = "estimate the symbol rate of a 2-level FSK signal from level crossings: value <device>_<id> with the baud estimate"
    params = {"fps": (2, "value updates per second"),
              "window": (262144, "samples kept for the estimate")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.win = np.zeros(0)

    def work(self, x, rate):
        x = np.asarray(x)
        self.win = np.concatenate([self.win, x])[-int(self.p["window"]):]
        if not self.due() or not len(self.win):
            return None
        baud = modem.baud_estimate(self.win, rate)
        if baud is not None:
            lab.value(self.id, {"baud": round(float(baud), 1), "rate": rate})
        return None


class PacketDecode(Block):
    inputs = "bits (0/1) in on-air order (first bit first, each byte LSB first)"
    outputs = "value <device>_<id> (decoded packets, CRC-checked), channel <device>_<id>_count"
    kind = "sink"
    doc = "decode BLE advertising or nRF Enhanced ShockBurst packets out of a raw bit stream: value <device>_<id> with the last decoded packets + CRC status, count channel"
    params = {"protocol": ("ble", "ble (BLE advertising channels) or esb (nRF Enhanced ShockBurst)"),
              "channel": (37, "BLE channel index, used for dewhitening"),
              "address": ("e7e7e7e7e7", "ESB pipe address (hex, 3-5 bytes)"),
              "max_errors": (0, "allowed bit errors in the access address / sync word"),
              "keep": (20, "packets kept in the value")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        if self.p["protocol"] not in ("ble", "esb"):
            raise ValueError("protocol must be ble or esb")
        if self.p["protocol"] == "ble":
            self.word = modem.unpack_bits_lsb(modem.BLE_ADV_AA.to_bytes(4, "little"))
        else:
            addr = bytes.fromhex(self.p["address"])
            if not 3 <= len(addr) <= 5:
                raise ValueError("address must be 3-5 bytes of hex")
            self.word = modem.unpack_bits_lsb(addr)
        self.buf = np.zeros(0, dtype=np.uint8)
        self.next_scan = 0
        self.packets = []
        self.count = 0

    def _ble_at(self, i):
        """Try one BLE PDU at buf index i. -> (pkt, consumed) or None when the
        buffer does not hold the whole PDU yet."""
        body = self.buf[i + len(self.word):]
        if len(body) < 16 + 24:
            return None
        white = modem.ble_white_bits(body, int(self.p["channel"]))
        header = modem.pack_bits_lsb(white[:16])
        if len(header) < 2:
            return None
        length = header[1] & 0x3F
        need = 16 + 8 * (length + 3)
        if len(white) < need:
            return None
        pdu = modem.pack_bits_lsb(white[:16 + 8 * length])
        got_crc = int.from_bytes(modem.pack_bits_lsb(white[16 + 8 * length:need]), "little")
        pkt = {"protocol": "ble", "pdu_type": header[0] & 0x0F, "length": length,
               "crc_ok": modem.crc24_ble(pdu) == got_crc, "t": time.time(),
               "payload": pdu[2:].hex(), "addr": pdu[2:8].hex() if length >= 6 else None}
        return pkt, len(self.word) + need

    def _esb_at(self, i):
        """Try one ESB packet at buf index i. -> (pkt, consumed) or None when
        the buffer does not hold the whole packet yet."""
        rest = self.buf[i + len(self.word):]
        if len(rest) < 9:
            return None
        pcf = 0
        for k in range(9):
            pcf |= int(rest[k]) << k
        length, pid, noack = pcf & 0x3F, (pcf >> 6) & 0x03, (pcf >> 8) & 1
        need = 9 + 8 * (length + 1)
        if len(rest) < need:
            return None
        payload = modem.pack_bits_lsb(rest[9:9 + 8 * length])
        got_crc = modem.pack_bits_lsb(rest[9 + 8 * length:need])[0]
        addr = bytes.fromhex(self.p["address"])
        want = modem.esb_crc8(addr + bytes([pcf & 0xFF, (pcf >> 8) & 1]) + payload)
        pkt = {"protocol": "esb", "pid": pid, "noack": noack, "length": length,
               "crc_ok": want == got_crc, "t": time.time(), "payload": payload.hex()}
        return pkt, len(self.word) + need

    def work(self, x, rate):
        self.buf = np.concatenate([self.buf, np.asarray(x, dtype=np.uint8)])
        if len(self.buf) > 262144:
            drop = len(self.buf) - 262144
            self.buf = self.buf[drop:]
            self.next_scan = max(0, self.next_scan - drop)
        decode = self._ble_at if self.p["protocol"] == "ble" else self._esb_at
        me = int(self.p["max_errors"])
        while True:
            window = self.buf[self.next_scan:]
            if len(window) < len(self.word):
                break
            hits = modem.find_sync(window, self.word, me)
            if not hits:
                self.next_scan = max(0, len(self.buf) - len(self.word))
                break
            i = self.next_scan + hits[0]
            got = decode(i)
            if got is None:
                break  # wait for more samples
            pkt, consumed = got
            self.next_scan = i + consumed
            self.count += 1
            self.packets.append(pkt)
        if self.packets:
            self.packets = self.packets[-int(self.p["keep"]):]
            lab.value(self.id, self.packets)
            lab.sample(self.id + "_count", self.count, "")
        return None


class Framer(Block):
    inputs = "bits (0/1)"
    outputs = "value <device>_<id> (frames: n, t, hex, ascii), blob <device>_<id> (payloads), channel <device>_<id>_count"
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
    inputs = "bits (0/1)"
    outputs = "value <device>_<id> (bitrate, bits, hex), blob <device>_<id>"
    kind = "sink"
    doc = "show a bit stream: value <device>_<id> with the last bits (binary + hex) and a running blob"
    params = {"bits": (256, "bits shown"), "fps": (4, "value updates per second")}

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
    inputs = "complex IQ at `sps` samples per symbol"
    outputs = "complex IQ, same rate"
    doc = "RRC receive (matched) filter, same sps/beta as the transmitter; then e.g. clock_recovery"
    params = {"sps": (8, "samples per symbol (as the transmitter)"), "beta": (0.35, "RRC roll-off (as the transmitter)")}

    def make(self, rate):
        return dsp.MatchedFilter(int(self.p["sps"]), beta=float(self.p["beta"]))


class LevelTrigger(Block):
    inputs = "complex IQ or real"
    outputs = "gated samples while a burst is open (`pass`); per burst: log line, event + blob <device>_<id> (cf32), trace <device>_<id>_burst (dBFS envelope), channel <device>_<id>_count"
    doc = ("power squelch / level trigger: passes samples only while the level is above threshold_db (+ pretrigger, hold); "
           "each burst -> log, channel <device>_<id>_count, blob <device>_<id> (cf32 IQ) and trace <device>_<id>_burst (|x| dB)")
    params = {"threshold_db": (-30.0, "dBFS"), "pretrigger_ms": (2.0, "samples kept from before the trigger"), "hold_ms": (20.0, "stay open after the level drops"),
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
    inputs = ""
    outputs = "real line levels (1 = idle/mark) at baud * sps"
    kind = "source"
    doc = "UART transmitter: text/hex -> line levels (idle high) at baud * sps; repeats every repeat_ms"
    params = {"text": ("hello mailab\r\n", "text to send (or use hex)"), "hex": ("", "bytes as hex"), "baud": (9600, "bit rate"),
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
    inputs = "real line levels (any oversampling) or bits"
    outputs = "value <device>_<id> (text, hex, bytes, errors), blob <device>_<id>, device log line per text line, channel <device>_<id>_errors"
    kind = "sink"
    doc = ("UART receiver on line levels (logic or analog, any oversampling) or bits: bytes -> value <device>_<id> "
           "(text + hex), blob, and each text line into the device log (for classifiers/notifications); error count channel")
    params = {"baud": (9600, "bit rate (oversampling = input rate / baud)"), "bits": (8, "data bits"), "parity": ("none", "none|even|odd"), "stop": (1, "stop bits"), "invert": (False, "inverted line (idle low, e.g. RS-232 levels)")}

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


class Decode(Throttled):
    inputs = "logic words (bit k = channel k) or analog/real (thresholded into channel 0)"
    outputs = "value <device>_<id> (annotation table), event <device>_<id>, log lines, blob <device>_<id> (data bytes), channel <device>_<id>_count"
    kind = "sink"
    doc = ("protocol decoder on logic samples (bit k of each input word = channel k; analog/float input is thresholded "
           "into channel 0): libsigrokdecode decoder scripts (uart spi i2c can onewire_link spiflash... any installed id, "
           "stack for stacked decoders) or builtin numpy uart/spi/i2c/manchester. Annotations -> value <device>_<id> "
           "(table of the last rows), event <device>_<id>, log lines per class, blob of decoded data bytes, count channel")
    params = {"decoder": ("uart", "decoder id (sigrok id or builtin uart|spi|i2c|manchester)"),
              "engine": ("auto", "auto (sigrok if installed, else builtin) | sigrok | builtin"),
              "options": ({}, "decoder options, sigrok names, e.g. {baudrate: 9600, parity: 'even'} / {cpol, cpha} / {bitrate, convention}"),
              "channels": ({}, "decoder channel -> input bit, e.g. {clk: 0, mosi: 1, cs: 3} (default per decoder)"),
              "stack": ([], "stacked decoders, e.g. ['spiflash'] or [{id, options}]"),
              "samplerate": (0, "Hz; 0 = the input stream rate"), "threshold": (None, "analog threshold (default adaptive)"),
              "annotations": ([], "annotation classes kept (default all but per-bit ones)"),
              "keep": (200, "rows kept in the value"), "fps": (4, "value/event updates per second")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.dec = None
        self.rows = []
        self.new = []
        self.count = 0
        self.data = b""
        self.reported_error = None

    def accept(self, ann):
        wanted = self.p["annotations"]
        if wanted:
            return ann["class"] in wanted or "%s=%s" % (ann["decoder"], ann["class"]) in wanted
        return not ann["class"].endswith("bit") and not ann["class"].endswith("-bits")

    def work(self, x, rate):
        if self.dec is None:
            r = float(self.p["samplerate"]) or rate
            self.dec = pdec.ProtocolDecoder(self.p["decoder"], r, options=self.p["options"], channels=self.p["channels"],
                                            engine=self.p["engine"], stack=self.p["stack"], threshold=self.p["threshold"])
            lab.log("%s: %s decoder %s at %g Hz, channels %s" % (self.id, self.dec.engine, self.p["decoder"], r, self.dec.channels))
        self.consume(self.dec.feed(x))
        return None

    def consume(self, anns):
        if self.dec.error and self.dec.error != self.reported_error:
            self.reported_error = self.dec.error
            lab.log("%s: decoder stopped: %s" % (self.id, self.dec.error), "error")
        anns = [a for a in anns if self.accept(a)]
        self.new += anns
        self.count += len(anns)
        self.data = (self.data + pdec.data_bytes(anns))[-65536:]
        if self.new and self.due():
            self.publish()

    def publish(self):
        new, self.new = self.new, []
        self.rows = (self.rows + new)[-int(self.p["keep"]):]
        by_class = {}
        for a in new:
            by_class.setdefault((a["decoder"], a["class"]), []).append(a["text"])
        for (decoder, cls), texts in by_class.items():
            lab.log("%s: %s %s: %s" % (self.id, decoder, cls, " ".join(texts[:64]) + (" …" if len(texts) > 64 else "")), "decode")
        lab.value(self.id, {"decoder": self.p["decoder"], "engine": self.dec.engine, "count": self.count,
                            "error": self.dec.error, "columns": ["t", "decoder", "class", "text", "ss", "es"], "rows": self.rows})
        lab.event(self.id, {"decoder": self.p["decoder"], "new": len(new), "count": self.count,
                            "last": [a["text"] for a in new[-8:]]})
        lab.sample(self.id + "_count", self.count, "")
        if self.data:
            lab.blob(self.id, self.data)

    def close(self):
        if self.dec is not None:
            self.consume(self.dec.flush())
            if self.new:
                self.publish()


class Python(Block):
    inputs = "anything"
    outputs = "whatever work() returns (default: same rate)"
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
    inputs = "complex IQ or real"
    outputs = "trace <device>_<id> (Hz vs dBFS, one series per `traces` entry)"
    doc = ("spectrum analyzer -> trace <device>_<id> (dBFS): RBW or FFT size, window, "
           "traces live / max / min / avg (power average over `average` frames), display points with peak/sample detector")
    params = {"rbw": (0.0, "resolution bandwidth Hz (0 = use fft)"), "fft": (1024, "FFT size when rbw is 0"),
              "window": ("hann", "hann|blackmanharris|flattop|rect"), "traces": (["live"], "any of live, max, min, avg"),
              "average": (8, "frames in the avg trace (exponential, power domain)"), "points": (0, "display points (0 = all bins)"),
              "detector": ("peak", "peak|sample when reducing to points"), "fps": (10, "trace updates per second"), "center": (0.0, "Hz added to x axis"),
              "onesided": ("auto", "auto (real input: positive frequencies only) | true | false"),
              "overlay": ([], "ids of other spectrum blocks drawn here too (before/after: put one before and one after a chain)")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.buf = np.zeros(0, np.complex64)
        self.hold = {}
        self.logged_n = None
        self.real = True
        self.last = None

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
        # audio sources hand out complex64 with a zero imaginary part: treat as real
        self.real = not np.iscomplexobj(x) or not np.any(np.imag(x))
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
        freqs = np.fft.fftshift(np.fft.fftfreq(n, 1 / rate))
        onesided = self.p["onesided"]
        if onesided is True or onesided == "true" or (onesided == "auto" and self.real):
            keep = freqs >= 0
            freqs = freqs[keep]
            curves = {k: v[keep] for k, v in curves.items()}
        bins = len(freqs)
        freqs = float(self.p["center"]) + freqs
        if points and points < bins:
            freqs = freqs[np.linspace(0, bins, points + 1).astype(int)[:-1]]
        series = []
        for name in self.p["traces"]:
            db = 10 * np.log10(self.reduce(curves[name], points, self.p["detector"]) + 1e-20)
            series.append({"label": labels[name], "y": np.round(db, 2).tolist()})
        self.last = {"x": freqs, "series": series}
        for other_id in self.p["overlay"] or []:
            other = graph.blocks.get(other_id)
            last = getattr(other, "last", None)
            if last and len(last["x"]) == len(freqs) and np.allclose(last["x"], freqs):
                series = series + [{"label": "%s %s" % (other_id, s["label"]), "y": s["y"]} for s in last["series"]]
        lab.trace(self.id, freqs.tolist(), series, "Hz", "dBFS")
        if self.logged_n != n:
            self.logged_n = n
            lab.log("%s: fft %d, rbw %.1f Hz (%s)" % (self.id, n, enbw * rate / n, self.p["window"]))
        return None


class Constellation(Throttled):
    inputs = "complex symbols"
    outputs = "trace <device>_<id> (mode constellation)"
    doc = "I/Q scatter -> trace <device>_<id> (mode constellation)"
    params = {"points": (2000, "most recent symbols plotted"), "fps": (10, "trace updates per second")}

    def work(self, x, rate):
        self.buf = np.concatenate([getattr(self, "buf", np.zeros(0, np.complex64)), x.astype(np.complex64)])[-int(self.p["points"]):]
        if self.due():
            lab.trace(self.id, [], [{"label": "IQ", "x": np.round(self.buf.real, 4).tolist(), "y": np.round(self.buf.imag, 4).tolist()}], "I", "Q", "constellation")
        return None


class Eye(Throttled):
    inputs = "complex IQ or real at `sps` samples per symbol"
    outputs = "trace <device>_<id> (mode eye)"
    doc = "eye diagram -> trace <device>_<id> (mode eye); input at sps samples/symbol"
    params = {"sps": (8, "samples per symbol"), "traces": (64, "overlaid two-symbol segments"), "fps": (5, "trace updates per second"), "part": ("real", "real|imag")}

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
    inputs = "real, or complex (`part` picks real/imag/mag)"
    outputs = "trace <device>_<id> (s vs V, with measurements), channels <device>_<id>_<measurement>"
    doc = ("oscilloscope -> trace <device>_<id>: trigger (rising/falling, level, auto/normal, pretrigger), "
           "traces live/max/min/avg, measurements (vpp vmax vmin mean vrms freq period duty) -> channels <device>_<id>_<m>")
    params = {"samples": (1000, "samples per capture"), "part": ("real", "real|imag|mag for complex input"),
              "trigger": ("rising", "rising|falling|none"), "level": (0.0, "trigger level"),
              "mode": ("auto", "auto (free-run without trigger) | normal (hold last trigger)"),
              "pretrigger": (0.1, "fraction of the capture before the trigger"),
              "traces": (["live"], "any of live, max, min, avg"), "average": (8, "captures in the avg trace"),
              "measure": (["vpp", "freq"], "measurements to publish as channels"), "fps": (10, "captures per second")}

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
    inputs = "complex IQ or real"
    outputs = "channel <device>_<id>"
    doc = "statistic of the stream -> channel <device>_<id>"
    params = {"stat": ("power_db", "power_db|rms|mean|peak|last"), "fps": (10, "channel samples per second"), "unit": ("", "channel unit (default dB for power_db)")}

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
    inputs = "real audio (complex: real part)"
    outputs = "audio stream <device>_<id> (int16 PCM at `rate`)"
    kind = "sink"
    doc = "play in the browser (audio pane on stream <device>_<id>); real input, resampled to `rate`"
    params = {"rate": (24000, "output sample rate"), "gain": (1.0, "linear gain before clipping to [-1, 1]")}

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
    inputs = "real audio (complex: real part)"
    outputs = "WAV file (16-bit mono) in the media dir"
    kind = "sink"
    doc = "record real samples to a WAV file"
    params = {"path": ("", "output file inside DATA_DIR/media or MAILAB_MEDIA_DIRS (default <media>/<block id>.wav)")}

    def work(self, x, rate):
        if not hasattr(self, "w"):
            roots = [r for r in os.environ.get("MAILAB_MEDIA_ROOTS", "").split(":") if r]
            path = self.p["path"] or (os.path.join(roots[0], self.id + ".wav") if roots else "")
            if roots:
                os.makedirs(roots[0], exist_ok=True)
            self.w = wave.open(_media_path(path, must_exist=False), "wb")
            self.w.setnchannels(1)
            self.w.setsampwidth(2)
            self.w.setframerate(int(rate))
        self.w.writeframes((np.clip(np.real(x), -1, 1) * 32767).astype("<i2").tobytes())
        return None

    def close(self):
        if hasattr(self, "w"):
            self.w.close()

# network IQ ---------------------------------------------------------------

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _ws_read_http_head(conn):
    """read one HTTP message (handshake request/response); returns (head, extra)."""
    data = b""
    conn.settimeout(2.0)
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(4096)
        if not chunk:
            raise ConnectionError("ws handshake: connection closed")
        data += chunk
        if len(data) > 65536:
            raise ConnectionError("ws handshake: header too large")
    head, _, extra = data.partition(b"\r\n\r\n")
    conn.setblocking(False)
    return head.decode("latin1"), extra


def _ws_handshake_server(conn):
    head, extra = _ws_read_http_head(conn)
    key = None
    for line in head.split("\r\n")[1:]:
        name, _, value = line.partition(":")
        if name.strip().lower() == "sec-websocket-key":
            key = value.strip()
    if not key:
        raise ConnectionError("ws handshake: no Sec-WebSocket-Key")
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    conn.sendall(("HTTP/1.1 101 Switching Protocols\r\n"
                  "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                  "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").encode())
    return extra


def _ws_handshake_client(conn, host, port):
    key = base64.b64encode(os.urandom(16)).decode()
    conn.sendall(("GET / HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
                  "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
                  "Sec-WebSocket-Version: 13\r\n\r\n" % (host, port, key)).encode())
    head, extra = _ws_read_http_head(conn)
    if " 101 " not in head.split("\r\n", 1)[0]:
        raise ConnectionError("ws handshake: " + head.split("\r\n", 1)[0])
    return extra


def _ws_frame(payload, masked, opcode=0x2):
    """one websocket frame (FIN set); payload is bytes."""
    head = bytes([0x80 | opcode])
    n = len(payload)
    maskbit = 0x80 if masked else 0
    if n < 126:
        head += bytes([maskbit | n])
    elif n < (1 << 16):
        head += bytes([maskbit | 126]) + struct.pack(">H", n)
    else:
        head += bytes([maskbit | 127]) + struct.pack(">Q", n)
    if not masked:
        return head + payload
    key = os.urandom(4)
    return head + key + bytes(payload[i] ^ key[i % 4] for i in range(n))


def _ws_parse(buf):
    """parse complete frames from buf; returns (events, rest) where an event is
    ("data", payload) | ("ping", payload) | ("close", b"")."""
    events = []
    i = 0
    while True:
        if len(buf) - i < 2:
            break
        b0, b1 = buf[i], buf[i + 1]
        opcode = b0 & 0x0F
        masked = b1 & 0x80
        n = b1 & 0x7F
        j = i + 2
        if n == 126:
            if len(buf) - j < 2:
                break
            n = struct.unpack(">H", buf[j:j + 2])[0]
            j += 2
        elif n == 127:
            if len(buf) - j < 8:
                break
            n = struct.unpack(">Q", buf[j:j + 8])[0]
            j += 8
        key = b""
        if masked:
            if len(buf) - j < 4:
                break
            key = buf[j:j + 4]
            j += 4
        if len(buf) - j < n:
            break
        payload = bytes(buf[j + k] ^ key[k % 4] for k in range(n)) if masked else bytes(buf[j:j + n])
        j += n
        i = j
        if opcode == 0x8:
            events.append(("close", b""))
        elif opcode == 0x9:
            events.append(("ping", payload))
        elif opcode == 0xA:
            pass  # pong
        else:  # text / binary / continuation: all payload
            events.append(("data", payload))
    return events, buf[i:]


def _decode_iq(data, fmt):
    """raw bytes -> complex64 (IQ formats) or logic words (u8/u16/u32 samples,
    bits = packed MSB first); returns (samples, leftover bytes)"""
    size = {"cf32": 8, "cs16": 4, "cu8": 2, "u8": 1, "u16": 2, "u32": 4, "bits": 1}[fmt]
    usable = len(data) - len(data) % size
    raw, rest = data[:usable], data[usable:]
    if fmt in pdec.WORD_FORMATS:
        return pdec.words_from_bytes(raw, fmt), rest
    if fmt == "cf32":
        return np.frombuffer(raw, dtype=np.complex64).copy(), rest
    if fmt == "cs16":
        v = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    else:
        v = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 127.5) / 127.5
    return (v[0::2] + 1j * v[1::2]).astype(np.complex64), rest


def _encode_iq(x, fmt):
    if fmt in pdec.WORD_FORMATS:
        return pdec.words_to_bytes(x, fmt)
    x = np.asarray(x, dtype=np.complex64)
    if fmt == "cf32":
        return x.tobytes()
    inter = np.empty(len(x) * 2, dtype=np.float32)
    inter[0::2], inter[1::2] = x.real, x.imag
    if fmt == "cs16":
        return (np.clip(inter, -1, 1) * 32767).astype("<i2").tobytes()
    return (np.clip(inter * 127.5 + 127.5, 0, 255)).astype(np.uint8).tobytes()


class _NetEndpoint:
    """tcp-server (one client at a time), tcp-client, udp, or websocket
    (ws-server / ws-client, RFC 6455 binary messages); all non-blocking."""

    def __init__(self, p, receiving):
        self.mode, self.host, self.port = p["mode"], p["host"], int(p["port"])
        self.conn = None
        self.peer = None
        self.wsbuf = b""  # undecoded websocket frames (and handshake leftovers)
        if self.mode in ("tcp-server", "ws-server"):
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
        elif self.mode not in ("tcp-client", "ws-client"):
            raise ValueError("mode must be tcp-server, tcp-client, udp, ws-server or ws-client")

    def _is_ws(self):
        return self.mode in ("ws-server", "ws-client")

    def ready(self):
        if self.conn is not None:
            return True
        try:
            if self.mode == "tcp-server":
                self.conn, addr = self.listener.accept()
                lab.log("net: client %s:%d connected" % addr)
            elif self.mode == "ws-server":
                self.conn, addr = self.listener.accept()
                self.wsbuf += _ws_handshake_server(self.conn)
                lab.log("net: ws client %s:%d connected" % addr)
            elif self.mode == "ws-client":
                self.conn = socket.create_connection((self.host, self.port), timeout=2.0)
                self.wsbuf += _ws_handshake_client(self.conn, self.host, self.port)
                lab.log("net: ws connected to %s:%d" % (self.host, self.port))
            else:
                self.conn = socket.create_connection((self.host, self.port), timeout=0.2)
                lab.log("net: connected to %s:%d" % (self.host, self.port))
            self.conn.setblocking(False)
            return True
        except (BlockingIOError, OSError, ConnectionError):
            if self.conn is not None:
                self.conn.close()
                self.conn = None
            return False

    def dropped(self):
        if self.mode != "udp" and self.conn is not None:
            self.conn.close()
            self.conn = None
            self.wsbuf = b""
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
        raw = b"".join(chunks)
        if not self._is_ws():
            return raw
        self.wsbuf += raw
        events, self.wsbuf = _ws_parse(self.wsbuf)
        out = []
        for kind, payload in events:
            if kind == "data":
                out.append(payload)
            elif kind == "ping":  # keepalive: answer with a pong
                try:
                    self.conn.sendall(_ws_frame(payload, masked=self.mode == "ws-client", opcode=0xA))
                except OSError:
                    self.dropped()
            elif kind == "close":
                self.dropped()
        return b"".join(out)

    def send(self, data):
        if not self.ready():
            return
        try:
            if self._is_ws():
                self.conn.sendall(_ws_frame(data, masked=self.mode == "ws-client"))
            elif self.mode == "udp":
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


NET_PARAMS = {"mode": ("tcp-server", "tcp-server|tcp-client|udp|ws-server|ws-client"), "host": ("127.0.0.1", "bind (server/udp in) or remote host"),
              "port": (5600, "TCP/UDP port (listen port for tcp-server / udp in, remote port otherwise)"),
              "format": ("cf32", "cf32|cs16|cu8 interleaved I/Q, or logic: u8|u16|u32 words per sample, bits (packed, MSB first)")}


class NetSource(Block):
    inputs = ""
    outputs = "complex IQ (cf32/cs16/cu8) or logic words (u8/u16/u32/bits) at `rate`"
    kind = "source"
    doc = ("IQ in over TCP/UDP/WebSocket (raw interleaved cf32/cs16/cu8), e.g. from GNU Radio, SDR++ or rtl_tcp-like streams; "
           "or logic samples (u8/u16/u32/bits) for decode")
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
    inputs = "complex IQ, or logic words for the u8/u16/u32/bits formats"
    outputs = "raw bytes over TCP/UDP/WebSocket"
    kind = "sink"
    doc = "IQ out over TCP/UDP/WebSocket (raw interleaved cf32/cs16/cu8, one binary message per chunk)"
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
    "signal": SignalSource, "modulated": ModulatedSource, "file": FileSource, "audio_file": AudioFileSource, "soapy": SoapySource, "audio_in": AudioIn,
    "shift": Shift, "resample": Resample, "lowpass": Lowpass, "agc": Agc, "fm_demod": FmDemod, "am_demod": AmDemod,
    "symbol_sync": SymbolSync, "carrier_recovery": CarrierRecovery, "demod": Demod, "mag": Mag, "decimate": Decimate,
    "python": Python,
    "soapy_sink": SoapySink,
    "spectrum": Spectrum, "constellation": Constellation, "eye": Eye, "scope": Scope, "measure": Measure,
    "audio": Audio, "wav": Wav, "net_source": NetSource, "net_sink": NetSink,
    "bits": BitSource, "mod": Modulate, "analog_mod": AnalogMod, "channel": Channel, "discriminator": Discriminator,
    "clock_recovery": ClockRecovery, "slicer": Slicer, "ber": Ber, "framer": Framer, "bitview": BitView,
    "baud_est": BaudEst, "packet_decode": PacketDecode,
    "matched_filter": MatchedFilterBlock, "level_trigger": LevelTrigger, "uart_tx": UartTx, "uart_rx": UartRx,
    "decode": Decode,
}
# realtime audio blocks (filters, dynamics, noise reduction, neural denoise): python/audio_blocks.py
BLOCKS.update(audio_blocks.BLOCKS)
# 802.11a/g-style OFDM modem (loopback): python/ofdm.py
BLOCKS.update(ofdm.BLOCKS)


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
    out = {bid: {"type": next(s["type"] for s in graph.spec["blocks"] if s["id"] == bid), "in": b.samples_in,
                 "out": b.samples_out, "rate": b.in_rate, "error": graph.errors.get(bid)} for bid, b in graph.blocks.items()}
    # block-specific stats (audio blocks: latency, gain reduction, RTF...)
    for bid, b in graph.blocks.items():
        if hasattr(b, "extra_stats"):
            extra = b.extra_stats()
            error = out[bid]["error"] or extra.get("error")
            out[bid].update(extra)
            out[bid]["error"] = error
    return out


# ---- commands -------------------------------------------------------------------

bridge = lab.Bridge()


@bridge.command("blocks", "block catalog: kind, doc, inputs, outputs, params with defaults")
def blocks(_args):
    return {name: {"kind": cls.kind, "doc": cls.doc, "inputs": cls.inputs, "outputs": cls.outputs,
                   "params": {k: {"default": v[0], "doc": v[1]} for k, v in cls.params.items()}}
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


@bridge.command("set_param", "{block, key, value} change a parameter (audio blocks apply it live keeping state; others restart)")
def set_param(args):
    spec = json.loads(json.dumps(graph.spec))
    block = next((b for b in spec["blocks"] if b["id"] == args["block"]), None)
    if block is None:
        raise ValueError("unknown block: %s" % args["block"])
    block.setdefault("params", {})[args["key"]] = args["value"]
    live = graph.blocks.get(args["block"])
    if hasattr(live, "set_live") and live.set_live(args["key"], args["value"]):
        graph.spec = spec
        publish()
        return dict(block, live=True)
    graph.load(spec)
    return block


@bridge.command("templates", "graph templates (audio presets): name -> description and args")
def templates(_args):
    return {name: doc for name, (doc, _fn) in audio_blocks.TEMPLATES.items()}


@bridge.command("load_template", "{name, ...args} replace the graph with a template, e.g. voice_cleanup {stream} / {path}")
def load_template(args):
    graph.load(audio_blocks.template(args.get("name"), args))
    return graph.spec


@bridge.command("run", "{on} pause / resume the graph")
def run(args):
    graph.running = lab.parse_switch(args["on"], "on")
    return {"running": graph.running}


def _external_words(args):
    """{data (base64) | hex | bits ("0110…") | levels [..], format} -> words"""
    if args.get("bits") is not None:
        return np.array([int(c) for c in str(args["bits"]) if c in "01"], dtype=np.uint32)
    if args.get("levels") is not None:
        return np.asarray(args["levels"])
    if args.get("hex") is not None:
        raw = bytes.fromhex(str(args["hex"]))
    elif args.get("data") is not None:
        raw = base64.b64decode(args["data"])
    else:
        raise ValueError("give data (base64), hex, bits or levels")
    return pdec.words_from_bytes(raw, args.get("format", "u8"))


@bridge.command("feed", "{block, data|hex|bits|levels, format: u8|u16|u32|bits, rate} push external samples into a block (e.g. decode)")
def feed(args):
    if args.get("block") not in graph.blocks:
        raise ValueError("unknown block: %s" % args.get("block"))
    x = _external_words(args)
    graph.push(args["block"], x, float(args["rate"]))
    block = graph.blocks[args["block"]]
    if isinstance(block, Decode) and block.new:
        block.publish()
    return {"samples": len(x), "error": graph.errors.get(args["block"])}


@bridge.command("decode", "{decoder, samplerate, data|hex|bits|levels, format, options, channels, stack, engine, annotations, name?} "
                "one-shot protocol decode of an external capture -> annotations (+ value/log <device>_<name>)")
def decode_once(args):
    x = _external_words(args)
    anns = pdec.decode(x, float(args["samplerate"]), args.get("decoder", "uart"), options=args.get("options"),
                       channels=args.get("channels"), engine=args.get("engine", "auto"), stack=args.get("stack"),
                       threshold=args.get("threshold"))
    wanted = args.get("annotations")
    if wanted:
        anns = [a for a in anns if a["class"] in wanted or "%s=%s" % (a["decoder"], a["class"]) in wanted]
    data = pdec.data_bytes(anns)
    if args.get("name"):
        lab.value(args["name"], {"decoder": args.get("decoder", "uart"), "count": len(anns),
                                 "columns": ["t", "decoder", "class", "text", "ss", "es"], "rows": anns[-2000:]})
        lab.log("%s: %d annotations, %d data bytes" % (args["name"], len(anns), len(data)), "decode")
        if data:
            lab.blob(args["name"], data)
    return {"engine": pdec.pick_engine(args.get("decoder", "uart"), args.get("engine", "auto")), "samples": len(x),
            "count": len(anns), "annotations": anns[:5000], "data_hex": data.hex()}


@bridge.command("audio_in", "{stream, rate, channels, data (base64 int16 LE)} a lab audio chunk for the audio_in blocks "
                "listening to `stream` (the device forwards these itself)")
def audio_in(args):
    rate = float(args["rate"])
    channels = int(args.get("channels", 1))
    if not 0 < rate <= 384000 or channels not in (1, 2):
        raise ValueError("bad audio format: %s Hz, %s channels" % (rate, channels))
    data = base64.b64decode(args["data"])
    targets = [b for b in graph.blocks.values() if isinstance(b, AudioIn) and b.p["stream"] == args["stream"]]
    for block in targets:
        block.feed(data, rate, channels)
    return {"blocks": len(targets), "dropped": sum(b.dropped for b in targets)}


@bridge.command("stats", "per-block samples in/out, rate, last error")
def get_stats(_args):
    return stats()


def publish_stats():
    lab.emit({"type": "value", "name": "stats", "value": stats()})
    # decode rows held back by the fps limit (e.g. the stream went quiet)
    for block in graph.blocks.values():
        if isinstance(block, Decode) and block.new:
            block.publish()


parser = argparse.ArgumentParser()
parser.add_argument("--graph", default="", help="initial graph JSON")
parser.add_argument("--chamber", action="store_true",
                    help="RF chamber mode: skip the soapy_sink TX band check")
parser.add_argument("--tx-bands-final", default="",
                    help="final allowed TX band list \"lo-hi, lo-hi\" Hz for soapy_sink")
opts = parser.parse_args()
TX_CHAMBER = bool(opts.chamber)
TX_BANDS = _parse_bands(opts.tx_bands_final) if opts.tx_bands_final else []
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
