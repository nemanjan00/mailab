"""802.11a/g-style OFDM modem (pure numpy), as flowgraph blocks.

This is an educational / signal-generation modem: it builds a baseband OFDM
waveform that *looks and demods like* real 802.11a/g, and a receiver that
packet-detects, corrects carrier offset, equalizes and recovers the bits. It
stays entirely in a loopback `channel` (there is NO transmit path here).

Physical layer, faithful pieces
--------------------------------
- 64-point IFFT/FFT, 20 MHz-style subcarrier layout (relative/baseband):
  48 data + 4 pilot subcarriers on indices -26..26, DC (0) nulled, 11 guard
  nulls (±27..±32 region) -> the ~16.6/20 "filled block" spectrum.
- Pilots at subcarriers {-21, -7, 7, 21} with the BPSK polarity pattern
  {1, 1, 1, -1}, scrambled per OFDM symbol by the standard length-127 pilot
  polarity sequence p_n.
- 16-sample cyclic prefix (0.8 us), 80-sample OFDM symbol.
- Preamble: Short Training Field (10x 16 = 160 samples, the standard S_{-26..26}
  short sequence) and Long Training Field (GI2 of 32 + 2x 64, the standard
  L_{-26..26} BPSK sequence) = 320 samples total.
- QAM per subcarrier with a selectable MCS-style scheme: BPSK / QPSK / 16-QAM /
  64-QAM (the 802.11a rate set), plus 256-QAM as an extra, with the 802.11
  Gray mapping and K_MOD normalization.
- A side-stream data scrambler (generator x^7 + x^4 + 1), as in 802.11.

Receiver: STF delay-16 autocorrelation packet detect; coarse CFO from the STF,
fine CFO from the LTF repetition; FFT; least-squares channel estimate from the
two LTF symbols; per-subcarrier zero-forcing equalization; pilot-based residual
common-phase-error correction; QAM demap; descramble -> bits.

Simplified vs the full standard (documented deltas)
---------------------------------------------------
- NO convolutional coding (R=1/2..3/4 K=7) and NO interleaving -> this is an
  *uncoded* OFDM link, so BER vs SNR follows the raw QAM curve, a few dB worse
  than a real coded 802.11 rate. The scrambler IS included.
- NO SIGNAL field (RATE/LENGTH header) and NO SERVICE/tail/pad framing: the
  receiver is told the scheme and symbol count instead of decoding them.
- NO windowing/ramping between symbols, single tap flat channel assumed for the
  pilot tracking. Good enough to lock, equalize and demod in loopback; not a
  bit-compatible 802.11 transmitter.
"""

import numpy as np

N_FFT = 64
N_CP = 16
SYM_LEN = N_FFT + N_CP          # 80
PILOT_SC = np.array([-21, -7, 7, 21])
PILOT_PATTERN = np.array([1.0, 1.0, 1.0, -1.0])
# used subcarriers -26..26 except DC; data = those minus the 4 pilots
USED_SC = np.array([k for k in range(-26, 27) if k != 0])
DATA_SC = np.array([k for k in range(-26, 27) if k != 0 and k not in PILOT_SC.tolist()])
N_DATA = len(DATA_SC)           # 48

# scheme -> bits per subcarrier
SCHEMES = {"bpsk": 1, "qpsk": 2, "qam16": 4, "qam64": 6, "qam256": 8}


def _bin(k):
    """subcarrier index (-32..31) -> numpy FFT bin (0..63)."""
    return k % N_FFT


# ---- scrambler (802.11 side stream, x^7 + x^4 + 1) ----------------------------

def scrambler_seq(n, state=0x7F):
    """n output bits of the 802.11 scrambler from a 7-bit state (default all ones)."""
    out = np.empty(n, dtype=np.uint8)
    s = state & 0x7F
    for i in range(n):
        fb = ((s >> 6) ^ (s >> 3)) & 1   # x^7 xor x^4
        out[i] = fb
        s = ((s << 1) | fb) & 0x7F
    return out


def scramble(bits, state=0x7F):
    bits = np.asarray(bits, dtype=np.uint8)
    return bits ^ scrambler_seq(len(bits), state)


# the standard length-127 pilot polarity sequence p_n is the scrambler output
# (all-ones init) mapped 0->+1, 1->-1; p_0 = +1.
_PILOT_POL = 1 - 2 * scrambler_seq(127, 0x7F).astype(np.float64)
_PILOT_POL = np.roll(_PILOT_POL, 1)   # spec convention starts the run at p_0 = 1
_PILOT_POL[0] = 1.0


def pilot_polarity(sym_index):
    return _PILOT_POL[sym_index % 127]


# ---- QAM mapping (Gray, 802.11 K_MOD normalization) ---------------------------

def _kmod(bps):
    if bps == 1:
        return 1.0
    n = 1 << (bps // 2)                 # points per axis
    return 1.0 / np.sqrt(2.0 * (n * n - 1) / 3.0)


def _gray(n):
    return n ^ (n >> 1)


def _axis_maps(bits_per_axis):
    """gray bit group (0..2^b-1) -> PAM level, and level -> gray group."""
    n = 1 << bits_per_axis
    levels = np.arange(n) * 2 - (n - 1)        # -(n-1)..(n-1)
    group_to_level = np.empty(n, dtype=np.float64)
    level_to_group = {}
    # group g -> binary index _gray(g) -> PAM level, and the inverse
    for g in range(n):
        group_to_level[g] = levels[_gray(g)]
        level_to_group[int(levels[_gray(g)])] = g
    return group_to_level, levels, level_to_group


def qam_mod(bits, scheme):
    """bits -> complex symbols for `scheme` (pads with 0 to a whole symbol)."""
    bps = SCHEMES[scheme]
    bits = np.asarray(bits, dtype=np.uint8)
    pad = (-len(bits)) % bps
    if pad:
        bits = np.concatenate([bits, np.zeros(pad, dtype=np.uint8)])
    groups = bits.reshape(-1, bps)
    if bps == 1:
        return (2.0 * groups[:, 0] - 1.0).astype(np.complex64)
    half = bps // 2
    g2l, _levels, _l2g = _axis_maps(half)
    w = 1 << np.arange(half - 1, -1, -1)
    i_idx = groups[:, :half] @ w
    q_idx = groups[:, half:] @ w
    sym = (g2l[i_idx] + 1j * g2l[q_idx]) * _kmod(bps)
    return sym.astype(np.complex64)


def qam_demap(sym, scheme):
    """complex symbols -> hard bits (inverse of qam_mod)."""
    bps = SCHEMES[scheme]
    sym = np.asarray(sym, dtype=np.complex64)
    if bps == 1:
        return (sym.real > 0).astype(np.uint8)
    half = bps // 2
    g2l, levels, l2g = _axis_maps(half)
    sym = sym / _kmod(bps)

    def axis_bits(vals):
        # nearest PAM level, then its gray group, MSB first
        idx = np.argmin(np.abs(vals[:, None] - levels[None, :]), axis=1)
        lv = levels[idx]
        groups = np.array([l2g[int(v)] for v in lv], dtype=np.uint32)
        shifts = np.arange(half - 1, -1, -1, dtype=np.uint32)
        return ((groups[:, None] >> shifts) & 1).astype(np.uint8)

    ib = axis_bits(sym.real)
    qb = axis_bits(sym.imag)
    return np.concatenate([ib, qb], axis=1).reshape(-1)


# ---- training sequences (802.11a, frequency domain, index -26..26) ------------

def _short_seq():
    s = np.zeros(53, dtype=np.complex64)      # index 0 -> subcarrier -26
    vals = {-24: 1 + 1j, -20: -1 - 1j, -16: 1 + 1j, -12: -1 - 1j, -8: -1 - 1j,
            -4: 1 + 1j, 4: -1 - 1j, 8: -1 - 1j, 12: 1 + 1j, 16: 1 + 1j,
            20: 1 + 1j, 24: 1 + 1j}
    for k, v in vals.items():
        s[k + 26] = v
    return s * np.sqrt(13.0 / 6.0)


def _long_seq():
    return np.array([
        1, 1, -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1, 1, -1, -1, 1, 1, -1, 1,
        -1, 1, 1, 1, 1, 0, 1, -1, -1, 1, 1, -1, 1, -1, 1, -1, -1, -1, -1, -1,
        1, 1, -1, -1, 1, -1, 1, -1, 1, 1, 1, 1], dtype=np.complex64)


SHORT_SEQ = _short_seq()
LONG_SEQ = _long_seq()
# frequency-domain LTF reference on the full 64-bin grid (for channel est)
LTF_FREQ = np.zeros(N_FFT, dtype=np.complex64)
for _i, _k in enumerate(range(-26, 27)):
    LTF_FREQ[_bin(_k)] = LONG_SEQ[_i]


def _freq_to_time(seq53):
    """53-entry freq sequence (idx -26..26) -> 64 time samples via IFFT."""
    f = np.zeros(N_FFT, dtype=np.complex64)
    for i, k in enumerate(range(-26, 27)):
        f[_bin(k)] = seq53[i]
    return np.fft.ifft(f).astype(np.complex64)


def preamble():
    """Short + Long training fields = 320 complex samples."""
    short_t = _freq_to_time(SHORT_SEQ)              # 64 samples, periodic in 16
    stf = np.tile(short_t[:16], 10)                 # 160
    long_t = _freq_to_time(LONG_SEQ)                # 64
    ltf = np.concatenate([long_t[-32:], long_t, long_t])   # 32 + 64 + 64 = 160
    return np.concatenate([stf, ltf]).astype(np.complex64)


PREAMBLE = preamble()
STF_LEN = 160
LTF_LEN = 160
PREAMBLE_LEN = STF_LEN + LTF_LEN                   # 320


# ---- modulation ----------------------------------------------------------------

def data_symbols_from_bits(bits, scheme, n_sym=None):
    """bits -> list of 64-bin freq-domain OFDM symbols (data + pilots).

    Bits are padded (with a pseudo-random fill, not zeros) up to a whole number
    of OFDM symbols so every data subcarrier carries a real QAM point and the
    tail symbol does not dump origin points onto the constellation."""
    bps = SCHEMES[scheme]
    bits = np.asarray(bits, dtype=np.uint8)
    per_bits = N_DATA * bps
    if n_sym is None:
        n_sym = int(np.ceil(len(bits) / per_bits)) or 1
    need = n_sym * per_bits
    if len(bits) < need:
        fill = scrambler_seq(need - len(bits), 0x5A)   # spreads over the whole map
        bits = np.concatenate([bits, fill])
    qam = qam_mod(bits[:need], scheme).reshape(n_sym, N_DATA)
    syms = []
    data_bins = _bin(DATA_SC)
    pilot_bins = _bin(PILOT_SC)
    for s in range(n_sym):
        f = np.zeros(N_FFT, dtype=np.complex64)
        f[data_bins] = qam[s]
        f[pilot_bins] = PILOT_PATTERN * pilot_polarity(s)
        syms.append(f)
    return syms, n_sym


def modulate(bits, scheme="qpsk", n_sym=None, cp_len=N_CP, scramble_state=0x7F):
    """bits -> full baseband OFDM packet (preamble + payload), complex64.

    Returns (iq, info) where info has n_sym, scheme, bits_per_packet.
    """
    bps = SCHEMES[scheme]
    cp_len = int(cp_len)
    sbits = scramble(bits, scramble_state)
    freq_syms, n_sym = data_symbols_from_bits(sbits, scheme, n_sym)
    parts = [PREAMBLE]
    for f in freq_syms:
        t = np.fft.ifft(f).astype(np.complex64)
        parts.append(np.concatenate([t[-cp_len:], t]) if cp_len else t)   # add CP
    iq = np.concatenate(parts).astype(np.complex64)
    info = {"n_sym": n_sym, "scheme": scheme, "bps": bps, "cp_len": cp_len,
            "bits_per_packet": n_sym * N_DATA * bps, "len": len(iq)}
    return iq, info


# ---- receiver ------------------------------------------------------------------

def stf_metric(x, ns=16):
    """delay-ns autocorrelation detection metric M(d) in [0,1]."""
    x = np.asarray(x, dtype=np.complex64)
    if len(x) < 2 * ns:
        return np.zeros(0)
    prod = x[:-ns] * np.conj(x[ns:])
    win = np.ones(ns)
    p = np.convolve(prod, win, mode="valid")
    r = np.convolve(np.abs(x[ns:]) ** 2, win, mode="valid")
    m = np.abs(p) ** 2 / (r ** 2 + 1e-12)
    return m


def detect(x, threshold=0.6):
    """Find a packet start (sample index) via the STF autocorrelation plateau.

    Returns an approximate packet-start index or None.
    """
    m = stf_metric(x, 16)
    if not len(m):
        return None
    above = m > threshold
    if not np.any(above):
        return None
    # first sustained plateau (>= 32 samples)
    run = 0
    start = None
    for i, a in enumerate(above):
        if a:
            if run == 0:
                start = i
            run += 1
            if run >= 32:
                return max(0, start)
        else:
            run = 0
    return max(0, start) if start is not None else None


def _xcorr_ltf_start(x, approx_start):
    """Fine LTF timing: cross-correlate with the known long symbol to find the
    *first* of the two 64-sample LTF symbols. Both long symbols correlate
    equally well, so LTF1 is the earliest strong peak whose +64 neighbour is
    also strong (the second LTF symbol). Returns (index, normalized_peak) or
    None; the normalized peak (~1 for a real LTF, small for noise/data) lets
    the caller reject false locks."""
    long_t = _freq_to_time(LONG_SEQ)
    lnorm = np.linalg.norm(long_t)
    lo = max(0, approx_start + STF_LEN - 48)
    hi = min(len(x) - N_FFT, approx_start + STF_LEN + 176)
    if hi <= lo:
        return None
    corr = np.empty(hi - lo)
    for i, d in enumerate(range(lo, hi)):
        seg = x[d:d + N_FFT]
        corr[i] = np.abs(np.vdot(long_t, seg)) / (lnorm * np.linalg.norm(seg) + 1e-9)
    peak = corr.max()
    strong = corr >= 0.7 * peak
    # earliest strong cluster that repeats 64 samples later -> that is LTF1
    for i in range(len(corr) - N_FFT):
        if strong[i] and strong[i + N_FFT]:
            c = corr[i:min(len(corr), i + 24)]
            j = i + int(np.argmax(c))
            return lo + j, float(corr[j])
    # fallback: earliest strong peak, refined to its local max
    first = int(np.argmax(strong))
    first += int(np.argmax(corr[first:min(len(corr), first + 24)]))
    return lo + first, float(corr[first])


def _cfo_estimate(x, start):
    """coarse CFO (normalized, cycles/sample) from the STF, fine from the LTF."""
    stf = x[start:start + STF_LEN]
    coarse = 0.0
    if len(stf) >= 32:
        acc = np.vdot(stf[:-16], stf[16:])     # sum conj(a)*b over delay 16
        coarse = np.angle(acc) / (2 * np.pi * 16)
    return coarse


def demodulate(x, scheme="qpsk", n_sym=None, start=None, equalize=True,
               track_pilots=True, cp_len=N_CP):
    """Demodulate one packet from buffer `x`.

    Returns dict: bits, eq (equalized data subcarriers, complex),
    chan (64-bin channel estimate), cfo, ltf_start, ok.
    """
    bps = SCHEMES[scheme]
    if start is None:
        start = detect(x)
    if start is None:
        return {"ok": False, "bits": np.zeros(0, np.uint8), "eq": np.zeros(0, np.complex64)}

    # coarse CFO from STF, correct the whole window, then fine-time the LTF
    cfo = _cfo_estimate(x, start)
    k = np.arange(len(x))
    xc = x * np.exp(-2j * np.pi * cfo * k)

    found = _xcorr_ltf_start(xc, start)
    if found is None:
        return {"ok": False, "bits": np.zeros(0, np.uint8), "eq": np.zeros(0, np.complex64)}
    ltf0, ltf_q = found
    # reject a false lock (noise / gap / mid-packet): a real LTF correlates ~1
    if ltf_q < 0.5 or ltf0 + 128 > len(xc):
        return {"ok": False, "bits": np.zeros(0, np.uint8), "eq": np.zeros(0, np.complex64)}

    # fine CFO from the two LTF symbols (delay 64)
    l1 = xc[ltf0:ltf0 + N_FFT]
    l2 = xc[ltf0 + N_FFT:ltf0 + 2 * N_FFT]
    fine = np.angle(np.vdot(l1, l2)) / (2 * np.pi * N_FFT)
    xc = xc * np.exp(-2j * np.pi * fine * k)
    cfo_total = cfo + fine

    # channel estimate from the (now corrected) averaged LTF symbols
    l1 = xc[ltf0:ltf0 + N_FFT]
    l2 = xc[ltf0 + N_FFT:ltf0 + 2 * N_FFT]
    L = (np.fft.fft(l1) + np.fft.fft(l2)) / 2.0
    H = np.ones(N_FFT, dtype=np.complex64)   # null bins kept at 1 (unused)
    used = _bin(USED_SC)
    H[used] = L[used] / LTF_FREQ[used]

    cp_len = int(cp_len)
    sym_len = cp_len + N_FFT
    payload = ltf0 + 2 * N_FFT
    avail = (len(xc) - payload) // sym_len
    if n_sym is None:
        n_sym = avail
    n_sym = max(0, min(n_sym, avail))

    data_bins = _bin(DATA_SC)
    pilot_bins = _bin(PILOT_SC)
    all_bits = []
    eq_points = []
    for s in range(n_sym):
        base = payload + s * sym_len + cp_len
        t = xc[base:base + N_FFT]
        if len(t) < N_FFT:
            break
        F = np.fft.fft(t)
        if equalize:
            F = F / H
        if track_pilots:
            rx_p = F[pilot_bins]
            ref_p = PILOT_PATTERN * pilot_polarity(s)
            cpe = np.angle(np.vdot(ref_p, rx_p))   # common phase error
            F = F * np.exp(-1j * cpe)
        data = F[data_bins]
        eq_points.append(data)
        all_bits.append(qam_demap(data, scheme))

    bits = np.concatenate(all_bits) if all_bits else np.zeros(0, np.uint8)
    bits = descramble_rx(bits)
    eq = np.concatenate(eq_points) if eq_points else np.zeros(0, np.complex64)
    return {"ok": True, "bits": bits, "eq": eq, "chan": H, "cfo": cfo_total,
            "ltf_start": ltf0, "n_sym": n_sym}


def descramble_rx(bits, state=0x7F):
    return scramble(bits, state)   # scrambler is its own inverse


# ---- flowgraph blocks ---------------------------------------------------------
# duck-type flowgraph_bridge.Block so this file has no import cycle with it.

import time

import mailab_bridge as lab
import modem as _modem


def _input_bits(spec):
    """'hex:..' / 'text:..' / 'bits:0110' -> uint8 bit array."""
    kind, _, body = str(spec).partition(":")
    if kind == "hex":
        return _modem.unpack_bits(bytes.fromhex(body))
    if kind == "text":
        return _modem.unpack_bits(body.encode())
    if kind == "bits":
        return np.array([int(c) for c in body if c in "01"], dtype=np.uint8)
    raise ValueError("input must be hex:.. text:.. or bits:..")


class _Base:
    """minimal flowgraph Block duck-type (id, p, kind, params, counters)."""
    kind = "dsp"
    params = {}
    doc = ""
    inputs = ""
    outputs = ""

    def __init__(self, bid, params):
        self.id = bid
        self.p = {k: v[0] for k, v in self.params.items()}
        self.p.update(params or {})
        self.samples_in = 0
        self.samples_out = 0
        self.rate = None
        self.in_rate = None
        self._last = 0.0

    def _due(self, fps):
        now = time.monotonic()
        if now - self._last >= 1.0 / float(fps):
            self._last = now
            return True
        return False

    def close(self):
        pass


class OfdmMod(_Base):
    kind = "source"
    inputs = ""
    outputs = "complex IQ OFDM waveform at `rate` (continuous packets with a `gap`)"
    doc = ("802.11a/g-style OFDM transmitter (loopback signal source): 64-pt IFFT, 48 data + 4 pilot "
           "subcarriers, DC+guard nulls, 16-sample cyclic prefix, STF/LTF preamble, scrambled QAM per "
           "subcarrier. Modulates `input` bits (hex:/text:/bits:) and streams the packet continuously with "
           "a gap. scheme/mcs bpsk|qpsk|qam16|qam64|qam256. NOT real 802.11 (no conv-coding/interleaving/"
           "SIGNAL field) and NOT a transmitter - feed its output into `channel` -> `ofdm_demod`.")
    params = {"input": ("text:mAIlab OFDM ", "bits to modulate: hex:.. | text:.. | bits:.."),
              "scheme": ("qpsk", "bpsk|qpsk|qam16|qam64|qam256 (mcs alias accepted)"),
              "mcs": ("", "alias for scheme (bpsk|qpsk|qam16|qam64|qam256); overrides scheme if set"),
              "cp_len": (16, "cyclic prefix samples"), "n_sym": (0, "OFDM data symbols (0 = fit the input)"),
              "rate": (20e6, "sample rate (baseband; relative)"), "gap": (160, "zero samples between packets"),
              "amp": (1.0, "output amplitude")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        scheme = self.p["mcs"] or self.p["scheme"]
        if scheme not in SCHEMES:
            raise ValueError("scheme must be one of %s" % sorted(SCHEMES))
        bits = _input_bits(self.p["input"])
        n_sym = int(self.p["n_sym"]) or None
        iq, info = modulate(bits, scheme, n_sym=n_sym, cp_len=int(self.p["cp_len"]))
        self.packet = (float(self.p["amp"]) * iq).astype(np.complex64)
        self.info = info
        gap = max(0, int(self.p["gap"]))
        self.stream = np.concatenate([self.packet, np.zeros(gap, np.complex64)])
        self.pos = 0
        self.t = time.monotonic()

    def produce(self):
        now = time.monotonic()
        rate = float(self.p["rate"])
        count = int((now - self.t) * rate)
        if count <= 0:
            return None
        self.t += count / rate
        n = len(self.stream)
        idx = (self.pos + np.arange(count)) % n
        out = self.stream[idx]
        self.pos = int((self.pos + count) % n)
        return out.astype(np.complex64), rate


class OfdmDemod(_Base):
    kind = "dsp"
    inputs = "complex IQ (an ofdm_mod output, possibly through `channel`)"
    outputs = "recovered bits (to `bitview`/`ber`); traces <device>_<id>_const + <device>_<id>_chan"
    doc = ("802.11a/g-style OFDM receiver: STF autocorrelation packet-detect, coarse/fine CFO estimate+"
           "correct (STF then LTF), 64-pt FFT, LTF least-squares channel estimate, per-subcarrier zero-"
           "forcing equalize, pilot residual-phase (CPE) correction, QAM demap, descramble -> output bits. "
           "Publishes the equalized subcarrier constellation (trace <device>_<id>_const, mode constellation) "
           "and the channel estimate magnitude (trace <device>_<id>_chan). Loopback RX for ofdm_mod; set the "
           "same scheme, cp_len and n_sym as the transmitter.")
    params = {"scheme": ("qpsk", "bpsk|qpsk|qam16|qam64|qam256"), "mcs": ("", "alias for scheme"),
              "cp_len": (16, "cyclic prefix samples (match the transmitter)"),
              "n_sym": (0, "OFDM data symbols per packet (0 = all available after the LTF)"),
              "threshold": (0.6, "STF detection metric threshold"),
              "const_points": (2000, "equalized points kept in the constellation trace"),
              "publish_channel": (True, "publish the LTF channel-estimate trace"),
              "fps": (10, "trace updates per second")}

    def __init__(self, bid, params):
        super().__init__(bid, params)
        self.scheme = self.p["mcs"] or self.p["scheme"]
        if self.scheme not in SCHEMES:
            raise ValueError("scheme must be one of %s" % sorted(SCHEMES))
        self.cp_len = int(self.p["cp_len"])
        self.sym_len = self.cp_len + N_FFT
        self.n_sym = int(self.p["n_sym"]) or None
        self.buf = np.zeros(0, dtype=np.complex64)
        self.const = np.zeros(0, dtype=np.complex64)
        self.last_chan = None
        self.packets = 0

    def _need(self):
        nsym = self.n_sym or 1
        return PREAMBLE_LEN + nsym * self.sym_len + 2 * N_FFT

    def work(self, x, rate):
        self.rate = rate
        self.buf = np.concatenate([self.buf, np.asarray(x, dtype=np.complex64)])
        maxbuf = 8 * self._need()
        out_bits = []
        guard = 0
        while len(self.buf) >= self._need() and guard < 16:
            guard += 1
            start = detect(self.buf, float(self.p["threshold"]))
            if start is None:
                if len(self.buf) > maxbuf:
                    self.buf = self.buf[-self._need():]
                break
            nsym = self.n_sym
            span = start + PREAMBLE_LEN + (nsym or 1) * self.sym_len + 2 * N_FFT
            if span > len(self.buf):
                if start > 0:
                    self.buf = self.buf[start:]
                break
            r = demodulate(self.buf, self.scheme, n_sym=nsym, start=start, cp_len=self.cp_len)
            if not r["ok"] or r["n_sym"] <= 0:
                self.buf = self.buf[start + 16:]
                continue
            self.packets += 1
            out_bits.append(r["bits"])
            if len(r["eq"]):
                self.const = np.concatenate([self.const, r["eq"]])[-int(self.p["const_points"]):]
            self.last_chan = r["chan"]
            consumed = r["ltf_start"] + 2 * N_FFT + r["n_sym"] * self.sym_len
            self.buf = self.buf[max(consumed, start + 16):]
        self._publish()
        if out_bits:
            bits = np.concatenate(out_bits)
            bit_rate = rate * N_DATA * SCHEMES[self.scheme] / self.sym_len
            return bits.astype(np.uint8), bit_rate
        return None

    def _publish(self):
        if not self._due(self.p["fps"]):
            return
        if len(self.const):
            lab.trace(self.id + "_const", [], [{"label": "eq IQ",
                      "x": np.round(self.const.real, 4).tolist(),
                      "y": np.round(self.const.imag, 4).tolist()}], "I", "Q", "constellation")
        if self.p["publish_channel"] and self.last_chan is not None:
            k = np.arange(-N_FFT // 2, N_FFT // 2)
            mag = 20 * np.log10(np.abs(np.fft.fftshift(self.last_chan)) + 1e-9)
            used = np.isin(k % N_FFT, _bin(USED_SC))
            lab.trace(self.id + "_chan", k[used].tolist(),
                      [{"label": "|H| dB", "y": np.round(mag[used], 2).tolist()}],
                      "subcarrier", "dB")
        lab.sample(self.id + "_packets", self.packets, "")


BLOCKS = {"ofdm_mod": OfdmMod, "ofdm_demod": OfdmDemod}
