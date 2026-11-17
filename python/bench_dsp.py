#!/usr/bin/env python3
"""DSP hot-path benchmark: carrier recovery + modem demod.

Times the per-symbol loops that dominate CPU on flowgraphs with
carrier_recovery / demod / slicer blocks. Run: python3 python/bench_dsp.py
"""

import sys
import time

import numpy as np

sys.path.insert(0, __file__.rsplit("/", 1)[0])

import liquid_dsp as dsp
import modem as M
from flowgraph_bridge import CarrierRecovery, BLOCKS


def bench(name, fn, n_iter=5):
    best = min(fn()[0] for _ in range(n_iter))
    print("%-28s %8.1f us/call  (%d items)" % (name, best * 1e6, fn.items))
    return best


def timed(items):
    def deco(fn):
        def wrap():
            t0 = time.perf_counter()
            r = fn()
            wrap.items = items
            return time.perf_counter() - t0, r
        wrap.items = items
        return wrap
    return deco


N = 20000


def symbols(scheme="qpsk", cfo=0.01):
    rng = np.random.default_rng(3)
    m = dsp.Modem(scheme)
    idx, _ = M.bits_to_symbols(M.Prbs(9).bits(N * m.bps), m.bps)
    sym = m.modulate(idx)
    # rotate by a small carrier offset, like an unsynthed TX/RX pair
    n = np.arange(len(sym))
    return (sym * np.exp(2j * np.pi * cfo * n)).astype(np.complex64)


def main():
    x = symbols()

    # --- modem demod (liquid ctypes per sample) -----------------------------
    m = dsp.Modem("qpsk")

    @timed(N)
    def demod():
        return m.demodulate(x)
    bench("modem.demodulate", demod)

    @timed(N)
    def slicer_bits():
        return M.linear_demod_bits(m, x, "qpsk")
    bench("linear_demod_bits", slicer_bits)

    # --- carrier recovery (per-sample python loop) --------------------------
    blk = BLOCKS["carrier_recovery"]("cr", {"scheme": "qpsk", "bandwidth": 0.02})

    @timed(N)
    def carrec():
        blk.phase = 0.0
        blk.freq = 0.0
        return blk.work(x, 1.0)
    bench("carrier_recovery.work", carrec)

    # --- end-to-end: CFO'd qpsk through recovery + demod --------------------
    @timed(N)
    def chain():
        blk.phase = 0.0
        blk.freq = 0.0
        y, _ = blk.work(x, 1.0)
        return M.linear_demod_bits(m, y[400:], "qpsk")
    bench("recovery+demod chain", chain)
    bits = None
    blk.phase = 0.0
    blk.freq = 0.0
    y, _ = blk.work(x, 1.0)
    bits, evm = M.linear_demod_bits(m, y[400:], "qpsk")
    c = M.BerChecker(9)
    c.feed(bits)
    print("chain BER after lock: %.2e (evm %.1f dB)" % (c.ber, evm))


if __name__ == "__main__":
    main()
