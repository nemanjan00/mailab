"""Minimal ctypes bindings for liquid-dsp (libliquid): resampling and FM/AM demod.

Only what the SDR bridge needs; extend as required. Complex buffers are numpy
complex64 (same layout as liquid_float_complex), real buffers float32.
"""

import ctypes
import ctypes.util

import numpy as np

_lib = ctypes.CDLL(ctypes.util.find_library("liquid") or "libliquid.so")

_c_ptr = ctypes.c_void_p
_lib.msresamp_crcf_create.restype = _c_ptr
_lib.msresamp_crcf_create.argtypes = [ctypes.c_float, ctypes.c_float]
_lib.msresamp_crcf_execute.argtypes = [_c_ptr, _c_ptr, ctypes.c_uint, _c_ptr, ctypes.POINTER(ctypes.c_uint)]
_lib.msresamp_crcf_destroy.argtypes = [_c_ptr]
_lib.freqdem_create.restype = _c_ptr
_lib.freqdem_create.argtypes = [ctypes.c_float]
_lib.freqdem_demodulate_block.argtypes = [_c_ptr, _c_ptr, ctypes.c_uint, _c_ptr]
_lib.freqdem_destroy.argtypes = [_c_ptr]
_lib.ampmodem_create.restype = _c_ptr
_lib.ampmodem_create.argtypes = [ctypes.c_float, ctypes.c_int, ctypes.c_int]
_lib.ampmodem_demodulate_block.argtypes = [_c_ptr, _c_ptr, ctypes.c_uint, _c_ptr]
_lib.ampmodem_destroy.argtypes = [_c_ptr]

AM_DSB, AM_USB, AM_LSB = 0, 1, 2


def resample(iq, rate, stopband_db=60.0):
    """Arbitrary-rate resample of complex samples by `rate` (out/in)."""
    x = np.ascontiguousarray(iq, dtype=np.complex64)
    q = _lib.msresamp_crcf_create(ctypes.c_float(rate), ctypes.c_float(stopband_db))
    try:
        y = np.empty(int(np.ceil(len(x) * rate)) + 64, dtype=np.complex64)
        ny = ctypes.c_uint(0)
        _lib.msresamp_crcf_execute(q, x.ctypes.data, len(x), y.ctypes.data, ctypes.byref(ny))
        return y[:ny.value]
    finally:
        _lib.msresamp_crcf_destroy(q)


def fm_demod(iq, deviation, rate):
    """FM demodulate; output is scaled so full deviation is ~±1."""
    x = np.ascontiguousarray(iq, dtype=np.complex64)
    q = _lib.freqdem_create(ctypes.c_float(deviation / rate))
    try:
        y = np.empty(len(x), dtype=np.float32)
        _lib.freqdem_demodulate_block(q, x.ctypes.data, len(x), y.ctypes.data)
        return y
    finally:
        _lib.freqdem_destroy(q)


def am_demod(iq, kind=AM_DSB, mod_index=0.8):
    x = np.ascontiguousarray(iq, dtype=np.complex64)
    q = _lib.ampmodem_create(ctypes.c_float(mod_index), kind, 0)
    try:
        y = np.empty(len(x), dtype=np.float32)
        _lib.ampmodem_demodulate_block(q, x.ctypes.data, len(x), y.ctypes.data)
        return y
    finally:
        _lib.ampmodem_destroy(q)


def shift(iq, offset_hz, rate):
    """Move a signal at +offset_hz down to baseband."""
    n = np.arange(len(iq))
    return (iq * np.exp(-2j * np.pi * offset_hz / rate * n)).astype(np.complex64)
