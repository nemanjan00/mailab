# 8b/10b line code (Fibre Channel / Gigabit Ethernet / PCIe / SATA / USB 3 style),
# after ngscopeclient/libscopehal's CDR + 8b10b decode path, as a pure-python
# codec. Bit strings are written in transmission order (first bit on the wire
# leftmost), "abcdei fghj" naming; stored as ints with bit0 = first received.
#
# Encoding is sequential: the 6b part is picked so the running disparity stays
# +/-1 after it, then the 4b part likewise. The running disparity therefore
# never exceeds +/-1, which is what makes the K28.5 comma (a run of five equal
# bits, impossible in data codes) uniquely findable for byte alignment.
# D.x.3 takes an alternate zero-disparity 4b code for x in {17,18,20,24} so the
# comma sequence cannot appear across symbol boundaries.

_6B = ["100111", "011101", "101101", "110001", "110101", "101001", "011001", "111000",
       "111001", "100101", "010101", "110100", "001101", "101100", "011100", "010111",
       "011011", "100011", "010011", "110010", "001011", "101010", "011010", "111010",
       "110011", "100110", "010110", "110110", "001110", "101110", "011110", "101011"]

# x whose 6b code has zero disparity and is used unchanged for both polarities
# (D7 is zero-disparity too but the standard still pairs it with its
# complement 000111 for RD=+1: "111000" starting a symbol would otherwise run
# to six equal bits with the preceding 4b part's high end)
_6B_ZERO = {3, 5, 6, 9, 10, 11, 12, 13, 14, 17, 18, 19, 20, 21, 22, 25, 26, 28}

# D.x.3 takes the alternate 4b code for these x (comma avoidance)
_4B_3_ALT = {17, 18, 20, 24}

# K28.x: 6b part is 001111 (rd-) / 110000 (rd+), always +/-2 so the mid-symbol
# disparity is always -rd; K23.7/K27.7/K29.7/K30.7 use the plain D.x 6b part
# (also +/-2). _K_4B lists the mid-disparity-+1 4b parts (transmission order);
# the mid-disparity--1 side is the complement.
_K_4B = {0: "0100", 1: "1001", 2: "0101", 3: "0011", 4: "0010", 5: "1010", 6: "0110", 7: "1000"}
_K_SIX_ALT = {23, 27, 29, 30}   # K23.7 etc: 6b = D.x rule, 4b = "1000"/"0111"


def _bits(s):
    """transmission-order string -> int with first bit = bit0"""
    v = 0
    for k, ch in enumerate(s):
        v |= int(ch) << k
    return v


def _comp_bits(s):
    return "".join("1" if c == "0" else "0" for c in s)


def _six(x, rd):
    if x == 7:
        return _bits("111000" if rd < 0 else "000111")
    v = _bits(_6B[x])
    if x not in _6B_ZERO and rd > 0:
        v ^= 0x3F
    return v


def _four(y, x, rd):
    """4b code for symbol x.y given the running disparity entering the 4b part"""
    if y == 3:
        if x in _4B_3_ALT:
            return _bits("0011" if rd < 0 else "1100")
        return _bits("1100" if rd < 0 else "0011")
    if y == 7:
        return _bits("1110" if rd < 0 else "0001")
    if y == 0:
        return _bits("1011" if rd < 0 else "0100")
    if y == 4:
        return _bits("1101" if rd < 0 else "0010")
    return _bits({1: "1001", 2: "0101", 5: "1010", 6: "0110"}[y])


def _six_disp(v):
    """disparity of a 6b code: +/-2 or 0"""
    return bin(v).count("1") - 3


def encode_sym(byte, k, rd):
    """(byte, k, rd) -> (code10 as bit0-first-received int, new rd).
    byte = HGF EDCBA (bit0 = A). K codes: byte = HGF EDCBA of the K name
    (K28.5 -> (5<<5)|28); only the 12 standard K codes exist."""
    x, y = byte & 0x1F, byte >> 5
    if k:
        if x == 28:
            six = _bits("001111" if rd < 0 else "110000")
            mid = -rd     # six is always +/-2
            four = _bits(_K_4B[y] if mid > 0 else _comp_bits(_K_4B[y]))
        elif x in _K_SIX_ALT and y == 7:
            six = _six(x, rd)
            mid = -rd if _six_disp(six) else rd
            four = _bits("0111" if mid < 0 else "1000")
        else:
            raise ValueError("not a defined K code: K%d.%d" % (x, y))
    else:
        six = _six(x, rd)
        mid = -rd if _six_disp(six) else rd
        four = _four(y, x, mid)
    code = six | four << 6
    return code, (-rd if bin(code).count("1") != 5 else rd)


# Full decode tables per running disparity entering the symbol.
def _build_tables():
    tables = {}
    for rd in (-1, 1):
        t = {}
        for byte in range(256):
            code, _ = encode_sym(byte, False, rd)
            t[code] = (byte, False)
        for byte in _k_bytes():
            code, _ = encode_sym(byte, True, rd)
            t[code] = (byte, True)
        tables[rd] = t
    return tables


def _k_bytes():
    return [(y << 5) | 28 for y in range(8)] + [(7 << 5) | x for x in _K_SIX_ALT]


TABLES = _build_tables()

# comma K28.5 in received-bit order (a first)
COMMA_BITS = [int(c) for c in "0011111010"]
COMMA = _bits("0011111010")


def decode(code, rd):
    """(code10, rd) -> (byte, k, new_rd, err); err None | 'disparity' | 'invalid'.
    A disparity error means the code belongs to the other running disparity (it
    is still decoded); on an invalid code RD is left unchanged."""
    hit = TABLES[rd].get(code)
    if hit is not None:
        byte, k = hit
        _, new_rd = encode_sym(byte, k, rd)
        return byte, k, new_rd, None
    if code in TABLES[-rd]:
        byte, k = TABLES[-rd][code]
        return byte, k, rd, "disparity"
    return None, False, rd, "invalid"


def encode(data, rd=-1, k=None):
    """bytes (+ optional parallel k flags) -> received-order bit list, starting
    at running disparity rd (default -1, the usual post-reset value)."""
    bits = []
    ks = k if k is not None else [False] * len(data)
    for byte, kk in zip(data, ks):
        code, rd = encode_sym(byte, kk, rd)
        bits += [(code >> i) & 1 for i in range(10)]
    return bits
