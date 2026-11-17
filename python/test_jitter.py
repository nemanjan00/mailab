"""tie_jitter / cdr / eye_mask regression checks on synthetic vectors.
Run directly (python3 python/test_jitter.py) or via jest."""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import flowgraph_bridge as fb
import mailab_bridge as lab

RATE = 16e6
BITRATE = 1e6


def clock(jitter_ui=None, freq_offset=0.0, n=int(RATE * 0.02), seed=3):
    """Sine clock: one UI per half period, per-edge jitter / freq offset optional.
    A smooth waveform (unlike an ideal NRZ step) so interpolated mid
    crossings land exactly on the edge grid when jitter is zero."""
    rng = np.random.default_rng(seed)
    ui = (1.0 + freq_offset) / BITRATE
    t = np.arange(n) / RATE
    phase = np.pi * t / ui
    if jitter_ui:
        k = np.floor(t / ui + 0.5).astype(int)
        sig = np.zeros(int(t[-1] / ui) + 2)
        sig[1:len(sig)] = rng.normal(0, jitter_ui, len(sig) - 1)
        k = np.clip(k, 0, len(sig) - 1)
        phase = phase + np.pi * sig[k]
    return np.sin(phase)


def run_block(bid, params, x, chunk=4097):
    traces, samples, values = [], [], []
    real_trace, real_sample, real_value = lab.trace, lab.sample, lab.value
    lab.trace = lambda name, tx, series, xu="", yu="", mode="line": traces.append((name, tx, series, mode))
    lab.sample = lambda name, v, unit="": samples.append((name, v, unit))
    lab.value = lambda name, doc: values.append((name, doc))
    try:
        blk = fb.BLOCKS[bid](bid, params)
        for i in range(0, len(x), chunk):
            blk.work(x[i:i + chunk], RATE)
        blk.due = lambda: True  # force a final publish
        blk.work(np.zeros(0), RATE)
    finally:
        lab.trace, lab.sample, lab.value = real_trace, real_sample, real_value
    return traces, samples, values


def check(name, cond, detail=""):
    if not cond:
        raise SystemExit("FAIL %s %s" % (name, detail))
    print("ok", name)


# ---- tie_jitter -------------------------------------------------------------

_, _, values = run_block("tie_jitter", {"bitrate": BITRATE, "fps": 1000}, clock())
tie = [v for _, v in values][-1]
check("tie_clean", tie["rms_ui"] < 0.02, tie)

_, _, values = run_block("tie_jitter", {"bitrate": BITRATE, "fps": 1000}, clock(jitter_ui=0.1))
tie = [v for _, v in values][-1]
check("tie_jittery", 0.05 < tie["rms_ui"] < 0.15, tie)

# ---- cdr --------------------------------------------------------------------

_, samples, values = run_block("cdr", {"bitrate": BITRATE, "fps": 1000},
                               clock(freq_offset=0.004))  # 0.4 % slow
cdr = [v for _, v in values][-1]
want = BITRATE / 1.004
check("cdr_locks", cdr["locked"] == 1, cdr)
check("cdr_freq", abs(cdr["freq"] - want) < BITRATE * 0.001,
      "got %s want %s" % (cdr["freq"], want))
check("cdr_rms", cdr["rms_ui"] < 0.1, cdr)

_, _, values = run_block("cdr", {"bitrate": BITRATE, "fps": 1000}, clock())
cdr = [v for _, v in values][-1]
check("cdr_nominal", cdr["locked"] == 1 and abs(cdr["freq"] - BITRATE) < BITRATE * 0.001, cdr)

# ---- eye_mask ---------------------------------------------------------------

rng = np.random.default_rng(5)
bits = rng.integers(0, 2, 400)
sps = 8
# sharp NRZ: eye fully open, mask (centered on the crossing) must stay clean
x_sharp = np.repeat(bits * 2 - 1, sps).astype(np.float64)
x_sharp += rng.normal(0, 0.02, len(x_sharp))
# same bits through a moving average: transitions smear across the UI,
# samples linger mid-level inside the keep-out hexagon
win = np.ones(sps) / sps
x_smeared = np.convolve(x_sharp, win, mode="same")

_, _, values = run_block("eye_mask", {"sps": sps, "fps": 1000}, x_sharp)
m = [v for _, v in values][-1]
check("eye_mask_open", m["samples"] > 0 and m["hits"] == 0, m)

traces, _, values = run_block("eye_mask", {"sps": sps, "fps": 1000}, x_smeared)
m = [v for _, v in values][-1]
check("eye_mask_counts", m["hits"] > 0, m)
check("eye_mask_trace", bool(traces) and traces[-1][3] == "eye"
      and all(len(seg["y"]) for seg in traces[-1][2]), "eye trace missing")

_, _, values = run_block("eye_mask", {"sps": sps, "fps": 1000, "mask": "[[0.0, 1.5], [0.5, 1.5], [0.5, 2.0], [0.0, 2.0]]"}, x_smeared)
m = [v for _, v in values][-1]
check("eye_mask_zero_hits", m["hits"] == 0, m)

print("all jitter tests ok")
