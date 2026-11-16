"""Flowgraph blocks for realtime audio: filters, dynamics, noise reduction, neural
denoise (engines in audio_dsp.py), plus graph templates (voice cleanup, SDR audio).

Blocks take real or complex input (the real part is used: audio_file / audio_in /
fm_demod output), keep state across chunks, accept live parameter changes through
set_param without restarting (set_live), and report latency and block-specific
stats (gain reduction, tracked tones, RTF/device) through extra_stats(). Dynamics
blocks publish gain reduction as channel <device>_<id>_gr.
"""

import time

import numpy as np

import audio_dsp as A
import mailab_bridge as lab


class AudioBlock:
    """duck-types flowgraph_bridge.Block (id, p, kind, params, work, close, counters)"""
    kind = "dsp"
    params = {}
    doc = ""
    inputs = "real audio (complex: real part)"
    outputs = "real audio, same rate"
    engine = None
    restart = ()          # params that need a rebuilt engine (state reset)
    channel = None        # (stat key, channel suffix, unit) published at `fps`

    def __init__(self, bid, params):
        self.id = bid
        self.p = {k: v[0] for k, v in self.params.items()}
        self.p.update(params or {})
        self.samples_in = 0
        self.samples_out = 0
        self.rate = None
        self.in_rate = None
        self.dsp = None
        self.bypass_delay = A.Delay()
        self._last = 0.0

    def build(self, fs):
        return self.engine(fs, self.p)

    def work(self, x, rate):
        x = np.real(np.asarray(x)).astype(np.float64)
        if self.dsp is None or self.rate != rate:
            self.close()
            self.rate = rate
            self.dsp = self.build(rate)
        y = self.dsp.process(x)
        # bypass keeps the engine running (state, stats) and the same delay, for A/B
        self.bypass_delay.resize(int(self.dsp.latency))
        dry = self.bypass_delay.process(x)
        if self.p.get("bypass"):
            y = dry
        self.publish()
        return y.astype(np.float32), rate

    def publish(self):
        if not self.channel or self.dsp is None:
            return
        now = time.monotonic()
        if now - self._last < 1.0 / max(0.1, float(self.p.get("fps", 10))):
            return
        self._last = now
        key, suffix, unit = self.channel
        value = getattr(self.dsp, key, None)
        if value is not None:
            lab.sample(self.id + "_" + suffix, round(float(value), 2), unit)

    def set_live(self, key, value):
        """apply a param change in place; False = the graph must rebuild this block"""
        if key in self.restart or (key not in self.params and key != "bypass"):
            return False
        default = self.params[key][0]
        numeric = isinstance(default, (int, float)) and not isinstance(default, bool)
        if numeric and value != "auto":     # hum_notch freq also takes "auto"
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise ValueError("%s must be a number, got %r" % (key, value))
        old = self.p.get(key)
        self.p[key] = value
        try:
            if self.dsp is not None:
                self.dsp.update()
        except Exception:
            self.p[key] = old
            self.dsp.update()
            raise
        return True

    def extra_stats(self):
        if self.dsp is None or not self.rate:
            return {}
        latency = int(self.dsp.latency)
        out = {"latency_samples": latency, "latency_ms": round(latency / self.rate * 1000, 2)}
        if self.p.get("bypass"):
            out["bypass"] = True
        out.update(self.dsp.stats())
        return out

    def close(self):
        if self.dsp is not None and hasattr(self.dsp, "close"):
            self.dsp.close()


COMMON = {"bypass": (False, "pass the input through (same delay; live A/B)")}
DYNAMICS = {"fps": (10, "gain-reduction channel updates per second")}
DETECTOR = {"detector": ("rms", "rms|peak"), "rms_ms": (5.0, "RMS window"),
            "sidechain_hpf": (0.0, "Hz, high-pass on the detector input (0 = off)")}


class Biquad(AudioBlock):
    doc = ("RBJ cookbook biquad: lowpass highpass bandpass notch peaking lowshelf highshelf allpass; "
           "`stages` identical sections in cascade (steeper). IIR: no added latency")
    params = dict(COMMON, type=("lowpass", "|".join(A.BIQUAD_TYPES)), freq=(1000.0, "Hz (corner / center)"),
                  q=(0.7071, "Q (notch/bandpass: f0 / bandwidth)"), gain_db=(0.0, "peaking / shelf gain"),
                  stages=(1, "cascaded sections"))
    engine = A.Biquad


class FirFilter(AudioBlock):
    doc = "linear-phase windowed-sinc FIR (Kaiser): lowpass highpass bandpass bandstop; latency (taps-1)/2"
    params = dict(COMMON, type=("lowpass", "lowpass|highpass|bandpass|bandstop"), freq=(3000.0, "cutoff / lower edge Hz"),
                  freq2=(6000.0, "upper edge Hz (band types)"), taps=(101, "odd"), beta=(6.0, "Kaiser beta (stopband)"))
    engine = A.Fir


class HumNotch(AudioBlock):
    doc = "mains hum remover: notches at f0 (50/60 Hz, or auto) and its harmonics, constant width in Hz (or Q)"
    params = dict(COMMON, freq=(50.0, "50 | 60 | auto (picked from the first second)"), harmonics=(10, "notches incl. f0"),
                  width=(2.0, "notch -3 dB width Hz"), q=(0.0, "fixed Q instead of width (0 = use width)"))
    engine = A.HumNotch


class AutoNotch(AudioBlock):
    doc = ("auto-tracking notch: finds the strongest stationary tones (long-term spectrum, min_snr_db above the floor, "
           "stable persist_s) and notches them, retuning as they drift; or notches the fixed `freqs` list")
    params = dict(COMMON, tones=(1, "max tones removed"), freqs=([], "fixed tone list Hz (disables tracking)"),
                  fmin=(80.0, "search range Hz"), fmax=(8000.0, "search range upper edge Hz"), width=(4.0, "notch width Hz"),
                  min_snr_db=(15.0, "peak above the median floor"), persist_s=(0.5, "a tone must last this long"),
                  hold_s=(2.0, "keep a notch this long after the tone fades"), retune_hz=(0.5, "retune when it drifts more"),
                  resolution=(2.0, "analysis resolution Hz"), average_s=(1.0, "spectrum averaging time"))
    engine = A.AutoNotch


class DcBlock(AudioBlock):
    doc = "DC blocker (one-pole high-pass)"
    params = dict(COMMON, cutoff=(10.0, "Hz"))
    engine = A.DcBlock


class Compressor(AudioBlock):
    inputs = "real audio (complex: real part)"
    outputs = "real audio, same rate; channel <device>_<id>_gr (gain reduction dB)"
    doc = ("dynamics compressor: threshold, ratio, soft knee, attack/release (on gain, dB), makeup, optional lookahead, "
           "RMS or peak detector, sidechain HPF; gain reduction -> channel <device>_<id>_gr")
    params = dict(COMMON, threshold_db=(-24.0, "dBFS"), ratio=(4.0, "input dB over threshold per output dB"), knee_db=(6.0, "soft knee width"),
                  attack_ms=(5.0, "gain-reduction time constant"), release_ms=(120.0, "recovery time constant"), makeup_db=(0.0, "gain added after compression"),
                  lookahead_ms=(0.0, "delays the audio so the gain leads transients"), **DETECTOR, **DYNAMICS)
    engine = A.Compressor
    channel = ("last_gr", "gr", "dB")


class Limiter(AudioBlock):
    inputs = "real audio (complex: real part)"
    outputs = "real audio, same rate; channel <device>_<id>_gr (gain reduction dB)"
    doc = "brickwall lookahead limiter: output never exceeds ceiling_db; gain reduction -> channel <device>_<id>_gr"
    params = dict(COMMON, ceiling_db=(-1.0, "dBFS"), lookahead_ms=(5.0, "= latency"), release_ms=(60.0, "gain recovery time constant"), **DYNAMICS)
    engine = A.Limiter
    channel = ("last_gr", "gr", "dB")


class Gate(AudioBlock):
    inputs = "real audio (complex: real part)"
    outputs = "real audio, same rate; channel <device>_<id>_gr (gain dB)"
    doc = ("noise gate (ratio 0: open above threshold, close below threshold - hysteresis after hold) or downward "
           "expander (ratio > 1); attenuation limited to range_db; gain -> channel <device>_<id>_gr")
    params = dict(COMMON, threshold_db=(-50.0, "dBFS (RMS)"), hysteresis_db=(6.0, "closes this far below threshold"), hold_ms=(50.0, "stay open after the level drops"),
                  attack_ms=(1.0, "opening"), release_ms=(100.0, "closing"), range_db=(-60.0, "max attenuation"),
                  ratio=(0.0, "0 = gate, > 1 = expander ratio"), rms_ms=(5.0, "level detector RMS window"), sidechain_hpf=(0.0, "Hz"), **DYNAMICS)
    engine = A.Gate
    channel = ("last_gr", "gr", "dB")


class AudioAgc(AudioBlock):
    inputs = "real audio (complex: real part)"
    outputs = "real audio, same rate; channel <device>_<id>_gain (dB)"
    doc = ("audio AGC: RMS level to target_db within min/max gain; attack (gain down) / release (gain up); "
           "holds the gain below noise_floor_db; gain -> channel <device>_<id>_gain")
    params = dict(COMMON, target_db=(-20.0, "dBFS RMS"), max_gain_db=(30.0, "most gain applied (quiet input)"), min_gain_db=(-20.0, "most attenuation (loud input)"),
                  attack_ms=(20.0, "gain-down time constant"), release_ms=(1000.0, "gain-up time constant"), noise_floor_db=(-55.0, "no gain changes below"),
                  rms_ms=(50.0, "level detector RMS window"), **DYNAMICS)
    engine = A.AudioAgc
    channel = ("g", "gain", "dB")


class SpectralNr(AudioBlock):
    doc = ("spectral noise reduction (STFT, sqrt-Hann 50%): wiener (decision-directed) or subtract; noise profile "
           "auto (minimum statistics), learn (set noise=learn during a noise-only segment, then hold) or learn_s at start")
    params = dict(COMMON, method=("wiener", "wiener|subtract"), strength=(1.0, "over-subtraction"),
                  floor_db=(15.0, "max attenuation dB"), noise=("auto", "auto|learn|hold"),
                  learn_s=(0.0, "learn the first seconds, then hold (0 = use `noise`)"),
                  frame_ms=(20.0, "STFT frame (rounded to 2^n samples); latency = half of it"),
                  window_s=(1.5, "minimum-statistics window"), smoothing=(0.98, "decision-directed a priori SNR"))
    engine = A.SpectralNR
    restart = ("frame_ms",)


class Declick(AudioBlock):
    doc = ("de-click / de-crackle: impulses found on the 2nd difference vs a running level are interpolated over; "
           "mode crackle uses a lower threshold; latency = max_ms + 2 width")
    params = dict(COMMON, mode=("click", "click|crackle"), threshold=(0.0, "x running level (0 = per mode: 8 / 4)"),
                  max_ms=(1.0, "longest click repaired"), width=(2, "samples added on both sides"),
                  level_ms=(5.0, "running level time constant"))
    engine = A.Declick


class DenoiseBlock(AudioBlock):
    doc = ("neural denoise: backend deepfilternet (DeepFilterNet3, PyTorch CUDA; installed into the mailab venv on "
           "first use: torch==2.15.0 cu134 + deepfilternet 0.5.6, audio passes through meanwhile), rnnoise (CPU, "
           "librnnoise), maxine (NVIDIA SDK, detection only), auto (deepfilternet if installed with CUDA, else rnnoise). "
           "Resamples to 48 kHz; stats: rtf, device, status, latency")
    params = dict(COMMON, backend=("auto", "auto|deepfilternet|rnnoise|maxine"), mix=(1.0, "wet/dry"),
                  atten_db=(0.0, "limit noise attenuation to this many dB (0 = unlimited)"),
                  hop_ms=(20.0, "deepfilternet: audio per inference (latency)"),
                  look_ms=(40.0, "deepfilternet: future context per hop (latency)"),
                  context_ms=(400.0, "deepfilternet: past context per hop (cost)"),
                  device=("auto", "deepfilternet: auto|cuda|cpu"), install=(True, "deepfilternet: pip install if missing"))
    restart = ("backend", "hop_ms", "look_ms", "context_ms", "device", "install")

    def build(self, fs):
        return A.Denoise(fs, self.p, log=lab.log)


BLOCKS = {
    "biquad": Biquad, "fir_filter": FirFilter, "hum_notch": HumNotch, "auto_notch": AutoNotch, "dc_block": DcBlock,
    "compressor": Compressor, "limiter": Limiter, "gate": Gate, "audio_agc": AudioAgc,
    "spectral_nr": SpectralNr, "declick": Declick, "denoise": DenoiseBlock,
}


# ---- templates -------------------------------------------------------------------

def _source(args, default=None):
    """{source: {type, params}} | {stream} (audio_in) | {path} (audio_file) | default"""
    if args.get("source"):
        src = args["source"]
        return {"id": "src", "type": src["type"], "params": dict(src.get("params") or {})}
    if args.get("stream"):
        return {"id": "src", "type": "audio_in", "params": {"stream": args["stream"]}}
    if args.get("path"):
        return {"id": "src", "type": "audio_file", "params": {"path": args["path"], "rate": 48000}}
    if default:
        return default
    raise ValueError("give source {type, params}, stream (lab audio, e.g. a browser mic) or path (media file)")


def _chain(src, front, chain, out_rate=48000):
    """src -> front (pre-processing, not in the 'before' spectrum) -> chain -> audio sink;
    spectrum 'before' (input to the chain) and 'after' (overlaying 'before')"""
    blocks = [src] + front + chain
    ids = [b["id"] for b in blocks]
    links = [[a, b] for a, b in zip(ids, ids[1:])]
    before = front[-1]["id"] if front else src["id"]
    last = ids[-1]
    spec = {"fft": 4096, "traces": ["avg"], "average": 8, "fps": 4}
    blocks += [{"id": "out", "type": "audio", "params": {"rate": out_rate}},
               {"id": "spec_before", "type": "spectrum", "params": dict(spec)},
               {"id": "spec_after", "type": "spectrum", "params": dict(spec, overlay=["spec_before"])}]
    links += [[last, "out"], [before, "spec_before"], [last, "spec_after"]]
    return {"blocks": blocks, "links": links}


def voice_cleanup(args):
    hum = args.get("hum", "auto")
    chain = [{"id": "hpf", "type": "biquad", "params": {"type": "highpass", "freq": 80, "stages": 2}},
             {"id": "hum", "type": "hum_notch", "params": {"freq": hum, "harmonics": 10}},
             {"id": "dn", "type": "denoise", "params": {"backend": args.get("backend", "auto")}},
             {"id": "comp", "type": "compressor", "params": {"threshold_db": -26, "ratio": 3, "attack_ms": 5, "release_ms": 150, "makeup_db": 6}},
             {"id": "lim", "type": "limiter", "params": {"ceiling_db": -1}}]
    return _chain(_source(args), [], chain)


def _sdr_front(args, demod):
    src = _source(args, {"id": "src", "type": "soapy", "params": {"args": args.get("args", ""), "freq": args.get("freq", 100e6),
                                                                 "rate": args.get("rate", 1e6), "gain": args.get("gain", 30)}})
    bw = float(args.get("bandwidth", 12.5e3 if demod["type"] == "fm_demod" else 10e3))
    front = [{"id": "chan", "type": "lowpass", "params": {"cutoff": bw / 2, "taps": 127}},
             {"id": "rs", "type": "resample", "params": {"rate": 48000}},
             demod,
             {"id": "dc", "type": "dc_block", "params": {"cutoff": 20}}]
    return src, front


def sdr_fm_audio(args):
    src, front = _sdr_front(args, {"id": "demod", "type": "fm_demod", "params": {"deviation": args.get("deviation", 5e3)}})
    chain = [{"id": "lpf", "type": "biquad", "params": {"type": "lowpass", "freq": 3400, "stages": 2}},
             {"id": "nr", "type": "spectral_nr", "params": {"floor_db": 12}},
             {"id": "agc", "type": "audio_agc", "params": {"target_db": -20}},
             {"id": "lim", "type": "limiter", "params": {"ceiling_db": -1}}]
    return _chain(src, front, chain)


def sdr_am_audio(args):
    src, front = _sdr_front(args, {"id": "demod", "type": "am_demod", "params": {"mode": args.get("mode", "am")}})
    chain = [{"id": "lpf", "type": "biquad", "params": {"type": "lowpass", "freq": 4500, "stages": 2}},
             {"id": "notch", "type": "auto_notch", "params": {"tones": 2}},
             {"id": "nr", "type": "spectral_nr", "params": {"floor_db": 12}},
             {"id": "agc", "type": "audio_agc", "params": {"target_db": -20}},
             {"id": "lim", "type": "limiter", "params": {"ceiling_db": -1}}]
    return _chain(src, front, chain)


def hum_removal(args):
    chain = [{"id": "dc", "type": "dc_block", "params": {}},
             {"id": "hum", "type": "hum_notch", "params": {"freq": args.get("hum", "auto"), "harmonics": 20}},
             {"id": "tone", "type": "auto_notch", "params": {"tones": 2}}]
    return _chain(_source(args), [], chain)


def broadcast(args):
    chain = [{"id": "hpf", "type": "biquad", "params": {"type": "highpass", "freq": 60}},
             {"id": "nr", "type": "spectral_nr", "params": {"floor_db": 10}},
             {"id": "eq", "type": "biquad", "params": {"type": "peaking", "freq": 3000, "q": 1.0, "gain_db": 3}},
             {"id": "comp", "type": "compressor", "params": {"threshold_db": -20, "ratio": 4, "knee_db": 8, "lookahead_ms": 3, "makeup_db": 6}},
             {"id": "lim", "type": "limiter", "params": {"ceiling_db": -1}}]
    return _chain(_source(args), [], chain)


TEMPLATES = {
    "voice_cleanup": ("HPF -> hum notch -> neural denoise -> compressor -> limiter -> audio, spectra before/after. "
                      "args: stream | path | source, hum (50|60|auto), backend", voice_cleanup),
    "sdr_fm_audio": ("NBFM voice: soapy -> channel lowpass -> 48 kHz -> fm_demod -> DC block -> 3.4 kHz LPF -> spectral NR "
                     "-> AGC -> limiter -> audio. args: args, freq, rate, gain, bandwidth, deviation | source", sdr_fm_audio),
    "sdr_am_audio": ("AM/SSB: soapy -> lowpass -> 48 kHz -> am_demod -> DC block -> 4.5 kHz LPF -> auto notch (heterodynes) "
                     "-> spectral NR -> AGC -> limiter -> audio. args: args, freq, rate, gain, bandwidth, mode | source", sdr_am_audio),
    "hum_removal": ("DC block -> 50/60 Hz hum notch (20 harmonics) -> auto tone notch -> audio. args: stream | path | source, hum",
                    hum_removal),
    "broadcast": ("HPF -> spectral NR -> presence EQ -> lookahead compressor -> limiter. args: stream | path | source", broadcast),
}


def template(name, args):
    if name not in TEMPLATES:
        raise ValueError("unknown template %r (%s)" % (name, ", ".join(TEMPLATES)))
    return TEMPLATES[name][1](args or {})
