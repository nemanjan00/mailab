"""OFDM modem regression (python/ofdm.py): a loopback ofdm_mod -> channel ->
ofdm_demod must recover the bits at a low BER for every MCS, correct a carrier
offset, and have the right 802.11a structure. Run directly (python3
python/test_ofdm.py) or via jest. Needs numpy only (no liquid-dsp)."""

import numpy as np

import ofdm as O

rng = np.random.default_rng(1)

# (scheme, loopback SNR dB) - uncoded, so a few dB above the coded 802.11 points
MCS = [("bpsk", 12), ("qpsk", 15), ("qam16", 22), ("qam64", 28), ("qam256", 36)]


def awgn(x, snr):
    p = np.mean(np.abs(x) ** 2)
    s = np.sqrt(p / 10 ** (snr / 10) / 2)
    return (x + s * (rng.standard_normal(len(x)) + 1j * rng.standard_normal(len(x)))).astype(np.complex64)


def ber(rx, tx):
    n = min(len(rx), len(tx))
    return float(np.count_nonzero(rx[:n] != tx[:n])) / max(1, n)


def loopback(bits, scheme, snr, cfo=0.0, n_sym=None):
    iq, info = O.modulate(bits, scheme, n_sym=n_sym)
    buf = np.concatenate([np.zeros(300, np.complex64), iq, np.zeros(200, np.complex64)])
    buf = awgn(buf, snr)
    buf = buf * np.exp(2j * np.pi * cfo * np.arange(len(buf)))
    return O.demodulate(buf, scheme, n_sym=info["n_sym"], cp_len=info["cp_len"]), info


def test_ber():
    """Every MCS survives AWGN with a low BER (loopback mod -> channel -> demod)."""
    for scheme, snr in MCS:
        nbits = O.SCHEMES[scheme] * O.N_DATA * 40
        bits = rng.integers(0, 2, nbits).astype(np.uint8)
        r, _ = loopback(bits, scheme, snr, cfo=2e-4)
        assert r["ok"], "%s: packet not detected" % scheme
        b = ber(r["bits"], bits)
        assert b <= 1e-3, "%s: BER %.2e > 1e-3" % (scheme, b)
        print("ok ber %-7s snr=%2d BER=%.2e" % (scheme, snr, b))


def test_cfo():
    """Carrier frequency offset of a few kHz (scaled to 20 MHz) is estimated and
    corrected; BER stays low and the estimate tracks the true offset."""
    rate = 20e6
    bits = rng.integers(0, 2, 2 * O.N_DATA * 40).astype(np.uint8)
    for f_hz in (2000.0, -5000.0, 15000.0):
        cfo = f_hz / rate
        r, _ = loopback(bits, "qpsk", 25, cfo=cfo)
        assert r["ok"]
        est_hz = r["cfo"] * rate
        assert abs(est_hz - f_hz) < 1500.0, "cfo %g: est %g Hz" % (f_hz, est_hz)
        assert ber(r["bits"], bits) <= 1e-3, "cfo %g Hz: high BER" % f_hz
        print("ok cfo %+7.0f Hz est=%+8.1f Hz" % (f_hz, est_hz))


def test_structure():
    """Cyclic-prefix / preamble lengths and the subcarrier layout are 802.11a."""
    assert O.N_FFT == 64 and O.N_CP == 16 and O.SYM_LEN == 80
    assert O.STF_LEN == 160 and O.LTF_LEN == 160 and O.PREAMBLE_LEN == 320
    assert sorted(O.PILOT_SC.tolist()) == [-21, -7, 7, 21]
    assert O.N_DATA == 48 and len(O.USED_SC) == 52
    # STF is 10 x 16-sample repeats, LTF is GI2(32) + 2 x 64
    pre = O.PREAMBLE
    assert len(pre) == 320
    short = pre[:16]
    assert np.allclose(pre[:160].reshape(10, 16), short, atol=1e-6), "STF not 10x16"
    long_t = np.fft.ifft(O.LTF_FREQ).astype(np.complex64)
    assert np.allclose(pre[192:256], long_t, atol=1e-6), "LTF symbol 1 wrong"
    assert np.allclose(pre[256:320], long_t, atol=1e-6), "LTF symbol 2 wrong"
    assert np.allclose(pre[160:192], long_t[-32:], atol=1e-6), "LTF GI2 wrong"
    print("ok structure cp=16 fft=64 preamble=320 (STF 10x16, LTF 32+64+64)")


def test_pilots():
    """Pilot tones sit on subcarriers {-21,-7,7,21} with the right polarity, DC
    and guard subcarriers are nulled."""
    bits = rng.integers(0, 2, O.N_DATA * 3).astype(np.uint8)
    syms, n = O.data_symbols_from_bits(O.scramble(bits), "bpsk", 3)
    for s, f in enumerate(syms):
        assert f[0] == 0, "DC not nulled"
        for k in list(range(27, 32 + 1)) + list(range(-32, -26)):
            assert f[k % 64] == 0, "guard subcarrier %d not nulled" % k
        pol = O.pilot_polarity(s)
        for i, k in enumerate(O.PILOT_SC):
            want = O.PILOT_PATTERN[i] * pol
            assert abs(f[k % 64] - want) < 1e-6, "pilot %d wrong in sym %d" % (k, s)
    print("ok pilots at +-7,+-21 ; DC + guard nulled")


def test_detect():
    """STF autocorrelation packet detection finds the start at any offset."""
    bits = rng.integers(0, 2, 2 * O.N_DATA * 30).astype(np.uint8)
    iq, _ = O.modulate(bits, "qpsk")
    for off in (0, 37, 200, 513):
        buf = np.concatenate([np.zeros(off, np.complex64), iq, np.zeros(200, np.complex64)])
        buf = awgn(buf, 25)
        st = O.detect(buf)
        assert st is not None and abs(st - off) <= 24, "offset %d -> detect %s" % (off, st)
    print("ok detect (packet start found at offsets 0/37/200/513)")


def test_pad():
    """n_sym padding fills the last symbol BEFORE scrambling, so the receiver's
    descramble reproduces every bit bit-exactly (regression: padding after the
    scramble left the pad descrambled against a data-dependent state)."""
    bits = rng.integers(0, 2, 100).astype(np.uint8)   # not a whole symbol
    iq, info = O.modulate(bits, "qam16", n_sym=3)
    assert info["bits_per_packet"] == 3 * O.N_DATA * 4
    r = O.demodulate(iq, "qam16", n_sym=3)
    assert r["ok"]
    assert len(r["bits"]) == info["bits_per_packet"]
    assert np.array_equal(r["bits"][:len(bits)], bits)
    pad = O.scrambler_seq(info["bits_per_packet"] - len(bits), 0x5A)
    assert np.array_equal(r["bits"][len(bits):], pad)
    print("ok pad (last-symbol fill recovered bit-exact)")


def test_chunks():
    """The streaming ofdm_demod block recovers the bits regardless of how the
    IQ is chunked (chunk-size independence), over several looped packets."""
    nbits = O.SCHEMES["qpsk"] * O.N_DATA * 30
    bits = rng.integers(0, 2, nbits).astype(np.uint8)
    iq, info = O.modulate(bits, "qpsk")
    one = np.concatenate([iq, np.zeros(160, np.complex64)])
    stream = awgn(np.tile(one, 3), 30)
    for chunk in (97, 333, 1000, 4096):
        demod = O.OfdmDemod("d", {"scheme": "qpsk", "n_sym": info["n_sym"], "fps": 1000})
        got = []
        for i in range(0, len(stream), chunk):
            out = demod.work(stream[i:i + chunk], 20e6)
            if out is not None:
                got.append(out[0])
        assert demod.packets >= 2, "chunk %d: only %d packets" % (chunk, demod.packets)
        first = got[0][:nbits]
        assert ber(first, bits) <= 1e-3, "chunk %d: recovered BER too high" % chunk
    print("ok chunks (chunk-size independent, >=2 packets each)")


if __name__ == "__main__":
    test_ber()
    test_cfo()
    test_structure()
    test_pilots()
    test_detect()
    test_pad()
    test_chunks()
