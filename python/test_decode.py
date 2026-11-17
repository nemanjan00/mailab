"""Protocol decoder checks: synthetic UART / SPI / I2C / Manchester waveforms
through the builtin decoders and (when the libsigrokdecode decoder scripts are
installed) the real sigrok decoders. Run directly or via jest."""

import numpy as np

import protocol_decode as P

rng = np.random.default_rng(7)
MSG = b"hello mailab\r\n\x00\xff\x55\xaa"


def uart_wave(data, sps=8, parity="none", stop=1, idle=20):
    bits = [1] * idle
    for c in data:
        d = [(c >> i) & 1 for i in range(8)]
        bits += [0] + d
        if parity != "none":
            bits.append(sum(d) % 2 if parity == "even" else 1 - sum(d) % 2)
        bits += [1] * stop + [1] * int(rng.integers(0, 3))
    bits += [1] * idle
    n = int(len(bits) * sps)
    return np.array(bits, np.uint8)[np.minimum((np.arange(n) / sps).astype(int), len(bits) - 1)]


def spi_wave(mosi, miso, mode=0, half=4):
    """words: bit0 clk, bit1 mosi, bit2 miso, bit3 cs (active low)"""
    cpol, cpha = mode >> 1, mode & 1
    out = [(cpol | 8)] * 10
    clk_idle = cpol
    for a, b in zip(mosi, miso):
        for i in range(7, -1, -1):
            data = (((a >> i) & 1) << 1) | (((b >> i) & 1) << 2)
            lead, trail = 1 - clk_idle, clk_idle
            if cpha == 0:
                out += [clk_idle | data] * half + [lead | data] * half
            else:
                out += [lead | data] * half + [trail | data] * half
        out += [clk_idle | data] * half
    out += [clk_idle] * half + [clk_idle | 8] * 10
    return np.array(out, np.uint32)


def i2c_wave(addr, data, read=False, q=4):
    """words: bit0 scl, bit1 sda"""
    w = [3] * 10
    sda = 1

    def put(scl, s, n=q):
        w.extend([scl | (s << 1)] * n)

    put(1, 0)          # start: sda falls while scl high
    put(0, 0)
    for byte in [(addr << 1) | int(read)] + list(data):
        for bit in [(byte >> i) & 1 for i in range(7, -1, -1)] + [0]:   # ack by the target
            put(0, bit)
            put(1, bit)
            put(0, bit)
            sda = bit
    put(0, 0)
    put(1, 0)
    put(1, 1)          # stop: sda rises while scl high
    put(1, 1, 10)
    return np.array(w, np.uint32), sda


def manchester_wave(data, sps=16, ieee=True, idle=40):
    half = sps // 2
    out = [0] * idle
    for c in data:
        for i in range(7, -1, -1):
            b = (c >> i) & 1
            first = (1 - b) if ieee else b       # ieee: 1 = low->high
            out += [first] * half + [1 - first] * half
    out += [0] * idle
    return np.array(out, np.uint8)


def run(x, rate, decoder, chunk=None, **kw):
    d = P.ProtocolDecoder(decoder, rate, **kw)
    out = []
    step = chunk or len(x)
    for i in range(0, len(x), step):
        out += d.feed(x[i:i + step])
    out += d.flush()
    assert not d.error, d.error
    return out


def values(anns, cls):
    return bytes(a["value"] for a in anns if a["class"] == cls and "value" in a)


def check(name, got, want):
    assert got == want, "%s: got %r want %r" % (name, got, want)
    print("ok %s" % name)


def test_uart(engine):
    for parity, stop, sps in [("none", 1, 8), ("even", 1, 8), ("odd", 2, 10)]:
        x = uart_wave(MSG, sps, parity, stop)
        anns = run(x, 9600 * sps, "uart", chunk=97, engine=engine,
                   options={"baudrate": 9600, "parity": parity, "stop_bits": stop})
        assert values(anns, "rx-data") == MSG, (parity, stop, values(anns, "rx-data"))
        assert not [a for a in anns if a["class"] in ("rx-parity-err", "rx-warning")], anns
    # a frame right at sample 0 and at the very end (no idle around it)
    anns = run(uart_wave(MSG, 8, idle=0), 76800, "uart", chunk=61, engine=engine, options={"baudrate": 9600})
    assert values(anns, "rx-data") == MSG, values(anns, "rx-data")
    # analog line: 0..3.3 V with noise, float input
    line = uart_wave(MSG, 8).astype(np.float32)
    x = line * 3.3 + rng.normal(0, 0.1, len(line))
    anns = run(x, 76800, "uart", chunk=500, engine=engine, options={"baudrate": 9600})
    check("uart " + engine, values(anns, "rx-data"), MSG)


def test_spi(engine):
    mosi, miso = bytes(range(0x30, 0x40)), bytes(rng.integers(0, 256, 16, dtype=np.uint8))
    for mode in range(4):
        x = spi_wave(mosi, miso, mode)
        anns = run(x, 1e6, "spi", chunk=101, engine=engine, options={"cpol": mode >> 1, "cpha": mode & 1},
                   channels={"clk": 0, "mosi": 1, "miso": 2, "cs": 3})
        assert values(anns, "mosi-data") == mosi, (mode, values(anns, "mosi-data"))
        assert values(anns, "miso-data") == miso, mode
    check("spi " + engine, values(anns, "mosi-data"), mosi)


def test_i2c(engine):
    x, _ = i2c_wave(0x50, b"\x01\x02\xa5")
    anns = run(x, 1e6, "i2c", chunk=33, engine=engine, channels={"scl": 0, "sda": 1})
    classes = [a["class"] for a in anns if a["class"] != "bit"]
    assert classes[0] == "start" and classes[-1] == "stop", classes
    assert [a["value"] for a in anns if a["class"] == "address-write" and "value" in a] == [0x50], anns
    assert sum(a["class"] == "ack" for a in anns) == 4, classes
    check("i2c " + engine, values(anns, "data-write"), b"\x01\x02\xa5")


def test_manchester():
    for ieee in (True, False):
        data = b"\x00" + bytes(rng.integers(0, 256, 32, dtype=np.uint8)) + b"\xff"
        x = manchester_wave(data, 16, ieee)
        anns = run(x, 16000, "manchester", chunk=77, engine="builtin",
                   options={"bitrate": 1000, "convention": "ieee" if ieee else "thomas"})
        assert values(anns, "data") == data, (ieee, values(anns, "data").hex(), data.hex())
    check("manchester builtin", values(anns, "data"), data)


def test_8b10b():
    import eight_ten
    sps = 16
    r8 = np.random.default_rng(11)
    payload = bytes(r8.integers(0, 256, 32, dtype=np.uint8))
    comma = [(5 << 5) | 28]          # K28.5
    bits = eight_ten.encode(comma + list(payload) + comma + [0x00], k=[True] + [False] * 32 + [True, False])
    x = np.array(bits, np.uint8)[np.minimum((np.arange(len(bits) * sps) / sps).astype(int), len(bits) - 1)]
    anns = run(x, 16e6, "8b10b", chunk=113, engine="builtin", options={"bitrate": 1e6})
    check("8b10b builtin", values(anns, "data"), payload)
    commas = [a for a in anns if a["class"] == "comma" and "value" in a]
    assert [a["value"] for a in commas] == [0xBC, 0xBC], commas
    kc = [a for a in anns if a["class"] == "k-code"]
    assert len(kc) == 2 and all(a["text"] == "K28.5" for a in kc), kc
    assert not [a for a in anns if a["class"] in ("disparity", "invalid")], anns
    # cut the stream into awkward chunk sizes around the comma (lock mid-chunk)
    for chunk in (7, 509):
        anns = run(x, 16e6, "8b10b", chunk=chunk, engine="builtin", options={"bitrate": 1e6})
        assert values(anns, "data") == payload, (chunk, values(anns, "data").hex())
    print("ok 8b10b chunking")


def test_external():
    # a 8-channel logic capture as raw bytes (e.g. a lab blob from sigrok -O binary)
    raw = (spi_wave(b"ext", b"\x00\x00\x00") & 0xFF).astype(np.uint8).tobytes()
    words = P.words_from_bytes(raw, "u8")
    anns = P.decode(words, 1e6, "spi", engine="builtin")
    assert P.data_bytes(anns, {"mosi-data"}) == b"ext"
    # a packed single-channel bit stream
    packed = np.packbits(uart_wave(b"OK", 4)).tobytes()
    anns = P.decode(P.words_from_bytes(packed, "bits"), 38400, "uart", engine="builtin", options={"baudrate": 9600})
    check("external", values(anns, "rx-data"), b"OK")


if __name__ == "__main__":
    test_uart("builtin")
    test_spi("builtin")
    test_i2c("builtin")
    test_manchester()
    test_8b10b()
    test_external()
    if P.sigrok_has("uart"):
        test_uart("sigrok")
        test_spi("sigrok")
        test_i2c("sigrok")
    else:
        print("skip sigrok (libsigrokdecode decoders not installed)")
