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


def test_uart_over_fsk_idle():
    # the uart-over-fsk demo duty cycle: a 24 ms frame every 3 s of idle mark,
    # demodulated in the bridge's 20 ms chunks. The slicer threshold must
    # survive the long idle runs (they used to drag it onto the mark level,
    # turning idle into 0s and the decoded text into garbage).
    msg = b"hello from mAIlab! "
    frame = M.uart_encode(msg, 8, "none", 1)
    baud, sps, snr = 9600, 8, 16
    chunk_bits = baud // 50  # 20 ms ticks, like the flowgraph bridge
    mod = M.CpfskModulator("gfsk", sps)
    disc = M.Discriminator(sps, mod.h)
    gard = M.Gardner(sps)
    sl = M.LevelSlicer(2)
    dec = M.UartDecoder(1.0, 8, "none", 1)
    got = []
    for rep in range(3):
        bits = np.concatenate([frame, np.ones(chunk_bits * 150, dtype=np.uint8)])
        for i in range(0, len(bits), chunk_bits):
            rx = awgn(mod.process(bits[i:i + chunk_bits]), snr)
            for byte, error in dec.process(sl.process(gard.process(disc.process(rx)))):
                if not error:
                    got.append(byte)
    assert bytes(got[-len(msg):]) == msg, bytes(got[-40:])
    print("ok uart fsk idle")


def test_level_slicer_constant_first_chunk():
	# an all-identical first chunk (startup during an idle run) must not crash
	sl = modem.LevelSlicer(2)
	out = sl.process(np.full(64, 1.0))
	assert out.shape == (64,)
	assert np.all(out == out[0])
	assert sl.lo is not None and sl.hi is not None


def test_lowpass_gain():
    # unity passband gain whatever the cutoff (liquid's Kaiser design alone has ~1 / (2 cutoff))
    for cutoff in (0.02, 0.1, 0.3):
        y = dsp.Lowpass(cutoff, 127).process(np.exp(2j * np.pi * cutoff / 4 * np.arange(4000)))
        assert abs(np.mean(np.abs(y[-1000:])) - 1) < 0.01, cutoff
    print("ok lowpass")


def test_baud_est():
    rng = np.random.RandomState(42)
    for _ in range(6):
        bits = rng.randint(0, 2, 4000).astype(np.uint8)
        est = M.baud_estimate(np.repeat(bits * 2 - 1, 8).astype(np.float64), 9600 * 8)
        assert est and abs(est - 9600) / 9600 < 0.04, est
    m = M.CpfskModulator("gfsk", sps=8, h=0.5)
    bits = rng.randint(0, 2, 4000).astype(np.uint8)
    z = m.process(bits)
    est = M.baud_estimate(z, 9600 * 8)
    assert est and abs(est - 9600) / 9600 < 0.08, est
    d = M.Discriminator(8, 0.5)
    est = M.baud_estimate(d.process(z), 9600 * 8)
    assert est and abs(est - 9600) / 9600 < 0.08, est
    assert M.baud_estimate(np.ones(4096), 9600 * 8) is None
    print("ok baud")


def _esb_frame_bits(addr, payload, pid=2, noack=1):
    pcf = len(payload) | (pid << 6) | (noack << 8)
    crc = M.esb_crc8(addr + bytes([pcf & 0xFF, (pcf >> 8) & 1]) + payload)
    return np.concatenate([M.unpack_bits_lsb(addr),
                           np.array([(pcf >> i) & 1 for i in range(9)], dtype=np.uint8),
                           M.unpack_bits_lsb(payload),
                           np.array([(crc >> i) & 1 for i in range(8)], dtype=np.uint8)])


def test_esb_decode():
    addr = bytes([0x12, 0x34, 0x56, 0x78, 0x9A])
    payload = bytes(range(1, 12))
    bits = _esb_frame_bits(addr, payload)
    got = M.esb_decode_bits(bits, addr)
    assert len(got) == 1, got
    pkt = got[0]
    assert pkt["crc_ok"] and pkt["length"] == 11 and pkt["pid"] == 2 and pkt["noack"] == 1, pkt
    assert pkt["payload"] == payload.hex(), pkt
    # every single-bit error must be caught (or destroy the sync word outright)
    for i in range(len(bits)):
        flipped = bits.copy()
        flipped[i] ^= 1
        hits = M.esb_decode_bits(flipped, addr)
        assert not hits or not hits[0]["crc_ok"], i
    # a different address must not sync
    assert M.esb_decode_bits(bits, bytes([0xE7] * 5)) == []
    print("ok esb")


def test_ble_decode():
    hdr = bytes([0x42, 0x0C]) + bytes.fromhex("998877665544") + b"hello!"
    try:
        from scapy.layers.bluetooth4LE import BTLE
        crc = BTLE.compute_crc(hdr, 0x555555)
        assert M.crc24_ble(hdr) == int.from_bytes(crc, "little")
    except ImportError:
        crc = M.crc24_ble(hdr).to_bytes(3, "little")
    pdu = np.concatenate([M.unpack_bits_lsb(hdr), M.unpack_bits_lsb(crc)])
    air = np.concatenate([M.unpack_bits_lsb(bytes([0xAA, 0xAA])),
                          M.unpack_bits_lsb((0x8E89BED6).to_bytes(4, "little")),
                          M.ble_white_bits(pdu, 37)])
    got = M.ble_decode_bits(air, 37)
    assert len(got) == 1, got
    pkt = got[0]
    assert pkt["crc_ok"] and pkt["pdu_type"] == 2 and pkt["length"] == 12, pkt
    # ADV_IND payload is AdvA + advertising data
    assert pkt["payload"] == (bytes.fromhex("998877665544") + b"hello!").hex(), pkt
    assert pkt["addr"] == "998877665544", pkt
    # crc failure is detected, whitening is self-inverse and channel-specific
    broken = air.copy()
    broken[-1] ^= 1
    assert not M.ble_decode_bits(broken, 37)[0]["crc_ok"]
    x = np.random.RandomState(1).randint(0, 2, 64).astype(np.uint8)
    assert np.array_equal(M.ble_white_bits(M.ble_white_bits(x, 19), 19), x)
    assert not np.array_equal(M.ble_white_bits(x, 19), M.ble_white_bits(x, 20))
    print("ok ble")


if __name__ == "__main__":
    test_lowpass_gain()
    test_linear()
    test_gardner_path()
    test_cpfsk()
    test_ook()
    test_sync()
    test_uart()
    test_uart_over_fsk_idle()
    test_baud_est()
    test_esb_decode()
    test_ble_decode()
