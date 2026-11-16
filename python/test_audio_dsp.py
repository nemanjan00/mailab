"""Audio DSP regression checks (python/audio_dsp.py, audio_blocks.py). Run directly
(python3 python/test_audio_dsp.py) or via jest. Prints "ok <name>" / "skip <name>: why";
exits non-zero on the first failure."""

import os
import sys
import time

import numpy as np

import audio_blocks as B
import audio_dsp as A

FS = 48000.0
rng = np.random.default_rng(7)


def params(cls, **over):
    p = {k: v[0] for k, v in cls.params.items()}
    p.update(over)
    return p


def db(x):
    return 10 * np.log10(np.mean(np.asarray(x) ** 2) + 1e-30)


def tone(freq, seconds, amp=1.0, fs=FS, phase=0.0):
    t = np.arange(int(seconds * fs)) / fs
    return amp * np.sin(2 * np.pi * freq * t + phase)


def chunked(engine, x, sizes=None):
    sizes = sizes or [1, 7, 64, 480, 1000, 4096]
    out, i, k = [], 0, 0
    while i < len(x):
        n = sizes[k % len(sizes)]
        out.append(engine.process(x[i:i + n]))
        i += n
        k += 1
    return np.concatenate(out)


def band_power(x, freq, fs=FS, width=3.0):
    """power of x within +-width Hz of freq (Hann window, coherent)"""
    n = len(x)
    spec = np.abs(np.fft.rfft(x * np.hanning(n))) ** 2
    f = np.fft.rfftfreq(n, 1 / fs)
    sel = np.abs(f - freq) <= width
    return 10 * np.log10(np.sum(spec[sel]) + 1e-30)


def snr_vs(clean, y, delay):
    ref = clean[:len(clean) - delay] if delay else clean
    out = y[delay:]
    return 10 * np.log10(np.sum(ref ** 2) / np.sum((out - ref) ** 2))


CHECKS = []


def check(fn):
    CHECKS.append(fn)
    return fn


class Skip(Exception):
    pass


# ---- filters ----------------------------------------------------------------------

@check
def biquad_responses():
    f = lambda **kw: A.Biquad(FS, params(B.Biquad, **kw))
    lp = f(type="lowpass", freq=1000)
    h = 20 * np.log10(np.abs(lp.response([100, 1000, 10000])))
    assert abs(h[0]) < 0.1 and abs(h[1] + 3.01) < 0.1 and h[2] < -38, h
    lp2 = f(type="lowpass", freq=1000, stages=2)
    h2 = 20 * np.log10(np.abs(lp2.response([10000])))
    assert abs(h2[0] - 2 * h[2]) < 0.01, (h2, h)
    hp = f(type="highpass", freq=80)
    h = 20 * np.log10(np.abs(hp.response([20, 80, 1000])))
    assert h[0] < -20 and abs(h[1] + 3.01) < 0.1 and abs(h[2]) < 0.05, h
    notch = f(type="notch", freq=1000, q=10)
    h = 20 * np.log10(np.abs(notch.response([1000, 100, 10000, 900])) + 1e-30)
    assert h[0] < -100 and abs(h[1]) < 0.01 and abs(h[2]) < 0.01 and h[3] > -3, h
    pk = f(type="peaking", freq=2000, q=1, gain_db=6)
    h = 20 * np.log10(np.abs(pk.response([2000, 50, 20000])))
    assert abs(h[0] - 6) < 0.01 and abs(h[1]) < 0.1 and abs(h[2]) < 0.2, h
    ls = f(type="lowshelf", freq=200, gain_db=-6)
    hs = f(type="highshelf", freq=5000, gain_db=4)
    a = 20 * np.log10(np.abs(ls.response([20, 5000])))
    b = 20 * np.log10(np.abs(hs.response([100, 20000])))
    assert abs(a[0] + 6) < 0.2 and abs(a[1]) < 0.1 and abs(b[0]) < 0.1 and abs(b[1] - 4) < 0.3, (a, b)
    bp = f(type="bandpass", freq=1000, q=5)
    h = 20 * np.log10(np.abs(bp.response([1000, 100])))
    assert abs(h[0]) < 0.01 and h[1] < -25, h
    # simulated: steady 1 kHz through the notch is gone after it settles
    y = notch.process(tone(1000, 1.0))
    assert db(y[-4800:]) < -60, db(y[-4800:])


@check
def fir_response_and_latency():
    fir = A.Fir(FS, params(B.FirFilter, type="lowpass", freq=3000, taps=201, beta=8))
    _w, h = __import__("scipy.signal", fromlist=["freqz"]).freqz(fir.h, worN=[100, 2000, 5000, 10000], fs=FS)
    h = 20 * np.log10(np.abs(h))
    assert np.all(np.abs(h[:2]) < 0.05) and np.all(h[2:] < -60), h
    imp = np.zeros(400)
    imp[0] = 1
    assert int(np.argmax(fir.process(imp))) == fir.latency == 100


@check
def hum_notch_removes_harmonics():
    hum_freqs = [50, 100, 150, 200, 250, 350, 450]
    x = sum(tone(f, 4.0, 0.1 / (i + 1), phase=i) for i, f in enumerate(hum_freqs))
    voice = tone(1030, 4.0, 0.2)
    x = x + voice + 0.001 * rng.standard_normal(len(voice))
    hn = A.HumNotch(FS, params(B.HumNotch, freq=50, harmonics=10, width=2.0))
    y = hn.process(x)
    tail = slice(-int(2 * FS), None)
    for f in hum_freqs:
        before, after = band_power(x[tail], f), band_power(y[tail], f)
        assert before - after > 30, (f, before, after)
    assert abs(band_power(y[tail], 1030) - band_power(x[tail], 1030)) < 0.5
    auto = A.HumNotch(FS, params(B.HumNotch, freq="auto"))
    sixty = sum(tone(60 * k, 2.0, 0.1 / k) for k in range(1, 5)) + 0.001 * rng.standard_normal(int(2 * FS))
    chunked(auto, sixty, [4800])
    assert auto.f0 == 60.0, auto.f0
    # under speech-like audio (gliding 100-200 Hz harmonics) the weak 50 Hz series still wins
    auto50 = A.HumNotch(FS, params(B.HumNotch, freq="auto"))
    mixed = 0.3 * speech_like(2.0) / 0.2 + sum(tone(50 * k, 2.0, 0.05 / k, phase=k) for k in range(1, 8))
    chunked(auto50, mixed, [960])
    assert auto50.f0 == 50.0, auto50.f0


@check
def auto_notch_finds_tone():
    noise = 0.01 * rng.standard_normal(int(6 * FS))
    x = noise + tone(1234.5, 6.0, 0.3)
    an = A.AutoNotch(FS, params(B.AutoNotch))
    y = chunked(an, x, [960])
    tones = an.stats()["tones"]
    assert len(tones) == 1 and abs(tones[0]["freq"] - 1234.5) < 1.0, tones
    tail = slice(-int(1.5 * FS), None)
    removed = band_power(x[tail], 1234.5) - band_power(y[tail], 1234.5)
    assert removed > 25, removed
    # broadband noise mostly untouched
    assert abs(db(y[tail]) - db(noise[tail])) < 1.0, (db(y[tail]), db(noise[tail]))
    fixed = A.AutoNotch(FS, params(B.AutoNotch, freqs=[700, 1500], width=3))
    assert [t["freq"] for t in fixed.stats()["tones"]] == [700, 1500]


@check
def dc_block():
    x = 0.5 + tone(200, 2.0, 0.2)
    y = A.DcBlock(FS, params(B.DcBlock, cutoff=5)).process(x)
    assert abs(np.mean(y[-48000:])) < 1e-3


# ---- dynamics ------------------------------------------------------------------------

@check
def compressor_static_curve():
    thr, ratio, knee, makeup = -20.0, 4.0, 6.0, 3.0
    for level in (-40, -25, -21, -20, -18, -10, -3):
        c = A.Compressor(FS, params(B.Compressor, threshold_db=thr, ratio=ratio, knee_db=knee, makeup_db=makeup,
                                    attack_ms=1, release_ms=5, rms_ms=5))
        amp = np.sqrt(2) * 10 ** (level / 20)    # sine RMS = level dBFS
        y = c.process(tone(1000, 0.5, amp))
        got = db(y[-4800:])
        expect = level + float(A.static_curve(np.array([level]), thr, ratio, knee)[0]) + makeup
        assert abs(got - expect) < 0.3, (level, got, expect)


@check
def compressor_attack_release_timing():
    fs = FS
    p = params(B.Compressor, threshold_db=-30, ratio=10, knee_db=0, attack_ms=10, release_ms=100, detector="peak")
    c = A.Compressor(fs, p)
    quiet, loud = 10 ** (-50 / 20), 10 ** (-6 / 20)
    x = np.concatenate([np.full(int(0.1 * fs), quiet), np.full(int(0.5 * fs), loud), np.full(int(1.0 * fs), quiet)])
    gr = c.gain_db(x)
    final = float(A.static_curve(np.array([-6.0]), -30, 10, 0)[0])
    on = int(0.1 * fs)
    t63 = np.argmax(gr[on:] < 0.632 * final) / fs * 1000
    assert abs(t63 - 10) < 1.0, t63
    off = on + int(0.5 * fs)
    t_rel = np.argmax(gr[off:] > final * (1 - 0.632)) / fs * 1000
    assert abs(t_rel - 100) < 5, t_rel


@check
def compressor_lookahead_and_sidechain():
    c = A.Compressor(FS, params(B.Compressor, lookahead_ms=5, sidechain_hpf=200))
    assert c.latency == 240
    imp = np.zeros(1000)
    imp[10] = 0.001
    assert int(np.argmax(np.abs(c.process(imp)))) == 250
    # sidechain HPF: a loud 50 Hz tone barely triggers it
    c2 = A.Compressor(FS, params(B.Compressor, threshold_db=-30, sidechain_hpf=1000, detector="rms"))
    c2.process(tone(50, 0.5, 0.5))
    assert c2.last_gr > -1, c2.last_gr


@check
def limiter_ceiling():
    ceiling = -1.0
    lim = A.Limiter(FS, params(B.Limiter, ceiling_db=ceiling, lookahead_ms=5, release_ms=50))
    x = rng.standard_normal(int(3 * FS)) * 0.3 * (1 + 3 * (rng.random(int(3 * FS)) > 0.999))
    x += tone(300, 3.0, 1.5) * (np.arange(len(x)) % 24000 < 6000)
    y = chunked(lim, x)
    assert np.max(np.abs(y)) <= 10 ** (ceiling / 20) + 1e-12, np.max(np.abs(y))
    assert lim.stats()["gr_max_db"] < -6
    # below the ceiling: pure delay
    quiet = A.Limiter(FS, params(B.Limiter))
    s = tone(440, 0.5, 0.5)
    q = quiet.process(s)
    assert np.max(np.abs(q[quiet.latency:] - s[:-quiet.latency])) < 1e-12


@check
def gate_and_expander():
    fs = FS
    burst = tone(500, 0.3, 0.1)
    noise = 10 ** (-70 / 20) * rng.standard_normal(int(0.5 * fs))
    x = np.concatenate([noise, burst, noise])
    g = A.Gate(fs, params(B.Gate, threshold_db=-40, range_db=-60, hold_ms=50, attack_ms=1, release_ms=20))
    y = g.process(x)
    n0 = len(noise)
    # closed at the start, open during the burst, still open during hold, closed later
    assert db(y[:n0 - 4800]) < db(x[:n0 - 4800]) - 55
    assert abs(db(y[n0 + 2400:n0 + len(burst)]) - db(burst[2400:])) < 0.1
    end = n0 + len(burst)
    assert abs(db(y[end + 240:end + 1200]) - db(x[end + 240:end + 1200])) < 1.0   # hold (50 ms) keeps it open
    assert db(y[-9600:]) < db(x[-9600:]) - 55
    e = A.Gate(fs, params(B.Gate, threshold_db=-30, ratio=2, range_db=-40, attack_ms=1, release_ms=1, rms_ms=5))
    amp = np.sqrt(2) * 10 ** (-40 / 20)
    z = e.process(tone(1000, 0.5, amp))
    assert abs(db(z[-4800:]) - (-40 - 10)) < 0.5, db(z[-4800:])


@check
def audio_agc_levels():
    for level in (-40, -10):
        agc = A.AudioAgc(FS, params(B.AudioAgc, target_db=-20, attack_ms=20, release_ms=200, noise_floor_db=-60))
        amp = np.sqrt(2) * 10 ** (level / 20)
        y = agc.process(tone(1000, 3.0, amp))
        assert abs(db(y[-4800:]) + 20) < 1.0, (level, db(y[-4800:]))


# ---- noise reduction -------------------------------------------------------------------

def speech_like(seconds, fs=FS):
    """voiced bursts (250 ms on / 150 ms off), gliding pitch, 12 harmonics at 1/k"""
    n = int(seconds * fs)
    t = np.arange(n) / fs
    f0 = 150 + 50 * np.sin(2 * np.pi * 0.7 * t)
    phase = 2 * np.pi * np.cumsum(f0) / fs
    x = sum(np.sin(k * phase) / k for k in range(1, 13))
    gate = (t % 0.4) < 0.25
    env = np.convolve(gate.astype(float), np.hanning(481) / np.sum(np.hanning(481)), mode="same")
    return 0.2 * x * env


@check
def spectral_nr_learned_profile():
    clean = np.concatenate([np.zeros(int(FS)), tone(700, 3.0, 0.2)])
    noisy = clean + 0.05 * rng.standard_normal(len(clean))
    nr = A.SpectralNR(FS, params(B.SpectralNr, learn_s=1.0, floor_db=25))
    y = chunked(nr, noisy, [480])
    seg = slice(int(1.5 * FS), None)
    d = nr.latency
    before = snr_vs(clean[seg], noisy[seg], 0)
    after = snr_vs(clean[seg.start - d:], y[seg.start - d:], d)
    assert after - before > 10, (before, after)


@check
def spectral_nr_auto_speech():
    clean = speech_like(6.0)
    noisy = clean + 0.05 * rng.standard_normal(len(clean))   # ~9 dB SNR
    for method in ("wiener", "subtract"):
        nr = A.SpectralNR(FS, params(B.SpectralNr, method=method, floor_db=20))
        y = nr.process(noisy)
        d = nr.latency
        seg = slice(int(3 * FS), len(clean) - d)
        before = 10 * np.log10(np.sum(clean[seg] ** 2) / np.sum((noisy[seg] - clean[seg]) ** 2))
        after = 10 * np.log10(np.sum(clean[seg] ** 2) / np.sum((y[seg.start + d:seg.stop + d] - clean[seg]) ** 2))
        assert after - before > 3, (method, before, after)


@check
def declick_repairs_clicks():
    clean = tone(440, 2.0, 0.5) + 0.001 * rng.standard_normal(int(2 * FS))
    x = clean.copy()
    where = np.arange(2400, len(x) - 100, 4800)
    x[where] += 0.8
    x[where + 1] -= 0.4
    dc = A.Declick(FS, params(B.Declick))
    y = chunked(dc, x, [333, 960])
    d = dc.latency
    err = np.abs(y[d:] - clean[:-d])
    assert np.max(err) < 0.05, np.max(err)
    assert dc.stats()["clicks"] == len(where), dc.stats()
    # clean audio: untouched (pure delay), no false positives
    dc2 = A.Declick(FS, params(B.Declick))
    y2 = dc2.process(clean)
    assert dc2.clicks == 0 and np.max(np.abs(y2[d:] - clean[:-d])) == 0


# ---- streaming properties ------------------------------------------------------------------

def engines():
    return [
        ("biquad", lambda: A.Biquad(FS, params(B.Biquad, type="peaking", freq=900, gain_db=5, stages=3))),
        ("fir", lambda: A.Fir(FS, params(B.FirFilter, type="bandpass"))),
        ("hum", lambda: A.HumNotch(FS, params(B.HumNotch, freq=60))),
        ("dc", lambda: A.DcBlock(FS, params(B.DcBlock))),
        ("compressor", lambda: A.Compressor(FS, params(B.Compressor, lookahead_ms=3, sidechain_hpf=100, detector="peak"))),
        ("limiter", lambda: A.Limiter(FS, params(B.Limiter, ceiling_db=-6))),
        ("gate", lambda: A.Gate(FS, params(B.Gate, threshold_db=-30))),
        ("agc", lambda: A.AudioAgc(FS, params(B.AudioAgc))),
        ("spectral_nr", lambda: A.SpectralNR(FS, params(B.SpectralNr))),
        ("declick", lambda: A.Declick(FS, params(B.Declick))),
        ("denoise", lambda: A.Denoise(16000.0, fake_params())),
    ]


@check
def chunk_size_independence():
    x = speech_like(2.0) * 3 + 0.01 * rng.standard_normal(int(2 * FS))
    x[5000] += 0.9
    for name, make in engines():
        whole = make().process(x)
        parts = chunked(make(), x)
        assert len(whole) == len(parts) == len(x), (name, len(whole), len(parts))
        assert np.max(np.abs(whole - parts)) < 1e-9, (name, np.max(np.abs(whole - parts)))


@check
def latency_stats_match():
    # a fresh engine's reported latency equals the measured delay of a pure-delay path
    cases = [
        ("fir", A.Fir(FS, params(B.FirFilter, type="lowpass", freq=20000, taps=63))),
        ("limiter", A.Limiter(FS, params(B.Limiter, lookahead_ms=4))),
        ("compressor", A.Compressor(FS, params(B.Compressor, threshold_db=0, lookahead_ms=2))),
        ("spectral_nr", A.SpectralNR(FS, params(B.SpectralNr, learn_s=0.0, noise="hold"))),
        ("declick", A.Declick(FS, params(B.Declick))),
        ("denoise", A.Denoise(16000.0, fake_params(gain=1.0))),
    ]
    for name, eng in cases:
        fs = 16000.0 if name == "denoise" else FS
        x = speech_like(1.0, fs)
        y = eng.process(x)
        corr = np.correlate(y, x[:len(x) // 2], mode="valid")
        measured = int(np.argmax(corr))
        assert abs(measured - eng.latency) <= 1, (name, measured, eng.latency)
    blk = B.Limiter("lim", {"lookahead_ms": 5})
    blk.work(np.zeros(480, dtype=np.complex64), 48000.0)
    s = blk.extra_stats()
    assert s["latency_samples"] == 240 and s["latency_ms"] == 5.0, s


# ---- neural denoise plumbing ------------------------------------------------------------

class FakeBackend(A.DenoiseBackend):
    name = "fake"
    rate = 48000
    frame = 480
    latency = 96
    device = "test"

    def __init__(self, p, log):
        self.gain = float(p.get("fake_gain", 0.5))
        self.hist = np.zeros(self.latency, dtype=np.float32)
        self.ready = not p.get("fake_loading")
        self.status = "ready" if self.ready else "loading"

    def process(self, x):
        assert len(x) % self.frame == 0
        both = np.concatenate([self.hist, x])
        self.hist = both[-self.latency:]
        return both[:len(x)] * self.gain


A.DENOISE_BACKENDS["fake"] = FakeBackend


def fake_params(gain=0.5, **over):
    return params(B.DenoiseBlock, backend="fake", fake_gain=gain, **over)


@check
def denoise_plumbing_fake_backend():
    log = []
    dn = A.Denoise(48000.0, fake_params(), log=lambda *a: log.append(a))
    x = tone(1000, 0.5, 0.5)
    y = chunked(dn, x, [100, 480, 1234])
    assert dn.latency == 480 + 96
    assert np.max(np.abs(y[dn.latency:] - 0.5 * x[:-dn.latency])) < 1e-6
    s = dn.stats()
    assert s["backend"] == "fake" and s["status"] == "ready" and s["rtf"] is not None and s["model_rate"] == 48000, s
    # 16 kHz stream: resampled to the model rate and back, gain preserved
    dn16 = A.Denoise(16000.0, fake_params())
    x16 = tone(440, 1.0, 0.5, fs=16000.0)
    y16 = chunked(dn16, x16, [160, 333])
    assert abs(db(y16[8000:]) - db(0.5 * x16[8000:])) < 0.1
    # mix and attenuation limit
    mix = A.Denoise(48000.0, fake_params(gain=0.0, mix=1.0, atten_db=12))
    z = mix.process(x)
    assert abs(db(z[mix.latency:]) - (db(x) - 12)) < 0.2
    # wet/dry mix: the dry path is delayed like the backend (no comb filtering)
    half = A.Denoise(48000.0, fake_params(gain=1.0, mix=0.5))
    h = half.process(x)
    assert np.max(np.abs(h[half.latency:] - x[:-half.latency])) < 1e-6
    # backend still loading: audio passes through with the same delay
    loading = A.Denoise(48000.0, fake_params(fake_loading=True))
    w = loading.process(x)
    assert np.max(np.abs(w[loading.latency:] - x[:-loading.latency])) < 1e-6
    # block wrapper: live mix change keeps the backend, backend change asks for a rebuild
    blk = B.DenoiseBlock("dn", {"backend": "fake"})
    blk.work(x.astype(np.complex64), 48000.0)
    backend = blk.dsp.backend
    assert blk.set_live("mix", 0.5) and blk.dsp.backend is backend and blk.dsp.mix == 0.5
    assert not blk.set_live("backend", "rnnoise")
    st = blk.extra_stats()
    assert st["latency_ms"] == 12.0 and st["device"] == "test", st


@check
def maxine_stub_explains():
    old = os.environ.pop("MAILAB_MAXINE_DIR", None)
    try:
        A.MaxineBackend({}, None)
        raise AssertionError("maxine stub should refuse")
    except RuntimeError as err:
        assert "MAILAB_MAXINE_DIR" in str(err) and "developer.nvidia.com/maxine" in str(err)
    finally:
        if old is not None:
            os.environ["MAILAB_MAXINE_DIR"] = old


@check
def rnnoise_backend():
    try:
        dn = A.Denoise(48000.0, params(B.DenoiseBlock, backend="rnnoise"))
    except RuntimeError as err:
        raise Skip(str(err))
    clean = speech_like(4.0)
    noisy = clean + 0.05 * rng.standard_normal(len(clean))
    t0 = time.perf_counter()
    y = chunked(dn, noisy, [960])
    rtf = (time.perf_counter() - t0) / 4.0
    d = dn.latency
    seg = slice(int(2 * FS), len(clean) - d)
    before = 10 * np.log10(np.sum(clean[seg] ** 2) / np.sum((noisy[seg] - clean[seg]) ** 2))
    after = 10 * np.log10(np.sum(clean[seg] ** 2) / np.sum((y[seg.start + d:seg.stop + d] - clean[seg]) ** 2))
    assert after - before > 3, (before, after)
    assert rtf < 1.0, rtf
    print("   rnnoise: SNR %.1f -> %.1f dB, rtf %.3f (whole wrapper), latency %d samples" % (before, after, rtf, d))


# ---- live params --------------------------------------------------------------------------

@check
def live_param_changes_keep_state():
    blk = B.Compressor("c", {"threshold_db": -30, "attack_ms": 1, "release_ms": 2000})
    blk.work(tone(1000, 0.3, 0.5), FS)
    gr = blk.dsp.g
    assert gr < -5
    assert blk.set_live("threshold_db", -10)
    assert blk.dsp.g == gr      # the envelope wasn't reset
    assert blk.set_live("bypass", True)
    y, _r = blk.work(tone(1000, 0.1, 0.5), FS)
    assert abs(np.max(np.abs(y)) - 0.5) < 1e-3
    try:
        blk.set_live("ratio", "nope")
        raise AssertionError("bad value accepted")
    except ValueError:
        assert blk.p["ratio"] == 4.0
    nr = B.SpectralNr("nr", {})
    assert not nr.set_live("frame_ms", 40) and nr.set_live("noise", "learn")


@check
def templates_build():
    known = set(B.BLOCKS) | {"audio_in", "audio_file", "soapy", "lowpass", "resample", "fm_demod", "am_demod",
                             "audio", "spectrum", "signal"}
    for name in B.TEMPLATES:
        spec = B.template(name, {"stream": "phone_mic"} if not name.startswith("sdr") else {})
        types = {b["type"] for b in spec["blocks"]}
        assert types <= known, (name, types - known)
        ids = {b["id"] for b in spec["blocks"]}
        assert all(a in ids and b in ids for a, b in spec["links"]), name
        after = next(b for b in spec["blocks"] if b["id"] == "spec_after")
        assert after["params"]["overlay"] == ["spec_before"]
    try:
        B.template("voice_cleanup", {})
        raise AssertionError("source required")
    except ValueError:
        pass


def main():
    only = sys.argv[1:]
    failed = 0
    for fn in CHECKS:
        if only and fn.__name__ not in only:
            continue
        t0 = time.perf_counter()
        try:
            fn()
            print("ok %s (%.2fs)" % (fn.__name__, time.perf_counter() - t0))
        except Skip as why:
            print("skip %s: %s" % (fn.__name__, why))
        except Exception as err:
            failed += 1
            print("FAIL %s: %r" % (fn.__name__, err))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
