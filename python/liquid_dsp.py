"""ctypes bindings for liquid-dsp (libliquid 1.6+).

One-shot helpers (resample, fm_demod, am_demod, shift) plus stateful classes
for streaming: state is kept between chunks, so filters, resamplers and loops
behave across block boundaries. Complex buffers are numpy complex64 (same
layout as liquid_float_complex), real buffers float32.
"""

import ctypes
import ctypes.util

import numpy as np

_lib = ctypes.CDLL(ctypes.util.find_library("liquid") or "libliquid.so")

_p = ctypes.c_void_p
_u = ctypes.c_uint
_f = ctypes.c_float
_i = ctypes.c_int


class _Complex(ctypes.Structure):
    _fields_ = [("re", ctypes.c_float), ("im", ctypes.c_float)]


def _sig(name, restype, *argtypes):
    fn = getattr(_lib, name)
    fn.restype = restype
    fn.argtypes = list(argtypes)
    return fn


_msresamp_create = _sig("msresamp_crcf_create", _p, _f, _f)
_msresamp_execute = _sig("msresamp_crcf_execute", _i, _p, _p, _u, _p, ctypes.POINTER(_u))
_msresamp_destroy = _sig("msresamp_crcf_destroy", _i, _p)
_freqdem_create = _sig("freqdem_create", _p, _f)
_freqdem_block = _sig("freqdem_demodulate_block", _i, _p, _p, _u, _p)
_freqdem_destroy = _sig("freqdem_destroy", _i, _p)
_ampmodem_create = _sig("ampmodem_create", _p, _f, _i, _i)
_ampmodem_block = _sig("ampmodem_demodulate_block", _i, _p, _p, _u, _p)
_ampmodem_destroy = _sig("ampmodem_destroy", _i, _p)
_ampmodem_mod_block = _sig("ampmodem_modulate_block", _i, _p, _p, _u, _p)
_freqmod_create = _sig("freqmod_create", _p, _f)
_freqmod_block = _sig("freqmod_modulate_block", _i, _p, _p, _u, _p)
_freqmod_destroy = _sig("freqmod_destroy", _i, _p)
_firfilt_create = _sig("firfilt_crcf_create_kaiser", _p, _u, _f, _f, _f)
_firfilt_block = _sig("firfilt_crcf_execute_block", _i, _p, _p, _u, _p)
_firfilt_destroy = _sig("firfilt_crcf_destroy", _i, _p)
_firfilt_rnyquist = _sig("firfilt_crcf_create_rnyquist", _p, _i, _u, _u, _f, _f)
_agc_create = _sig("agc_crcf_create", _p)
_agc_bandwidth = _sig("agc_crcf_set_bandwidth", _i, _p, _f)
_agc_block = _sig("agc_crcf_execute_block", _i, _p, _p, _u, _p)
_agc_destroy = _sig("agc_crcf_destroy", _i, _p)
_nco_create = _sig("nco_crcf_create", _p, _i)
_nco_set_frequency = _sig("nco_crcf_set_frequency", _i, _p, _f)
_nco_mix_down = _sig("nco_crcf_mix_block_down", _i, _p, _p, _p, _u)
_nco_destroy = _sig("nco_crcf_destroy", _i, _p)
_interp_create = _sig("firinterp_crcf_create_prototype", _p, _i, _u, _u, _f, _f)
_interp_block = _sig("firinterp_crcf_execute_block", _i, _p, _p, _u, _p)
_interp_destroy = _sig("firinterp_crcf_destroy", _i, _p)
_symsync_create = _sig("symsync_crcf_create_rnyquist", _p, _i, _u, _u, _f, _u)
_symsync_lf_bw = _sig("symsync_crcf_set_lf_bw", _i, _p, _f)
_symsync_execute = _sig("symsync_crcf_execute", _i, _p, _p, _u, _p, ctypes.POINTER(_u))
_symsync_destroy = _sig("symsync_crcf_destroy", _i, _p)
_modem_create = _sig("modemcf_create", _p, _i)
_modem_bps = _sig("modemcf_get_bps", _u, _p)
_modem_modulate = _sig("modemcf_modulate", _i, _p, _u, ctypes.POINTER(_Complex))
_modem_demodulate = _sig("modemcf_demodulate", _i, _p, _Complex, ctypes.POINTER(_u))
_modem_evm = _sig("modemcf_get_demodulator_evm", _f, _p)
_modem_destroy = _sig("modemcf_destroy", _i, _p)
_str2mod = _sig("liquid_getopt_str2mod", _i, ctypes.c_char_p)

AM_DSB, AM_USB, AM_LSB = 0, 1, 2
FIRFILT_RRC = 9
NCO = 0


def _c64(x):
    return np.ascontiguousarray(x, dtype=np.complex64)


def modulation(name):
    """'qpsk', 'bpsk', 'psk8', 'qam16', 'apsk16', ... -> liquid scheme id."""
    scheme = _str2mod(name.encode())
    if scheme == 0:
        raise ValueError("unknown modulation scheme: %s" % name)
    return scheme


# ---- one-shot helpers --------------------------------------------------------

def resample(iq, rate, stopband_db=60.0):
    """Arbitrary-rate resample of complex samples by `rate` (out/in)."""
    r = Resampler(rate, stopband_db)
    try:
        return r.process(iq)
    finally:
        r.close()


def fm_demod(iq, deviation, rate):
    """FM demodulate; output is scaled so full deviation is ~±1."""
    d = FmDemod(deviation, rate)
    try:
        return d.process(iq)
    finally:
        d.close()


def am_demod(iq, kind=AM_DSB, mod_index=0.8):
    d = AmDemod(kind, mod_index)
    try:
        return d.process(iq)
    finally:
        d.close()


def shift(iq, offset_hz, rate):
    """Move a signal at +offset_hz down to baseband."""
    n = np.arange(len(iq))
    return (iq * np.exp(-2j * np.pi * offset_hz / rate * n)).astype(np.complex64)


# ---- stateful streaming blocks ----------------------------------------------

class _Handle:
    _destroy = None

    def close(self):
        if self._q:
            type(self)._destroy(self._q)
            self._q = None

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


class Resampler(_Handle):
    _destroy = staticmethod(_msresamp_destroy)

    def __init__(self, rate, stopband_db=60.0):
        self.rate = rate
        self._q = _msresamp_create(rate, stopband_db)

    def process(self, x):
        x = _c64(x)
        y = np.empty(int(np.ceil(len(x) * self.rate)) + 64, dtype=np.complex64)
        ny = _u(0)
        _msresamp_execute(self._q, x.ctypes.data, len(x), y.ctypes.data, ctypes.byref(ny))
        return y[:ny.value]


class FmDemod(_Handle):
    _destroy = staticmethod(_freqdem_destroy)

    def __init__(self, deviation, rate):
        self._q = _freqdem_create(deviation / rate)

    def process(self, x):
        x = _c64(x)
        y = np.empty(len(x), dtype=np.float32)
        _freqdem_block(self._q, x.ctypes.data, len(x), y.ctypes.data)
        return y


class AmDemod(_Handle):
    _destroy = staticmethod(_ampmodem_destroy)

    def __init__(self, kind=AM_DSB, mod_index=0.8):
        self._q = _ampmodem_create(mod_index, kind, 0)

    def process(self, x):
        x = _c64(x)
        y = np.empty(len(x), dtype=np.float32)
        _ampmodem_block(self._q, x.ctypes.data, len(x), y.ctypes.data)
        return y


class AmMod(_Handle):
    """Real audio -> AM/DSB/USB/LSB baseband."""
    _destroy = staticmethod(_ampmodem_destroy)

    def __init__(self, kind=AM_DSB, mod_index=0.8, suppressed_carrier=False):
        self._q = _ampmodem_create(mod_index, kind, 1 if suppressed_carrier else 0)

    def process(self, m):
        m = np.ascontiguousarray(m, dtype=np.float32)
        y = np.empty(len(m), dtype=np.complex64)
        _ampmodem_mod_block(self._q, m.ctypes.data, len(m), y.ctypes.data)
        return y


class FmMod(_Handle):
    """Real audio -> FM baseband with `deviation` Hz for |m| = 1."""
    _destroy = staticmethod(_freqmod_destroy)

    def __init__(self, deviation, rate):
        self._q = _freqmod_create(deviation / rate)

    def process(self, m):
        m = np.ascontiguousarray(m, dtype=np.float32)
        y = np.empty(len(m), dtype=np.complex64)
        _freqmod_block(self._q, m.ctypes.data, len(m), y.ctypes.data)
        return y


class Lowpass(_Handle):
    """Kaiser-window FIR low-pass; cutoff relative to the sample rate (0..0.5)."""
    _destroy = staticmethod(_firfilt_destroy)

    def __init__(self, cutoff, taps=63, stopband_db=60.0):
        # liquid's Kaiser design isn't normalized (DC gain ~ 1 / (2 cutoff), +22 dB at
        # cutoff 0.04): measure the DC gain on a throwaway copy and scale to unity
        probe = _firfilt_create(taps, cutoff, stopband_db, 0.0)
        ones = np.ones(taps + 1, dtype=np.complex64)
        out = np.empty(len(ones), dtype=np.complex64)
        _firfilt_block(probe, ones.ctypes.data, len(ones), out.ctypes.data)
        _firfilt_destroy(probe)
        self.scale = 1.0 / (abs(out[-1]) or 1.0)
        self._q = _firfilt_create(taps, cutoff, stopband_db, 0.0)

    def process(self, x):
        x = _c64(x)
        y = np.empty(len(x), dtype=np.complex64)
        _firfilt_block(self._q, x.ctypes.data, len(x), y.ctypes.data)
        return y * np.float32(self.scale)


class MatchedFilter(_Handle):
    """Root-raised-cosine receive filter (matches RrcInterpolator), unit symbol energy."""
    _destroy = staticmethod(_firfilt_destroy)

    def __init__(self, sps, m=7, beta=0.35):
        self._q = _firfilt_rnyquist(FIRFILT_RRC, sps, m, beta, 0.0)
        self.scale = 1.0 / sps

    def process(self, x):
        x = _c64(x)
        y = np.empty(len(x), dtype=np.complex64)
        _firfilt_block(self._q, x.ctypes.data, len(x), y.ctypes.data)
        return y * self.scale


class Agc(_Handle):
    _destroy = staticmethod(_agc_destroy)

    def __init__(self, bandwidth=1e-3):
        self._q = _agc_create()
        _agc_bandwidth(self._q, bandwidth)

    def process(self, x):
        x = _c64(x)
        y = np.empty(len(x), dtype=np.complex64)
        _agc_block(self._q, x.ctypes.data, len(x), y.ctypes.data)
        return y


class Mixer(_Handle):
    """Shift by -offset_hz (continuous phase across chunks)."""
    _destroy = staticmethod(_nco_destroy)

    def __init__(self, offset_hz, rate):
        self._q = _nco_create(NCO)
        _nco_set_frequency(self._q, 2 * np.pi * offset_hz / rate)

    def process(self, x):
        x = _c64(x)
        y = np.empty(len(x), dtype=np.complex64)
        _nco_mix_down(self._q, x.ctypes.data, y.ctypes.data, len(x))
        return y


class RrcInterpolator(_Handle):
    """Upsample symbols by sps with a root-raised-cosine pulse."""
    _destroy = staticmethod(_interp_destroy)

    def __init__(self, sps, m=7, beta=0.35):
        self.sps = sps
        self._q = _interp_create(FIRFILT_RRC, sps, m, beta, 0.0)

    def process(self, symbols):
        x = _c64(symbols)
        y = np.empty(len(x) * self.sps, dtype=np.complex64)
        _interp_block(self._q, x.ctypes.data, len(x), y.ctypes.data)
        return y


class SymbolSync(_Handle):
    """Polyphase RRC symbol timing recovery: samples in, one sample per symbol out."""
    _destroy = staticmethod(_symsync_destroy)

    def __init__(self, sps, m=7, beta=0.35, filters=32, bandwidth=0.02):
        self._q = _symsync_create(FIRFILT_RRC, sps, m, beta, filters)
        _symsync_lf_bw(self._q, bandwidth)

    def process(self, x):
        x = _c64(x)
        y = np.empty(len(x) + 64, dtype=np.complex64)
        ny = _u(0)
        _symsync_execute(self._q, x.ctypes.data, len(x), y.ctypes.data, ctypes.byref(ny))
        return y[:ny.value]


class Modem(_Handle):
    """Linear modem (PSK/QAM/APSK...): constellation table, demod with EVM."""
    _destroy = staticmethod(_modem_destroy)

    def __init__(self, scheme="qpsk"):
        self._q = _modem_create(modulation(scheme))
        self.bps = _modem_bps(self._q)
        point = _Complex()
        table = []
        for s in range(1 << self.bps):
            _modem_modulate(self._q, s, ctypes.byref(point))
            table.append(complex(point.re, point.im))
        self.table = np.array(table, dtype=np.complex64)
        # cached views for the vectorized demodulator below
        self._t2 = self.table.real ** 2 + self.table.imag ** 2

    def modulate(self, symbols):
        return self.table[np.asarray(symbols) % len(self.table)]

    def demodulate(self, x):
        """-> (symbol indices, rms EVM in dB)

        Nearest constellation point, vectorized over the chunk (same
        decisions as liquid's per-sample modem_demodulate; EVM is the rms
        distance to the decided point, normalized by the constellation rms)."""
        y = np.ascontiguousarray(x, dtype=np.complex64).reshape(-1)
        if not len(y):
            return np.zeros(0, dtype=np.uint32), 0.0
        t, t2 = self.table, self._t2
        out = np.empty(len(y), dtype=np.uint32)
        esq = 0.0
        step = max(1, (1 << 22) // max(1, len(t)))  # bound the N x M scratch
        for j in range(0, len(y), step):
            b = y[j:j + step]
            # |y - t|^2 = |y|^2 + |t|^2 - 2 Re(y conj(t))
            d = (b.real[:, None] ** 2 + b.imag[:, None] ** 2) + t2[None, :] \
                - 2.0 * (b.real[:, None] * t.real[None, :] + b.imag[:, None] * t.imag[None, :])
            idx = np.argmin(d, axis=1)
            out[j:j + step] = idx
            e = b - t[idx]
            esq += float(np.vdot(e, e).real)
        evm = np.sqrt(esq / len(y) / (float(np.mean(t2)) + 1e-30))
        return out, float(20 * np.log10(evm + 1e-12))
