"""Streaming audio DSP engines for the flowgraph (numpy + scipy, no lab I/O).

Every engine is built as Engine(fs, p) where `p` is the block's live param
dict (shared, so set_param edits reach it), and offers:

    process(x)  float64 chunk -> float64 chunk; state is kept between chunks,
                so the output does not depend on how the stream is chunked
    update()    re-read `p` after a live parameter change, keeping state
    latency     added delay in samples (algorithmic; IIR group delay excluded)
    stats()     dict for the block's stats (gain reduction, tones, RTF, ...)

Filters (RBJ cookbook biquads, FIR, hum notch, auto-tracking notch, DC blocker),
dynamics (compressor, limiter, gate/expander, AGC), noise reduction (spectral
subtraction / Wiener, de-click) and the neural denoise wrapper (`Denoise`, with
pluggable backends in DENOISE_BACKENDS: deepfilternet, rnnoise, maxine stub).
"""

import ctypes
import ctypes.util
import math
import os
import subprocess
import sys
import threading
import time
from fractions import Fraction

import numpy as np
from scipy import signal

EPS = 1e-12

# DeepFilterNet backend: pinned install set (torch from the PyTorch CUDA 13.4 index;
# deepfilternet itself pins numpy<2, so it goes in with --no-deps on top of its real deps)
TORCH_INDEX = "https://download.pytorch.org/whl/cu134"
TORCH_REQUIREMENT = "torch==2.15.0"
DF_REQUIREMENTS = ["deepfilterlib==0.5.6", "loguru==0.8.0", "appdirs==1.4.4"]
DF_NODEPS = ["deepfilternet==0.5.6"]
DF_RATE = 48000
RESAMPLE_SLACK = 4
RNNOISE_RATE = 48000
RNNOISE_FRAME = 480


def db_to_lin(db):
    return 10.0 ** (float(db) / 20.0)


def lin_to_db(x):
    return 20.0 * np.log10(np.maximum(np.abs(x), EPS))


def ms_to_samples(ms, fs):
    return max(0, int(round(float(ms) * fs / 1000.0)))


def time_coeff(ms, fs):
    """one-pole smoothing coefficient for a time constant (0 ms -> instant)"""
    n = float(ms) * fs / 1000.0
    if n <= 0:
        return 0.0
    return math.exp(-1.0 / n)


# ---- filters --------------------------------------------------------------------

BIQUAD_TYPES = ("lowpass", "highpass", "bandpass", "notch", "peaking", "lowshelf", "highshelf", "allpass")


def rbj(kind, f0, q, gain_db, fs):
    """RBJ Audio EQ Cookbook biquad -> one sos row [b0 b1 b2 1 a1 a2]"""
    f0 = min(max(float(f0), 1e-3), 0.499 * fs)
    q = max(float(q), 1e-3)
    w0 = 2 * math.pi * f0 / fs
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / (2 * q)
    a = 10 ** (float(gain_db) / 40)
    if kind == "lowpass":
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
        den = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "highpass":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
        den = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "bandpass":
        # constant 0 dB peak gain
        b = [alpha, 0.0, -alpha]
        den = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "notch":
        b = [1.0, -2 * cw, 1.0]
        den = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "allpass":
        b = [1 - alpha, -2 * cw, 1 + alpha]
        den = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "peaking":
        b = [1 + alpha * a, -2 * cw, 1 - alpha * a]
        den = [1 + alpha / a, -2 * cw, 1 - alpha / a]
    elif kind in ("lowshelf", "highshelf"):
        sq = 2 * math.sqrt(a) * alpha
        if kind == "lowshelf":
            b = [a * ((a + 1) - (a - 1) * cw + sq), 2 * a * ((a - 1) - (a + 1) * cw), a * ((a + 1) - (a - 1) * cw - sq)]
            den = [(a + 1) + (a - 1) * cw + sq, -2 * ((a - 1) + (a + 1) * cw), (a + 1) + (a - 1) * cw - sq]
        else:
            b = [a * ((a + 1) + (a - 1) * cw + sq), -2 * a * ((a - 1) + (a + 1) * cw), a * ((a + 1) + (a - 1) * cw - sq)]
            den = [(a + 1) - (a - 1) * cw + sq, 2 * ((a - 1) - (a + 1) * cw), (a + 1) - (a - 1) * cw - sq]
    else:
        raise ValueError("biquad type must be one of " + ", ".join(BIQUAD_TYPES))
    return [b[0] / den[0], b[1] / den[0], b[2] / den[0], 1.0, den[1] / den[0], den[2] / den[0]]


class Sos:
    """second-order sections with persistent state; coefficients can change live"""

    def __init__(self, sos=None):
        self.sos = None
        self.zi = None
        self.set(sos)

    def set(self, sos):
        if sos is None or not len(sos):
            self.sos, self.zi = None, None
            return
        sos = np.asarray(sos, dtype=np.float64).reshape(-1, 6)
        if self.zi is None or self.zi.shape[0] != sos.shape[0]:
            self.zi = np.zeros((sos.shape[0], 2))
        self.sos = sos

    def process(self, x):
        if self.sos is None or not len(x):
            return x
        y, self.zi = signal.sosfilt(self.sos, x, zi=self.zi)
        return y


class Biquad:
    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.f = Sos()
        self.update()

    def update(self):
        kind = str(self.p["type"])
        if kind not in BIQUAD_TYPES:
            raise ValueError("biquad type must be one of " + ", ".join(BIQUAD_TYPES))
        row = rbj(kind, self.p["freq"], self.p["q"], self.p["gain_db"], self.fs)
        self.f.set([row] * max(1, int(self.p["stages"])))

    latency = 0

    def process(self, x):
        return self.f.process(x)

    def response(self, freqs):
        return sos_response(self.f.sos, freqs, self.fs)

    def stats(self):
        return {}


def sos_response(sos, freqs, fs):
    """complex response of an sos cascade at `freqs` Hz"""
    _w, h = signal.sosfreqz(sos, worN=np.asarray(freqs, dtype=np.float64), fs=fs)
    return h


class Fir:
    """windowed-sinc linear-phase FIR (latency = (taps - 1) / 2)"""

    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.h = None
        self.zi = None
        self.update()

    def update(self):
        kind = str(self.p["type"])
        taps = max(3, int(self.p["taps"]))
        if taps % 2 == 0:
            taps += 1   # odd: highpass/bandstop need it, and the delay stays integer
        nyq = self.fs / 2
        f1 = min(max(float(self.p["freq"]), 1.0), nyq * 0.98)
        if kind in ("bandpass", "bandstop"):
            f2 = min(max(float(self.p["freq2"]), f1 + 1.0), nyq * 0.99)
            cutoff = [f1, f2]
        else:
            cutoff = f1
        pass_zero = {"lowpass": True, "highpass": False, "bandpass": False, "bandstop": True}.get(kind)
        if pass_zero is None:
            raise ValueError("fir type must be lowpass|highpass|bandpass|bandstop")
        h = signal.firwin(taps, cutoff, window=("kaiser", float(self.p["beta"])), pass_zero=pass_zero, fs=self.fs)
        if self.zi is None or len(self.zi) != taps - 1:
            self.zi = np.zeros(taps - 1)
        self.h = h
        self.latency = (taps - 1) // 2

    def process(self, x):
        if not len(x):
            return x
        y, self.zi = signal.lfilter(self.h, [1.0], x, zi=self.zi)
        return y

    def stats(self):
        return {"taps": len(self.h)}


class DcBlock:
    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.zi = np.zeros(1)
        self.update()

    latency = 0

    def update(self):
        self.r = math.exp(-2 * math.pi * max(float(self.p["cutoff"]), 0.01) / self.fs)

    def process(self, x):
        if not len(x):
            return x
        y, self.zi = signal.lfilter([1.0, -1.0], [1.0, -self.r], x, zi=self.zi)
        return y

    def stats(self):
        return {}


class HumNotch:
    """notches at f0 and its harmonics, constant width in Hz (or constant Q);
    freq "auto" picks 50 or 60 Hz from the first second of input"""

    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.f = Sos()
        self.f0 = None
        self.probe = []
        self.probed = 0
        self.update()

    latency = 0

    def update(self):
        freq = self.p["freq"]
        if str(freq) == "auto":
            if self.f0 is None:
                return
        else:
            self.f0 = float(freq)
        rows = []
        width = float(self.p["width"])
        q = float(self.p["q"])
        for k in range(1, int(self.p["harmonics"]) + 1):
            fk = k * self.f0
            if fk >= 0.45 * self.fs:
                break
            rows.append(rbj("notch", fk, q if q > 0 else fk / max(width, 0.01), 0, self.fs))
        self.f.set(rows)

    def detect(self, x):
        """50 vs 60 Hz from the first second: which harmonic series stands out as narrow
        lines above its neighbourhood (speech/music spread out, hum doesn't)"""
        self.probe.append(x)
        self.probed += len(x)
        if self.probed < self.fs:
            return
        data = np.concatenate(self.probe)
        n = len(data)
        spec = np.abs(np.fft.rfft(data * np.hanning(n))) ** 2 + EPS
        res = self.fs / n

        def lines(base):
            score = 0.0
            for k in range(1, 9):
                b = int(round(k * base / res))
                span = max(3, int(round(12 / res)))
                if b + span >= len(spec):
                    break
                peak = np.max(spec[b - 1:b + 2])
                local = np.median(np.concatenate([spec[b - span:b - 2], spec[b + 3:b + span + 1]]))
                score += max(0.0, math.log10(peak / local))
            return score
        self.f0 = 50.0 if lines(50.0) >= lines(60.0) else 60.0
        self.probe = []
        self.update()

    def process(self, x):
        if self.f0 is None:
            self.detect(x)
            if self.f0 is None:
                return x
        return self.f.process(x)

    def stats(self):
        return {"f0": self.f0, "notches": 0 if self.f.sos is None else len(self.f.sos)}


class AutoNotch:
    """finds the strongest stationary tones (long-term averaged spectrum, peak above
    the median floor by min_snr_db, stable for persist_s) and notches them; or
    notches a fixed `freqs` list. Retunes when a tone drifts, keeping filter state."""

    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.f = Sos()
        self.buf = np.zeros(0)
        self.avg = None
        self.candidates = {}   # rounded bin -> {freq, since}
        self.active = []       # [{freq, level_db, seen}]
        self.t = 0.0
        self.update()

    latency = 0

    def update(self):
        self.n = int(2 ** round(math.log2(max(256.0, self.fs / max(float(self.p["resolution"]), 0.1)))))
        self.hop = self.n // 2
        self.window = np.hanning(self.n)
        self.freqs = np.fft.rfftfreq(self.n, 1 / self.fs)
        if self.avg is not None and len(self.avg) != len(self.freqs):
            self.avg = None
        self.retune()

    def notch_freqs(self):
        fixed = self.p.get("freqs") or []
        if fixed:
            return [float(f) for f in fixed]
        return [t["freq"] for t in self.active]

    def retune(self):
        width = float(self.p["width"])
        self.f.set([rbj("notch", f, f / max(width, 0.01), 0, self.fs) for f in self.notch_freqs() if 0 < f < 0.49 * self.fs])

    def analyze(self, frame):
        power = np.abs(np.fft.rfft(frame * self.window)) ** 2
        alpha = min(1.0, self.hop / (float(self.p["average_s"]) * self.fs))
        self.avg = power if self.avg is None else self.avg + alpha * (power - self.avg)
        self.t += self.hop / self.fs
        lo = np.searchsorted(self.freqs, float(self.p["fmin"]))
        hi = np.searchsorted(self.freqs, min(float(self.p["fmax"]), 0.49 * self.fs))
        if hi - lo < 8:
            return
        db = 10 * np.log10(self.avg[lo:hi] + EPS)
        floor = np.median(db)
        # local maxima above the floor
        peaks = np.nonzero((db[1:-1] > db[:-2]) & (db[1:-1] >= db[2:]) & (db[1:-1] > floor + float(self.p["min_snr_db"])))[0] + 1
        peaks = peaks[np.argsort(db[peaks])[::-1]][:max(1, int(self.p["tones"])) * 2]
        found = []
        for i in peaks:
            # parabolic interpolation on the dB spectrum
            a, b, c = db[i - 1], db[i], db[i + 1]
            d = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
            freq = float(self.freqs[lo + i] + d * self.fs / self.n)
            found.append((freq, float(b - floor)))
        self.track(found)

    def track(self, found):
        res = self.fs / self.n
        persist = float(self.p["persist_s"])
        now = self.t
        seen = {}
        for freq, level in found:
            key = int(round(freq / (2 * res)))
            c = self.candidates.get(key) or self.candidates.get(key - 1) or self.candidates.get(key + 1)
            if c is None:
                c = {"since": now}
            c.update(freq=freq, level=level, last=now)
            seen[key] = c
        self.candidates = seen
        stable = sorted([c for c in seen.values() if now - c["since"] >= persist], key=lambda c: -c["level"])
        stable = stable[:max(1, int(self.p["tones"]))]
        changed = len(stable) != len(self.active)
        for new in stable:
            old = next((t for t in self.active if abs(t["freq"] - new["freq"]) < 2 * res), None)
            if old is None or abs(old["freq"] - new["freq"]) > float(self.p["retune_hz"]):
                changed = True
        # keep tones briefly absent from the estimate (hold) so notches don't flap
        kept = [t for t in self.active if now - t["seen"] < float(self.p["hold_s"])
                and not any(abs(t["freq"] - s["freq"]) < 2 * res for s in stable)]
        if changed:
            self.active = ([{"freq": c["freq"], "level_db": round(c["level"], 1), "seen": now} for c in stable] + kept)[:max(1, int(self.p["tones"]))]
            self.retune()
        else:
            for t in self.active:
                if any(abs(t["freq"] - s["freq"]) < 2 * res for s in stable):
                    t["seen"] = now

    def process(self, x):
        if not self.p.get("freqs"):
            self.buf = np.concatenate([self.buf, x])
            while len(self.buf) >= self.n:
                self.analyze(self.buf[:self.n])
                self.buf = self.buf[self.hop:]
        return self.f.process(x)

    def stats(self):
        return {"tones": [{"freq": round(f, 2)} for f in self.notch_freqs()]}


# ---- dynamics -------------------------------------------------------------------

class Delay:
    def __init__(self, n=0):
        self.buf = np.zeros(n)

    def resize(self, n):
        if n != len(self.buf):
            self.buf = np.zeros(n)

    def process(self, x):
        if not len(self.buf):
            return x
        both = np.concatenate([self.buf, x])
        self.buf = both[len(x):]
        return both[:len(x)]


class Detector:
    """level in dBFS: peak (|x|) or RMS over rms_ms, optionally on a high-passed sidechain"""

    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.hpf = Sos()
        self.zi = np.zeros(1)
        self.update()

    def update(self):
        hz = float(self.p.get("sidechain_hpf") or 0)
        self.hpf.set([rbj("highpass", hz, 0.7071, 0, self.fs)] if hz > 0 else None)
        self.a = time_coeff(float(self.p.get("rms_ms", 10)), self.fs)

    def level_db(self, x):
        sc = self.hpf.process(x)
        if str(self.p.get("detector", "rms")) == "peak":
            return lin_to_db(sc)
        ms, self.zi = signal.lfilter([1 - self.a], [1, -self.a], sc * sc, zi=self.zi)
        # sqrt(mean square) of a sine is its RMS; +3 dB would make it peak-referenced
        return 10 * np.log10(np.maximum(ms, EPS * EPS))


def smooth_gain(target, state, attack, release, attack_when_lower=True):
    """asymmetric one-pole smoothing (per sample, so chunking can't change it).
    attack applies when the target moves below the current value (more reduction)"""
    out = np.empty(len(target))
    g = state
    for i, t in enumerate(target.tolist()):
        if (t < g) == attack_when_lower:
            g = t + attack * (g - t)
        else:
            g = t + release * (g - t)
        out[i] = g
    return out, g


def static_curve(level_db, threshold, ratio, knee):
    """compressor gain (dB, <= 0) for a detector level; soft knee (Giannoulis et al.)"""
    over = level_db - threshold
    slope = 1.0 / ratio - 1.0
    gr = np.where(over > knee / 2, slope * over, 0.0)
    if knee > 0:
        inside = np.abs(over) <= knee / 2
        gr = np.where(inside, slope * (over + knee / 2) ** 2 / (2 * knee), gr)
    return gr


class Compressor:
    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.det = Detector(fs, p)
        self.delay = Delay()
        self.g = 0.0
        self.last_gr = 0.0
        self.max_gr = 0.0
        self.update()

    def update(self):
        self.det.update()
        self.att = time_coeff(self.p["attack_ms"], self.fs)
        self.rel = time_coeff(self.p["release_ms"], self.fs)
        self.latency = ms_to_samples(self.p["lookahead_ms"], self.fs)
        self.delay.resize(self.latency)

    def gain_db(self, x):
        level = self.det.level_db(x)
        target = static_curve(level, float(self.p["threshold_db"]), max(1.0, float(self.p["ratio"])), max(0.0, float(self.p["knee_db"])))
        gr, self.g = smooth_gain(target, self.g, self.att, self.rel)
        return gr

    def process(self, x):
        if not len(x):
            return x
        gr = self.gain_db(x)
        self.last_gr = float(gr[-1])
        self.max_gr = min(self.max_gr, float(np.min(gr)))
        return self.delay.process(x) * 10 ** ((gr + float(self.p["makeup_db"])) / 20)

    def stats(self):
        out = {"gr_db": round(self.last_gr, 2), "gr_max_db": round(self.max_gr, 2)}
        self.max_gr = 0.0
        return out


class Limiter:
    """brickwall lookahead limiter: required gain -> min over the lookahead window ->
    release recovery -> box average over the window; |y| <= ceiling by construction
    (plus a final clip for float rounding)"""

    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.r = 1.0
        self.last_gr = 0.0
        self.max_gr = 0.0
        self.update()

    def update(self):
        n = max(1, ms_to_samples(self.p["lookahead_ms"], self.fs))
        if getattr(self, "n", None) != n:
            self.n = n
            self.req_hist = np.ones(n)        # g_req of the last n samples
            self.r_hist = np.ones(n - 1)      # recovered gain of the last n-1 samples
            self.x_hist = np.zeros(n)         # delay line
        self.latency = self.n
        self.ceiling = db_to_lin(self.p["ceiling_db"])
        self.rel = time_coeff(self.p["release_ms"], self.fs)

    def process(self, x):
        if not len(x):
            return x
        n = self.n
        req = np.minimum(1.0, self.ceiling / np.maximum(np.abs(x), EPS))
        both = np.concatenate([self.req_hist, req])
        # m[i] = min(req over the n + 1 samples ending at i)
        m = np.lib.stride_tricks.sliding_window_view(both, n + 1).min(axis=1)
        self.req_hist = both[-n:]
        # release: gain rises with the release time constant, never above m
        r = np.empty(len(m))
        g = self.r
        rel = self.rel
        for i, v in enumerate(m.tolist()):
            g = 1.0 - rel * (1.0 - g)
            if v < g:
                g = v
            r[i] = g
        self.r = g
        rb = np.concatenate([self.r_hist, r])
        gain = np.lib.stride_tricks.sliding_window_view(rb, n).mean(axis=1)
        self.r_hist = rb[-(n - 1):] if n > 1 else np.zeros(0)
        xb = np.concatenate([self.x_hist, x])
        delayed = xb[:len(x)]
        self.x_hist = xb[len(x):]
        y = np.clip(delayed * gain, -self.ceiling, self.ceiling)
        gr = 20 * math.log10(max(float(np.min(gain)), EPS))
        self.last_gr = 20 * math.log10(max(float(gain[-1]), EPS))
        self.max_gr = min(self.max_gr, gr)
        return y

    def stats(self):
        out = {"gr_db": round(self.last_gr, 2), "gr_max_db": round(self.max_gr, 2)}
        self.max_gr = 0.0
        return out


class Gate:
    """noise gate (ratio <= 1: open/closed with hysteresis and hold) or downward
    expander (ratio > 1); attenuation limited to range_db"""

    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.det = Detector(fs, dict(p, detector="rms"))
        self.open = False
        self.hold = 0
        self.g = float(p["range_db"])
        self.last_gr = 0.0
        self.update()

    latency = 0

    def update(self):
        self.det.p = dict(self.p, detector="rms")
        self.det.update()
        self.att = time_coeff(self.p["attack_ms"], self.fs)
        self.rel = time_coeff(self.p["release_ms"], self.fs)
        self.hold_n = ms_to_samples(self.p["hold_ms"], self.fs)

    def process(self, x):
        if not len(x):
            return x
        level = self.det.level_db(x)
        thr = float(self.p["threshold_db"])
        rng = -abs(float(self.p["range_db"]))
        ratio = float(self.p["ratio"])
        if ratio > 1:
            target = np.clip((level - thr) * (ratio - 1), rng, 0.0)
            target = np.where(level >= thr, 0.0, target)
        else:
            close_at = thr - abs(float(self.p["hysteresis_db"]))
            target = np.empty(len(level))
            is_open, hold = self.open, self.hold
            for i, v in enumerate(level.tolist()):
                if v >= thr:
                    is_open, hold = True, self.hold_n
                elif is_open and v < close_at:
                    if hold > 0:
                        hold -= 1
                    else:
                        is_open = False
                elif is_open:
                    hold = self.hold_n
                target[i] = 0.0 if is_open else rng
            self.open, self.hold = is_open, hold
        # attack = opening (gain rising), release = closing
        gr, self.g = smooth_gain(target, self.g, self.att, self.rel, attack_when_lower=False)
        self.last_gr = float(gr[-1])
        return x * 10 ** (gr / 20)

    def stats(self):
        return {"gr_db": round(self.last_gr, 2), "open": bool(self.open) if float(self.p["ratio"]) <= 1 else None}


class AudioAgc:
    """level AGC: RMS level to target_db within [min_gain_db, max_gain_db]; gain
    drops with attack_ms, recovers with release_ms; frozen below noise_floor_db"""

    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.det = Detector(fs, dict(p, detector="rms"))
        self.g = 0.0
        self.update()

    latency = 0

    def update(self):
        self.det.p = dict(self.p, detector="rms")
        self.det.update()
        self.att = time_coeff(self.p["attack_ms"], self.fs)
        self.rel = time_coeff(self.p["release_ms"], self.fs)

    def process(self, x):
        if not len(x):
            return x
        level = self.det.level_db(x)
        want = np.clip(float(self.p["target_db"]) - level, float(self.p["min_gain_db"]), float(self.p["max_gain_db"]))
        frozen = level < float(self.p["noise_floor_db"])
        out = np.empty(len(want))
        g = self.g
        att, rel = self.att, self.rel
        for i, (t, f) in enumerate(zip(want.tolist(), frozen.tolist())):
            if not f:
                g = t + (att if t < g else rel) * (g - t)
            out[i] = g
        self.g = g
        return x * 10 ** (out / 20)

    def stats(self):
        return {"gain_db": round(self.g, 2)}


# ---- noise reduction --------------------------------------------------------------

class Stft:
    """streaming sqrt-Hann STFT/ISTFT at 50% overlap (perfect reconstruction);
    callback(spectrum) -> spectrum per frame; latency n - hop"""

    def __init__(self, n, callback):
        self.n = n
        self.hop = n // 2
        self.window = np.sqrt(np.hanning(n + 1)[:n])   # periodic: w^2 sums to 1 at 50%
        self.inbuf = np.zeros(n - self.hop)
        self.ola = np.zeros(n)
        self.callback = callback
        self.latency = n - self.hop

    def process(self, x):
        data = np.concatenate([self.inbuf, x])
        out = []
        pos = 0
        while len(data) - pos >= self.n:
            frame = data[pos:pos + self.n]
            spec = self.callback(np.fft.rfft(frame * self.window))
            self.ola += np.fft.irfft(spec, self.n) * self.window
            out.append(self.ola[:self.hop].copy())
            self.ola = np.concatenate([self.ola[self.hop:], np.zeros(self.hop)])
            pos += self.hop
        self.inbuf = data[pos:]
        if not out:
            return np.zeros(0)
        return np.concatenate(out)


class Fifo:
    """keeps output length == input length behind a fixed delay"""

    def __init__(self, prefill):
        self.buf = np.zeros(prefill)

    def push_pop(self, y, n):
        self.buf = np.concatenate([self.buf, y])
        if len(self.buf) < n:
            # underflow (shouldn't happen): pad rather than shorten the stream
            self.buf = np.concatenate([np.zeros(n - len(self.buf)), self.buf])
        out, self.buf = self.buf[:n], self.buf[n:]
        return out


class SpectralNR:
    """spectral subtraction or decision-directed Wiener on a streaming STFT. Noise PSD:
    auto (minimum statistics), learn (average while learning), hold (frozen profile);
    learn_s > 0 learns the first seconds, then holds"""

    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.frames = 0
        self.update()

    def update(self):
        n = int(2 ** round(math.log2(max(64, float(self.p["frame_ms"]) * self.fs / 1000))))
        if getattr(self, "n", None) != n:
            self.n = n
            self.stft = Stft(n, self.frame)
            # the STFT emits whole hops; one hop of prefill keeps output length == input
            self.fifo = Fifo(n // 2)
            bins = n // 2 + 1
            self.noise = None
            self.learned = np.zeros(bins)
            self.learned_frames = 0
            self.ps = None
            self.mins = []
            self.cur_min = np.full(bins, np.inf)
            self.sub_count = 0
            self.prev_clean = np.zeros(bins)
        self.latency = self.stft.latency + n // 2
        hop_s = (n // 2) / self.fs
        self.sub_len = max(1, int(round(float(self.p["window_s"]) / hop_s / 6)))

    def mode(self):
        mode = str(self.p["noise"])
        learn_s = float(self.p["learn_s"])
        if learn_s > 0:
            return "learn" if self.frames * (self.n // 2) / self.fs < learn_s else "hold"
        return mode

    def estimate(self, power):
        mode = self.mode()
        if mode == "learn":
            self.learned_frames += 1
            self.learned += (power - self.learned) / self.learned_frames
            self.noise = self.learned.copy()
            return
        if mode == "hold" and self.learned_frames:
            self.noise = self.learned
            return
        # minimum statistics: min of the smoothed PSD over ~window_s (6 sub-windows)
        self.ps = power if self.ps is None else 0.85 * self.ps + 0.15 * power
        self.cur_min = np.minimum(self.cur_min, self.ps)
        self.sub_count += 1
        if self.sub_count >= self.sub_len:
            self.mins = (self.mins + [self.cur_min])[-6:]
            self.cur_min = np.full(len(power), np.inf)
            self.sub_count = 0
        stack = self.mins + [self.cur_min]
        # bias compensation for the minimum of a smoothed periodogram
        self.noise = 1.8 * np.min(np.vstack(stack), axis=0)

    def frame(self, spec):
        self.frames += 1
        power = np.abs(spec) ** 2
        self.estimate(power)
        noise = np.maximum(self.noise, EPS)
        floor = db_to_lin(-abs(float(self.p["floor_db"])))
        alpha = float(self.p["strength"])
        if str(self.p["method"]) == "subtract":
            gain = np.sqrt(np.maximum(1 - alpha * noise / np.maximum(power, EPS), floor * floor))
        else:
            post = power / noise
            dd = float(self.p["smoothing"])
            prio = dd * self.prev_clean / noise + (1 - dd) * np.maximum(post - 1, 0)
            prio = prio / max(alpha, 1e-3)
            gain = np.maximum(prio / (1 + prio), floor)
        self.prev_clean = (gain ** 2) * power
        return spec * gain

    def process(self, x):
        y = self.stft.process(x)
        return self.fifo.push_pop(y, len(x))

    def stats(self):
        return {"noise": self.mode(), "noise_db": None if self.noise is None else round(float(10 * np.log10(np.mean(self.noise) + EPS)), 1)}


class Declick:
    """impulse detector on the 2nd difference against a running level (from earlier
    samples only, so a click can't raise its own threshold); marked runs, dilated by
    `width` and at most max_ms long, are replaced by linear interpolation between the
    clean neighbours. Needs lookahead for the run end: latency = max run + 2 width + 2.
    No detection during the first 3 level_ms (the level is still settling)."""

    def __init__(self, fs, p):
        self.fs, self.p = fs, p
        self.zi = np.zeros(1)
        self.prev = np.zeros(2)
        self.level = 0.0
        self.seen = 0
        self.edge = 0.0
        self.clicks = 0
        self.update()

    def update(self):
        self.max_run = max(1, ms_to_samples(self.p["max_ms"], self.fs))
        self.width = max(0, int(self.p["width"]))
        latency = self.max_run + 2 * self.width + 2
        if getattr(self, "latency", None) != latency:
            self.latency = latency
            self.x = np.zeros(latency)
            self.marks = np.zeros(latency, dtype=bool)
        self.a = time_coeff(float(self.p["level_ms"]), self.fs)
        self.warmup = 3 * ms_to_samples(self.p["level_ms"], self.fs)
        default = 4.0 if str(self.p["mode"]) == "crackle" else 8.0
        self.k = float(self.p["threshold"]) or default

    def detect(self, x):
        both = np.concatenate([self.prev, x])
        e = np.abs(both[2:] - 2 * both[1:-1] + both[:-2])
        self.prev = both[-2:]
        level, self.zi = signal.lfilter([1 - self.a], [1, -self.a], e, zi=self.zi)
        before = np.concatenate([[self.level], level[:-1]])
        self.level = float(level[-1])
        marks = e > self.k * np.maximum(before, 1e-5)
        n_warm = min(len(x), max(0, self.warmup - self.seen))
        marks[:n_warm] = False
        self.seen += len(x)
        return marks

    def process(self, x):
        if not len(x):
            return x
        new_marks = self.detect(x)
        xb = np.concatenate([self.x, x])
        mb = np.concatenate([self.marks, new_marks])
        if self.width and new_marks.any():
            idx = np.nonzero(new_marks)[0] + len(self.marks)
            for d in range(1, self.width + 1):
                mb[np.clip(idx - d, 0, len(mb) - 1)] = True
                mb[np.clip(idx + d, 0, len(mb) - 1)] = True
        n = len(x)
        longest = self.max_run + 2 * self.width
        y = xb[:n].copy()
        i = 0
        while i < n:
            if not mb[i]:
                i += 1
                continue
            j = i
            while j < len(mb) and mb[j] and j - i < longest:
                j += 1
            left = xb[i - 1] if i > 0 else self.edge
            right = xb[j] if j < len(xb) else left
            ramp = np.linspace(left, right, j - i + 2)[1:-1]
            stop = min(j, n)
            y[i:stop] = ramp[:stop - i]
            if j > n:
                # the run continues into the lookahead: fix it there too
                xb[n:j] = ramp[n - i:]
                mb[n:j] = False
            self.clicks += 1
            i = j
        self.edge = float(y[-1])
        self.x = xb[n:]
        self.marks = mb[n:]
        return y

    def stats(self):
        return {"clicks": self.clicks}


# ---- resampling + neural denoise ----------------------------------------------------

class StreamResampler:
    """rational polyphase resampler with state (chunk-independent); delay in input samples"""

    def __init__(self, fs_in, fs_out, taps_per_phase=32):
        frac = Fraction(fs_out / fs_in).limit_denominator(1000)
        self.up, self.down = frac.numerator, frac.denominator
        self.identity = self.up == self.down
        k = taps_per_phase
        n = self.up * k
        cutoff = 0.45 * min(1.0, self.up / self.down) / self.up
        h = signal.firwin(n, cutoff * 2, window=("kaiser", 8.0)) * self.up
        # polyphase: phase r uses h[r + k*up]
        self.k = k
        self.phases = np.stack([h[r::self.up] for r in range(self.up)])  # (up, k)
        self.hist = np.zeros(k - 1)
        self.t = 0          # next output index (in units of 1/up input samples)
        self.consumed = 0   # input samples consumed before hist end
        self.delay = (n - 1) / 2 / self.up   # input samples

    def process(self, x):
        if self.identity:
            return x
        buf = np.concatenate([self.hist, x])
        total = self.consumed + len(x)    # input samples seen
        # output m needs input index floor(m*down/up) <= total - 1
        start = self.t
        last = (total * self.up - 1) // self.down
        if last < start:
            self.hist = buf[-(self.k - 1):]
            self.consumed = total
            return np.zeros(0)
        m = np.arange(start, last + 1)
        pos = m * self.down
        idx = pos // self.up            # absolute input index
        ph = pos % self.up
        base = idx - (self.consumed - (self.k - 1))   # index into buf
        win = np.lib.stride_tricks.sliding_window_view(buf, self.k)  # win[j] = buf[j:j+k]
        # y = sum_i h_ph[i] * x[idx - i]  ->  window ending at idx, reversed taps
        y = np.einsum("ij,ij->i", win[base - (self.k - 1)][:, ::-1], self.phases[ph])
        self.t = last + 1
        self.hist = buf[-(self.k - 1):]
        self.consumed = total
        return y


class DenoiseBackend:
    """interface: rate, frame (samples per call at `rate`), latency (samples at rate),
    device, process(float32 frames) -> same length; status/ready for lazy loads"""
    name = "base"
    rate = 48000
    frame = 480
    latency = 0
    device = "cpu"
    ready = True
    status = "ready"

    def process(self, x):
        raise NotImplementedError

    def close(self):
        pass


class RnnoiseBackend(DenoiseBackend):
    """librnnoise via ctypes (system library, or MAILAB_RNNOISE_LIB); 480-sample frames
    at 48 kHz, input scaled to int16 range"""
    name = "rnnoise"
    rate = RNNOISE_RATE
    frame = RNNOISE_FRAME
    latency = 2 * RNNOISE_FRAME    # rnnoise's analysis window + overlap (measured: 2 frames)

    def __init__(self, p, log):
        path = os.environ.get("MAILAB_RNNOISE_LIB") or ctypes.util.find_library("rnnoise")
        if not path:
            raise RuntimeError("librnnoise not found: install the rnnoise package (Arch: pacman -S rnnoise; "
                               "Debian/Ubuntu: build xiph/rnnoise) or set MAILAB_RNNOISE_LIB")
        lib = ctypes.CDLL(path)
        lib.rnnoise_create.restype = ctypes.c_void_p
        lib.rnnoise_create.argtypes = [ctypes.c_void_p]
        lib.rnnoise_destroy.argtypes = [ctypes.c_void_p]
        lib.rnnoise_process_frame.restype = ctypes.c_float
        lib.rnnoise_process_frame.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.POINTER(ctypes.c_float)]
        if hasattr(lib, "rnnoise_get_frame_size"):
            lib.rnnoise_get_frame_size.restype = ctypes.c_int
            self.frame = int(lib.rnnoise_get_frame_size())
        self.lib = lib
        self.st = lib.rnnoise_create(None)
        self.vad = 0.0
        self.path = path

    def process(self, x):
        out = np.empty(len(x), dtype=np.float32)
        buf_in = np.empty(self.frame, dtype=np.float32)
        buf_out = np.empty(self.frame, dtype=np.float32)
        pin = buf_in.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
        pout = buf_out.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
        for i in range(0, len(x), self.frame):
            buf_in[:] = x[i:i + self.frame] * 32768.0
            self.vad = float(self.lib.rnnoise_process_frame(self.st, pout, pin))
            out[i:i + self.frame] = buf_out / 32768.0
        return out

    def close(self):
        if self.st:
            self.lib.rnnoise_destroy(self.st)
            self.st = None


def _in_venv():
    return sys.prefix != getattr(sys, "base_prefix", sys.prefix)


def _shim_torchaudio():
    """deepfilternet 0.5.6 imports torchaudio only for file I/O and a resampler we
    don't use (and its AudioMetaData import breaks on current torchaudio); a matching
    torchaudio for torch 2.15 doesn't exist, so stand in a stub when it's missing"""
    import importlib.util
    import types
    if "torchaudio" in sys.modules or importlib.util.find_spec("torchaudio") is not None:
        return
    ta = types.ModuleType("torchaudio")
    ta.__path__ = []
    backend = types.ModuleType("torchaudio.backend")
    common = types.ModuleType("torchaudio.backend.common")
    functional = types.ModuleType("torchaudio.functional")
    common.AudioMetaData = object

    def _no_resample(*_a, **_k):
        raise RuntimeError("torchaudio is stubbed in mailab; resample before DeepFilterNet")
    functional.resample = _no_resample
    ta.backend, backend.common, ta.functional = backend, common, functional
    sys.modules.update({"torchaudio": ta, "torchaudio.backend": backend,
                        "torchaudio.backend.common": common, "torchaudio.functional": functional})


def deepfilternet_install_commands():
    py = sys.executable
    pip = [py, "-m", "pip", "install", "--disable-pip-version-check", "--progress-bar", "off"]
    return [pip + ["--extra-index-url", TORCH_INDEX, TORCH_REQUIREMENT],
            pip + DF_REQUIREMENTS,
            pip + ["--no-deps"] + DF_NODEPS]


def deepfilternet_importable():
    import importlib.util
    return all(importlib.util.find_spec(m) is not None for m in ("torch", "df", "libdf"))


class DeepFilterNetBackend(DenoiseBackend):
    """DeepFilterNet3 (PyTorch, CUDA when available). Loads (and, inside the mailab
    venv, pip-installs the pinned torch/deepfilternet set) in a background thread;
    until then the denoise block passes audio through. Streaming: each hop is enhanced
    with context_ms of history and look_ms of future (model look-ahead), so the
    output is continuous; latency = look_ms (+ the hop the wrapper buffers)."""
    name = "deepfilternet"
    rate = DF_RATE

    def __init__(self, p, log):
        self.p, self.log = p, log
        self.frame = ms_to_samples(p["hop_ms"], self.rate)
        self.look = ms_to_samples(p["look_ms"], self.rate)
        self.ctx = ms_to_samples(p["context_ms"], self.rate)
        self.latency = self.look
        self.buf = np.zeros(self.look, dtype=np.float32)
        self.pos = 0
        self.ready = False
        self.status = "loading"
        self.error = None
        self.device = "?"
        threading.Thread(target=self._load, daemon=True).start()

    def _install(self):
        if not _in_venv():
            raise RuntimeError("DeepFilterNet is not installed and this python is not a venv; install: "
                               + " && ".join(" ".join(c[3:]) for c in deepfilternet_install_commands()))
        self.status = "installing"
        self.log("denoise: installing DeepFilterNet (%s from %s, %s) into %s — torch is a large download"
                 % (TORCH_REQUIREMENT, TORCH_INDEX, ", ".join(DF_REQUIREMENTS + DF_NODEPS), sys.prefix))
        for cmd in deepfilternet_install_commands():
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            tail = []
            for line in proc.stdout:
                line = line.strip()
                if line:
                    tail = (tail + [line])[-5:]
                    if line.startswith(("Collecting", "Downloading", "Installing", "Successfully", "Building")):
                        self.log("denoise: pip: " + line[:200])
            if proc.wait() != 0:
                raise RuntimeError("pip failed: " + " | ".join(tail))

    def _load(self):
        try:
            if not deepfilternet_importable():
                if not self.p.get("install", True):
                    raise RuntimeError("DeepFilterNet not installed (install=false)")
                self._install()
            self.status = "loading model"
            _shim_torchaudio()
            import torch
            import df.enhance
            # df/__init__ re-exports the enhance() function as df.enhance: take the module
            dfe = sys.modules["df.enhance"]
            want = str(self.p.get("device") or "auto")
            if want == "auto":
                want = "cuda" if torch.cuda.is_available() else "cpu"
            dev = torch.device(want)
            # init_df / enhance place tensors on df's get_device(); pin it to ours
            dfe.get_device = lambda: dev
            model, state, _ = dfe.init_df(log_level="ERROR", config_allow_defaults=True)
            self.torch, self.model, self.state, self.enhance = torch, model.to(dev), state, dfe.enhance
            self.device = str(dev) + (" (" + torch.cuda.get_device_name(dev) + ")" if dev.type == "cuda" else "")
            # warm-up so the first live hop doesn't pay for CUDA init
            self.enhance(self.model, self.state, torch.zeros(1, self.ctx + self.frame + self.look))
            self.ready = True
            self.status = "ready"
            self.log("denoise: DeepFilterNet3 ready on " + self.device)
        except Exception as err:   # surfaced through stats and the block error
            self.error = str(err)
            self.status = "error"
            self.log("denoise: DeepFilterNet unavailable: %s" % err, "error")

    def process(self, x):
        self.buf = np.concatenate([self.buf, x.astype(np.float32)])
        out = []
        while len(self.buf) - self.pos >= self.frame + self.look:
            start = max(0, self.pos - self.ctx)
            window = self.buf[start:self.pos + self.frame + self.look]
            with self.torch.no_grad():
                y = self.enhance(self.model, self.state, self.torch.from_numpy(np.ascontiguousarray(window)).unsqueeze(0))
            y = y.squeeze(0).numpy()
            out.append(y[self.pos - start:self.pos - start + self.frame])
            self.pos += self.frame
            drop = max(0, self.pos - self.ctx)
            self.buf, self.pos = self.buf[drop:], self.pos - drop
        if not out:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(out)


class MaxineBackend(DenoiseBackend):
    """NVIDIA Maxine Audio Effects SDK: proprietary, not bundled or downloaded. Only
    detection for now; the ctypes binding is a TODO once an SDK is installed here."""
    name = "maxine"

    def __init__(self, p, log):
        root = os.environ.get("MAILAB_MAXINE_DIR", "")
        hint = ("NVIDIA Maxine Audio Effects SDK is proprietary and not bundled: download it from "
                "https://developer.nvidia.com/maxine (NVIDIA developer account, accept the license), install it "
                "with its denoiser model for your GPU (RTX 50xx needs a Blackwell-capable SDK release), and start "
                "mailab with MAILAB_MAXINE_DIR=<sdk dir> (containing lib/libNVAudioEffects.so and models/)")
        if not root:
            raise RuntimeError("maxine: MAILAB_MAXINE_DIR is not set. " + hint)
        found = [os.path.join(d, "libNVAudioEffects.so") for d in (root, os.path.join(root, "lib"), os.path.join(root, "nvafx", "lib"))]
        lib = next((f for f in found if os.path.isfile(f)), None)
        if not lib:
            raise RuntimeError("maxine: libNVAudioEffects.so not found under %s. %s" % (root, hint))
        # TODO: bind NvAFX_CreateEffect / NvAFX_SetString(model path) / NvAFX_Load / NvAFX_Run
        raise RuntimeError("maxine: SDK found at %s, but the binding is not implemented yet (untested without the SDK); "
                           "use backend deepfilternet or rnnoise" % lib)


def _auto_backend(p, log):
    if deepfilternet_importable():
        try:
            import torch
            if torch.cuda.is_available():
                return DeepFilterNetBackend(p, log)
        except Exception as err:
            log("denoise: torch unusable (%s), falling back to rnnoise" % err, "warn")
    return RnnoiseBackend(p, log)


DENOISE_BACKENDS = {
    "auto": _auto_backend,
    "deepfilternet": DeepFilterNetBackend,
    "rnnoise": RnnoiseBackend,
    "maxine": MaxineBackend,
}


class Denoise:
    """neural denoise wrapper: resample to the model rate, buffer whole model frames,
    run the backend, resample back. Output keeps the input length behind a fixed
    delay (frame + backend latency + resamplers). While a backend loads, audio
    passes through (delayed the same way) so the stream never stops."""

    def __init__(self, fs, p, log=None):
        self.fs, self.p = fs, p
        self.log = log or (lambda *_a: None)
        self.backend = DENOISE_BACKENDS[str(p["backend"])](p, self.log)
        rate = self.backend.rate
        self.down = StreamResampler(fs, rate)
        self.up = StreamResampler(rate, fs)
        self.pending = np.zeros(0, dtype=np.float32)
        self.frame = int(self.backend.frame)
        self.fifo = Fifo(self.frame)
        # dry path delayed like the backend, for the wet/dry mix and the pass-through
        self.dry_delay = Delay(int(self.backend.latency))
        self.rtf = None
        self.busy = 0.0
        self.audio = 0.0
        delay_model = self.frame + self.backend.latency + (0 if self.down.identity else self.down.delay * rate / fs)
        resample_back = 0 if self.up.identity else self.up.delay * fs / rate
        self.latency = int(round(delay_model * fs / rate + resample_back))
        # two rational resamplers can lag the input count by a couple of samples
        self.out_fifo = Fifo(0 if self.down.identity else RESAMPLE_SLACK)
        self.latency += 0 if self.down.identity else RESAMPLE_SLACK
        self.update()

    def update(self):
        self.mix = min(1.0, max(0.0, float(self.p["mix"])))
        self.floor = db_to_lin(-abs(float(self.p["atten_db"]))) if float(self.p["atten_db"]) else 0.0

    def process(self, x):
        if not len(x):
            return x
        z = self.down.process(x).astype(np.float32)
        self.pending = np.concatenate([self.pending, z])
        whole = len(self.pending) - len(self.pending) % self.frame
        dry = self.pending[:whole]
        self.pending = self.pending[whole:]
        if whole:
            if self.backend.ready:
                t0 = time.perf_counter()
                wet = self.backend.process(dry)
                busy = time.perf_counter() - t0
                self.busy += busy
                self.audio += whole / self.backend.rate
                rtf = busy / (whole / self.backend.rate)
                self.rtf = rtf if self.rtf is None else 0.9 * self.rtf + 0.1 * rtf
                # mix: wet/dry; atten_db limits how far the noise is pushed down
                wet_part = self.mix * (1 - self.floor)
                y = wet_part * wet + (1 - wet_part) * self.dry_delay.process(dry)
            else:
                y = self.dry_delay.process(dry)
        else:
            y = np.zeros(0, dtype=np.float32)
        y = self.fifo.push_pop(y, len(z))
        back = self.up.process(y.astype(np.float64))
        return self.out_fifo.push_pop(back, len(x))

    def stats(self):
        out = {"backend": self.backend.name, "status": self.backend.status, "device": self.backend.device,
               "rtf": None if self.rtf is None else round(self.rtf, 4), "model_rate": self.backend.rate}
        if getattr(self.backend, "error", None):
            out["error"] = self.backend.error
        if hasattr(self.backend, "vad"):
            out["vad"] = round(self.backend.vad, 3)
        return out

    def close(self):
        self.backend.close()
