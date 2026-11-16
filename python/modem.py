"""Digital modem building blocks (numpy + liquid-dsp), stateful for streaming.

Bits are numpy uint8 arrays of 0/1. Everything here is independent of the
flowgraph so it can be tested directly (python/test_modem.py).
"""

import numpy as np

import liquid_dsp as dsp
import protocol_decode

# PRBS polynomials x^a + x^b + 1 (ITU O.150 style)
PRBS_TAPS = {7: (7, 6), 9: (9, 5), 11: (11, 9), 15: (15, 14), 20: (20, 3), 23: (23, 18), 31: (31, 28)}

CPFSK = {
    # name: (bits per symbol, default h, gaussian BT or None)
    "2fsk": (1, 1.0, None),
    "4fsk": (2, 1.0 / 3, None),
    "msk": (1, 0.5, None),
    "gfsk": (1, 0.5, 0.5),
    "gmsk": (1, 0.5, 0.3),
}

# 4-FSK gray mapping: dibit -> level
FSK4_LEVELS = {0: -3, 1: -1, 3: 1, 2: 3}


def unpack_bits(data):
    return np.unpackbits(np.frombuffer(bytes(data), dtype=np.uint8))


def pack_bits(bits):
    bits = np.asarray(bits, dtype=np.uint8)
    return np.packbits(bits[: len(bits) - len(bits) % 8]).tobytes()


class Prbs:
    """Fibonacci LFSR pseudo-random bit source."""

    def __init__(self, order=9, seed=None):
        if order not in PRBS_TAPS:
            raise ValueError("prbs order must be one of %s" % sorted(PRBS_TAPS))
        self.order = order
        self.a, self.b = PRBS_TAPS[order]
        self.state = seed or (1 << order) - 1

    def bits(self, n):
        out = np.empty(n, dtype=np.uint8)
        s, a, b = self.state, self.a, self.b
        for i in range(n):
            bit = ((s >> (a - 1)) ^ (s >> (b - 1))) & 1
            s = ((s << 1) | bit) & ((1 << self.order) - 1)
            out[i] = bit
        self.state = s
        return out


class BerChecker:
    """Self-synchronizing PRBS checker: predicts each bit from the previous
    `order` received bits, so no alignment is needed. One line error shows up
    as 3 prediction errors (the bit itself and both taps), hence /3."""

    def __init__(self, order=9):
        self.order = order
        self.a, self.b = PRBS_TAPS[order]
        self.history = np.zeros(0, dtype=np.uint8)
        self.checked = 0
        self.errors = 0

    def feed(self, bits):
        data = np.concatenate([self.history, np.asarray(bits, dtype=np.uint8)])
        if len(data) > self.order:
            predicted = data[self.order - self.a:len(data) - self.a] ^ data[self.order - self.b:len(data) - self.b]
            actual = data[self.order:]
            self.errors += int(np.count_nonzero(predicted != actual))
            self.checked += len(actual)
        self.history = data[-self.order:]

    @property
    def ber(self):
        if not self.checked:
            return None
        return self.errors / 3.0 / self.checked

    def reset(self):
        self.checked = 0
        self.errors = 0


def bits_to_symbols(bits, bps):
    """MSB-first groups of bps bits -> symbol indices (leftover bits returned)."""
    usable = len(bits) - len(bits) % bps
    groups = np.asarray(bits[:usable], dtype=np.uint32).reshape(-1, bps)
    weights = 1 << np.arange(bps - 1, -1, -1, dtype=np.uint32)
    return groups @ weights, bits[usable:]


def symbols_to_bits(symbols, bps):
    s = np.asarray(symbols, dtype=np.uint32)[:, None]
    shifts = np.arange(bps - 1, -1, -1, dtype=np.uint32)
    return ((s >> shifts) & 1).astype(np.uint8).ravel()


def gaussian_taps(bt, sps, span=4):
    t = np.arange(-span * sps, span * sps + 1) / sps
    alpha = np.sqrt(np.log(2) / 2) / bt
    taps = np.sqrt(np.pi) / alpha * np.exp(-(np.pi * t / alpha) ** 2)
    return taps / taps.sum()


class LinearModulator:
    """Any liquid linear scheme (psk/qam/apsk/ask/ook/dpsk...) with RRC shaping."""

    def __init__(self, scheme, sps=8, beta=0.35):
        # liquid's OOK sends the carrier for symbol 0; the usual convention is bit 1 = on
        self.invert = scheme == "ook"
        self.modem = dsp.Modem(scheme)
        self.bps = self.modem.bps
        self.interp = dsp.RrcInterpolator(sps, beta=beta)
        self.pending = np.zeros(0, dtype=np.uint8)

    def process(self, bits):
        bits = np.asarray(bits, dtype=np.uint8)
        if self.invert:
            bits = bits ^ 1
        symbols, self.pending = bits_to_symbols(np.concatenate([self.pending, bits]), self.bps)
        if not len(symbols):
            return np.zeros(0, dtype=np.complex64)
        return self.interp.process(self.modem.modulate(symbols))


def linear_demod_bits(modem, symbols, scheme):
    """Complex symbols -> (bits, EVM dB) with the same bit conventions as LinearModulator."""
    idx, evm = modem.demodulate(symbols)
    bits = symbols_to_bits(idx, modem.bps)
    if scheme == "ook":
        bits = bits ^ 1
    return bits, evm


class CpfskModulator:
    """Continuous-phase FSK: 2FSK, 4FSK, MSK, GFSK, GMSK."""

    def __init__(self, scheme, sps=8, h=None, bt=None):
        bps, h0, bt0 = CPFSK[scheme]
        self.bps, self.sps = bps, sps
        self.h = h if h is not None else h0
        bt = bt if bt is not None else bt0
        self.taps = gaussian_taps(bt, sps) if bt else None
        self.phase = 0.0
        self.pending = np.zeros(0, dtype=np.uint8)
        self.tail = np.zeros(0)

    def process(self, bits):
        symbols, self.pending = bits_to_symbols(np.concatenate([self.pending, bits]), self.bps)
        if not len(symbols):
            return np.zeros(0, dtype=np.complex64)
        if self.bps == 1:
            levels = symbols.astype(np.float64) * 2 - 1
        else:
            levels = np.array([FSK4_LEVELS[int(s)] for s in symbols], dtype=np.float64)
        freq = np.repeat(levels, self.sps)
        if self.taps is not None:
            # filter across chunk boundaries with a carried tail
            joined = np.concatenate([self.tail, freq])
            filtered = np.convolve(joined, self.taps, mode="full")[len(self.tail):len(self.tail) + len(freq)]
            keep = len(self.taps) - 1
            self.tail = joined[-keep:] if keep else np.zeros(0)
            freq = filtered
        # phase advances pi*h per symbol for a unit level
        dphi = np.pi * self.h * freq / self.sps
        phase = self.phase + np.cumsum(dphi)
        self.phase = float(phase[-1] % (2 * np.pi))
        return np.exp(1j * phase).astype(np.complex64)


class Discriminator:
    """FM discriminator scaled so CPFSK levels come out as ±1 (±1, ±3 for 4FSK).
    `integrate` averages over one symbol (matched to the frequency pulse),
    which removes most Gaussian ISI: GMSK BT=0.3 goes from ~2e-2 to ~0 BER."""

    def __init__(self, sps, h, integrate=True):
        self.scale = sps / (np.pi * h)
        self.last = np.complex64(1)
        self.sps = int(sps)
        self.integrate = integrate
        self.tail = np.zeros(self.sps - 1, dtype=np.float32)

    def process(self, x):
        x = np.asarray(x, dtype=np.complex64)
        prev = np.concatenate([[self.last], x[:-1]])
        self.last = x[-1] if len(x) else self.last
        f = (np.angle(x * np.conj(prev)) * self.scale).astype(np.float32)
        if not self.integrate or self.sps < 2 or not len(f):
            return f
        joined = np.concatenate([self.tail, f])
        out = np.convolve(joined, np.ones(self.sps, dtype=np.float32) / self.sps, mode="valid")
        self.tail = joined[-(self.sps - 1):]
        return out.astype(np.float32)


class Gardner:
    """Gardner timing recovery: samples at sps per symbol in, one per symbol out.
    Works on real (FSK after discriminator, OOK magnitude) and complex input."""

    def __init__(self, sps, bandwidth=0.01, dc_block=False):
        self.sps = float(sps)
        self.gain = bandwidth
        self.buf = None
        self.pos = self.sps
        # unipolar signals (OOK magnitude) need their mean removed for the detector
        self.dc_block = dc_block
        self.mean = None

    def _at(self, t):
        i = int(t)
        f = t - i
        return self.buf[i] * (1 - f) + self.buf[i + 1] * f

    def process(self, x):
        x = np.asarray(x)
        if self.dc_block and len(x):
            m = float(np.mean(x))
            self.mean = m if self.mean is None else 0.95 * self.mean + 0.05 * m
            x = x - self.mean
        self.buf = x if self.buf is None else np.concatenate([self.buf, x])
        out = []
        half = self.sps / 2
        while self.pos + 1 < len(self.buf):
            cur = self._at(self.pos)
            mid = self._at(self.pos - half)
            prev = self._at(self.pos - self.sps) if self.pos - self.sps >= 0 else cur
            err = np.real((prev - cur) * np.conj(mid))
            out.append(cur)
            self.pos += self.sps + self.gain * float(np.clip(err, -1, 1)) * self.sps
        # drop consumed samples, keep one symbol of history for interpolation
        drop = max(0, int(self.pos - self.sps) - 1)
        self.buf = self.buf[drop:]
        self.pos -= drop
        return np.array(out, dtype=x.dtype if len(out) else np.float32)


class LevelSlicer:
    """Real symbols -> bits: 2 levels (threshold at the running mid point) or
    4 levels (4FSK gray)."""

    def __init__(self, levels=2):
        self.levels = levels
        self.lo = None
        self.hi = None

    def process(self, y):
        y = np.asarray(y, dtype=np.float64)
        if not len(y):
            return np.zeros(0, dtype=np.uint8)
        lo, hi = np.percentile(y, 5), np.percentile(y, 95)
        self.lo = lo if self.lo is None else 0.9 * self.lo + 0.1 * lo
        self.hi = hi if self.hi is None else 0.9 * self.hi + 0.1 * hi
        mid = (self.lo + self.hi) / 2
        if self.levels == 2:
            return (y > mid).astype(np.uint8)
        step = (self.hi - self.lo) / 3
        idx = np.clip(np.round((y - self.lo) / step), 0, 3).astype(int)
        # level index 0..3 = -3,-1,1,3 -> gray dibits
        dibits = np.array([0, 1, 3, 2])[idx]
        return symbols_to_bits(dibits, 2)


def find_sync(bits, word, max_errors=0):
    """Indices where `word` (0/1 array) starts in `bits` with ≤ max_errors bit errors."""
    bits = np.asarray(bits, dtype=np.int8)
    word = np.asarray(word, dtype=np.int8)
    n = len(word)
    if len(bits) < n:
        return []
    windows = np.lib.stride_tricks.sliding_window_view(bits, n)
    errors = np.count_nonzero(windows != word, axis=1)
    return [int(i) for i in np.nonzero(errors <= max_errors)[0]]


# ---- UART ---------------------------------------------------------------------

PARITY = ("none", "even", "odd")


def uart_encode(data, bits=8, parity="none", stop=1, idle=2):
    """bytes -> line levels at one sample per bit: idle high, start 0, data LSB
    first, optional parity, stop bits high, `idle` extra high bits per byte."""
    if parity not in PARITY:
        raise ValueError("parity must be none, even or odd")
    out = []
    for byte in bytes(data):
        frame = [0] + [(byte >> i) & 1 for i in range(bits)]
        if parity != "none":
            ones = sum(frame[1:])
            frame.append(ones % 2 if parity == "even" else 1 - ones % 2)
        frame += [1] * (stop + idle)
        out += frame
    return np.array(out, dtype=np.uint8)


class UartDecoder:
    """Line levels (oversampled by sps, real or 0/1) -> bytes with error flags.
    Threshold adapts to the signal (works on analog captures too). Thin
    wrapper over protocol_decode's UART (shared with the `decode` block)."""

    def __init__(self, sps=1.0, bits=8, parity="none", stop=1, invert=False):
        self.input = protocol_decode.LogicInput(invert=invert)
        self.line = protocol_decode.UartLine(sps, bits, parity, stop)

    def process(self, x):
        """-> list of (byte, error or None)"""
        words = self.input.process(np.asarray(x, dtype=np.float32))
        return [(value, error) for _ss, _es, value, error in self.line.process(words)]
