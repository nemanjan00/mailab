"""Modem regression checks: every scheme through AWGN must come back with a
low BER. Run directly (python3 python/test_modem.py) or via jest."""

import numpy as np

import liquid_dsp as dsp
import modem as M

rng = np.random.default_rng(1)


def awgn(x, snr):
    p = np.mean(np.abs(x) ** 2)
    s = np.sqrt(p / 10 ** (snr / 10) / 2)
    return (x + s * (rng.standard_normal(len(x)) + 1j * rng.standard_normal(len(x)))).astype(np.complex64)


def chunks(x, f, n=4096):
    return np.concatenate([f(x[i:i + n]) for i in range(0, len(x), n)])


def ber(bits):
    c = M.BerChecker(9)
    c.feed(bits)
    return c.ber


def tx(mod, n=30000):
    p = M.Prbs(9)
    return np.concatenate([mod.process(p.bits(6000)) for _ in range(n // 6000)])


LINEAR = [("bpsk", 15, 0.02), ("qpsk", 20, 0.02), ("psk8", 25, 0.02), ("apsk16", 26, 0.005),
          # every QAM size liquid has (+ square-cross variants); SNR grows ~3 dB per bit
          ("qam4", 20, 0.02), ("qam8", 24, 0.01), ("qam16", 26, 0.005),
          ("qam64", 32, 0.002), ("qam128", 36, 0.0015), ("qam256", 40, 0.001),
          ("sqam32", 30, 0.003), ("sqam128", 36, 0.0015)]
# rectangular qam32 mis-locks liquid's symbol sync; matched filter + Gardner handles it
GARDNER = [("qam32", 30, 0.003)]
CPFSK = [("2fsk", 20, 1e-3), ("msk", 20, 1e-3), ("gfsk", 20, 1e-3), ("gmsk", 20, 1e-3), ("4fsk", 22, 2e-2)]


def check(name, value, limit):
    assert value is not None and value <= limit, "%s: BER %s > %s" % (name, value, limit)
    print("ok %-7s BER %.2e" % (name, value))


def test_linear():
    for scheme, snr, bw in LINEAR:
        rx = awgn(tx(M.LinearModulator(scheme, 8)), snr)
        sync = dsp.SymbolSync(8, bandwidth=bw)
        m = dsp.Modem(scheme)
        bits, _ = M.linear_demod_bits(m, chunks(rx, sync.process)[400:], scheme)
        check(scheme, ber(bits), 1e-3)


def test_gardner_path():
    for scheme, snr, bw in GARDNER:
        rx = awgn(tx(M.LinearModulator(scheme, 8)), snr)
        mf, g = dsp.MatchedFilter(8), M.Gardner(8, bw)
        sym = chunks(rx, lambda c, mf=mf, g=g: g.process(mf.process(c)))[300:]
        sym = sym / np.sqrt(np.mean(np.abs(sym) ** 2))
        bits, _ = M.linear_demod_bits(dsp.Modem(scheme), sym, scheme)
        check(scheme, ber(bits), 1e-3)


def test_cpfsk():
    for scheme, snr, limit in CPFSK:
        mod = M.CpfskModulator(scheme, 8)
        rx = awgn(tx(mod), snr)
        d, g = M.Discriminator(8, mod.h), M.Gardner(8)
        sym = chunks(rx, lambda c, d=d, g=g: g.process(d.process(c)))[200:]
        check(scheme, ber(M.LevelSlicer(4 if scheme == "4fsk" else 2).process(sym)), limit)


def test_ook():
    rx = awgn(tx(M.LinearModulator("ook", 8)), 20)
    g = M.Gardner(8, 0.005, dc_block=True)
    check("ook", ber(M.LevelSlicer(2).process(chunks(np.abs(rx), g.process)[200:])), 1e-3)


def test_sync():
    bits = np.concatenate([rng.integers(0, 2, 100, dtype=np.uint8), M.unpack_bits(b"\x2d\xd4"), M.unpack_bits(b"hi!")])
    assert M.find_sync(bits, M.unpack_bits(b"\x2d\xd4")) == [100]
    print("ok sync")


def test_uart():
    msg = b"hello mailab\r\nboot ok v1.2\r\n"
    for parity, stop, sps in [("none", 1, 8.0), ("even", 1, 8.0), ("odd", 2, 8.0), ("none", 1, 10.4)]:
        bits = M.uart_encode(msg, parity=parity, stop=stop)
        n = int(len(bits) * sps)
        t = np.arange(n) / sps
        line = bits[np.minimum(t.astype(int), len(bits) - 1)].astype(np.float32) * 3.3 + rng.normal(0, 0.15, n)
        d = M.UartDecoder(sps=sps, parity=parity, stop=stop)
        got = []
        for i in range(0, len(line), 97):
            got += d.process(line[i:i + 97])
        assert bytes(b for b, _ in got) == msg, (parity, stop, sps)
        assert not [e for _, e in got if e]
    bits = M.uart_encode(b"A", parity="even")
    bits[9] ^= 1
    assert M.UartDecoder(1, parity="even").process(np.concatenate([[1, 1], bits, [1, 1, 1]]))[0] == (65, "parity")
    print("ok uart")


def test_lowpass_gain():
    # unity passband gain whatever the cutoff (liquid's Kaiser design alone has ~1 / (2 cutoff))
    for cutoff in (0.02, 0.1, 0.3):
        y = dsp.Lowpass(cutoff, 127).process(np.exp(2j * np.pi * cutoff / 4 * np.arange(4000)))
        assert abs(np.mean(np.abs(y[-1000:])) - 1) < 0.01, cutoff
    print("ok lowpass")


if __name__ == "__main__":
    test_lowpass_gain()
    test_linear()
    test_gardner_path()
    test_cpfsk()
    test_ook()
    test_sync()
    test_uart()
