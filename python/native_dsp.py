"""On-demand compiled C helpers for DSP hot loops.

The decision-directed carrier-recovery PLL is inherently sequential (each
symbol's phase update depends on the previous decision), so it can't be
numpy-vectorized. This module compiles a tiny C shared object on first use
(SPEC.md libvolk row: "a small C helper first, then VOLK kernels there") and
falls back to the numpy loop in flowgraph_bridge when no C compiler exists.

The compiled artifact is cached in the system temp dir keyed by source hash;
rebuilds happen only when this file changes.
"""

import ctypes
import hashlib
import os
import subprocess
import tempfile

_SRC = r"""
/* decision-directed carrier-recovery PLL over one chunk of symbols */
#include <complex.h>
#include <math.h>
#include <stddef.h>

void dd_pll(const float complex *x, float complex *out, size_t n,
            const float complex *table, size_t m,
            double alpha, double beta, double *phase, double *freq)
{
    double ph = *phase, fr = *freq;
    for (size_t i = 0; i < n; i++) {
        float complex rot = (float complex)(cos(ph) - I * sin(ph)); /* exp(-j ph) */
        float complex y = x[i] * rot;
        /* nearest constellation point (min |y - t|^2) */
        size_t best = 0;
        float bestd = INFINITY;
        for (size_t k = 0; k < m; k++) {
            float dr = crealf(y) - crealf(table[k]);
            float di = cimagf(y) - cimagf(table[k]);
            float d = dr * dr + di * di;
            if (d < bestd) { bestd = d; best = k; }
        }
        float complex ref = table[best];
        /* err = angle(y * conj(ref)) = atan2(im(y conj ref), re(y conj ref)) */
        double err = atan2((double)(cimagf(y) * crealf(ref) - crealf(y) * cimagf(ref)),
                           (double)(crealf(y) * crealf(ref) + cimagf(y) * cimagf(ref)));
        fr += beta * err;
        ph += fr + alpha * err;
        out[i] = y;
    }
    *phase = ph;
    *freq = fr;
}
"""

_lib = None
_err = None


def lib():
    """-> the compiled helper library, or None when no C compiler works."""
    global _lib, _err
    if _lib is not None or _err is not None:
        return _lib
    cc = os.environ.get("CC", "cc")
    key = hashlib.sha256(_SRC.encode()).hexdigest()[:16]
    path = os.path.join(tempfile.gettempdir(), "mailab_dsp_%s.so" % key)
    try:
        if not os.path.exists(path):
            src = os.path.join(tempfile.gettempdir(), "mailab_dsp_%s.c" % key)
            with open(src, "w") as f:
                f.write(_SRC)
            tmp = "%s.tmp.%d" % (path, os.getpid())
            subprocess.run([cc, "-O2", "-shared", "-fPIC", src, "-o", tmp, "-lm"],
                           check=True, capture_output=True)
            os.replace(tmp, path)
        got = ctypes.CDLL(path)
        c_dbl_p = ctypes.POINTER(ctypes.c_double)
        got.dd_pll.restype = None
        got.dd_pll.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
                               ctypes.c_void_p, ctypes.c_size_t,
                               ctypes.c_double, ctypes.c_double,
                               c_dbl_p, c_dbl_p]
        _lib = got
    except Exception as e:  # no cc, failed compile, sandboxed tmp, ...
        _err = e
    return _lib
