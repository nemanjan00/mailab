"""sync_mark regression checks: rising/falling edges are stamped with the
global sample index and an edge time inside the chunk's window, across odd
chunk sizes. Run directly (python3 python/test_sync.py) or via jest."""

import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import flowgraph_bridge as fb

RATE = 100000


def pulse_train(period, width, n, first=7):
    x = np.zeros(n)
    for start in range(first, n - width, period):
        x[start:start + width] = 1.0
    return x


def run_block(params, x, chunk=4097):
    marks = []
    fb.lab.value = lambda name, v: marks.append((name, v))
    fb.lab.sample = lambda *a, **k: None
    blk = fb.BLOCKS["sync_mark"]("mark", params)
    t0 = time.time()
    for i in range(0, len(x), chunk):
        blk.work(x[i:i + chunk], RATE)
    t1 = time.time()
    got = [v for name, v in marks if name == "mark_mark"]
    return got, (t0, t1)


def test_sync_mark():
    n = 100000
    x = pulse_train(period=10000, width=200, n=n)
    got, span = run_block({"level": 0.5, "edge": "rising", "min_gap_s": 0.001}, x)
    expect = list(range(7, n - 200, 10000))
    assert [m["index"] for m in got] == expect, ([m["index"] for m in got], expect)
    assert all(m["rate"] == RATE for m in got)
    # edge time assumes a contiguous back-to-back stream (now - (n-i)/rate),
    # so it stays inside the run's wall-clock window
    assert all(span[0] - 1 < m["t"] <= span[1] + 1 for m in got), [m["t"] for m in got]
    print("ok sync_mark")


def test_sync_mark_falling_and_complex():
    n = 60000
    x = 1.0 - pulse_train(period=15000, width=100, n=n)  # idle high, falling pulses
    xc = x.astype(np.float32) * (1 + 0j)  # complex samples, real part used
    got, _ = run_block({"level": 0.5, "edge": "falling", "min_gap_s": 0.001}, xc, chunk=3001)
    expect = list(range(7, n - 100, 15000))
    assert [m["index"] for m in got] == expect, ([m["index"] for m in got], expect)
    print("ok sync_mark_falling")


def test_sync_mark_min_gap():
    n = 100000
    x = pulse_train(period=100, width=20, n=n)  # 1 kHz pulses, min_gap 5 ms
    got, _ = run_block({"level": 0.5, "edge": "rising", "min_gap_s": 0.005}, x, chunk=4097)
    indices = [m["index"] for m in got]
    assert indices, "no marks"
    assert all(b - a >= int(0.005 * RATE) for a, b in zip(indices, indices[1:])), indices[:5]
    print("ok sync_mark_gap")


if __name__ == "__main__":
    test_sync_mark()
    test_sync_mark_falling_and_complex()
    test_sync_mark_min_gap()
    print("all sync tests ok")
