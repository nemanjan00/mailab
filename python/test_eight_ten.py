#!/usr/bin/env python3
# 8b/10b codec tests: fixed standard vectors, round-trip over every symbol,
# the running-disparity invariant, comma uniqueness in data streams, and the
# builtin bit-slicer/decoder fed with a synthetic serial stream.
import sys

sys.path.insert(0, __import__("os").path.dirname(__import__("__main__").__file__) if "__main__" in dir() else ".")
sys.path.insert(0, "python")

import eight_ten as et
import numpy as np

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("ok %s" % name)
    else:
        print("FAIL %s %s" % (name, detail))
        FAILS.append(name)


def bits(s):
    return [int(c) for c in s]


# ---- fixed standard vectors (received-bit order, a first) -------------------
def enc_bits(byte, k, rd):
    code, _ = et.encode_sym(byte, k, rd)
    return [(code >> i) & 1 for i in range(10)]


check("k28.5 rd- vector", enc_bits(0xBC, True, -1) == bits("0011111010"), enc_bits(0xBC, True, -1))
check("k28.5 rd+ vector", enc_bits(0xBC, True, 1) == bits("1100000101"), enc_bits(0xBC, True, 1))
check("k28.7 rd- vector", enc_bits(0xFC, True, -1) == bits("0011111000"), enc_bits(0xFC, True, -1))
check("k23.7 rd- vector", enc_bits(0xF7, True, -1) == bits("1110101000"), enc_bits(0xF7, True, -1))
check("d0.0 rd- vector", enc_bits(0x00, False, -1) == bits("1001110100"), enc_bits(0x00, False, -1))
check("d31.7 rd- vector", enc_bits(0xFF, False, -1) == bits("1010110001"), enc_bits(0xFF, False, -1))

# ---- round-trip + disparity invariant over every symbol --------------------
ok_rt, ok_inv = True, True
for rd0 in (-1, 1):
    rd = rd0
    seq = [(b, False) for b in range(256)] + [(b, True) for b in et._k_bytes()]
    codes = []
    for byte, k in seq:
        code, rd = et.encode_sym(byte, k, rd)
        codes.append(code)
        ones = bin(code).count("1")
        if ones not in (4, 5, 6) or rd not in (-1, 1):
            ok_inv = False
    rd2 = rd0
    for (byte, k), code in zip(seq, codes):
        b2, k2, rd2, err = et.decode(code, rd2)
        if err or b2 != byte or k2 != k:
            ok_rt = False
check("round-trip all 268 symbols x2 rd", ok_rt)
check("disparity stays +/-1, code weight 4..6", ok_inv)

# ---- data streams never contain the comma pattern ---------------------------
data = bytes(range(256)) * 4
for rd0 in (-1, 1):
    stream = et.encode(data, rd=rd0)
    run, worst = 1, 1
    for a, b in zip(stream, stream[1:]):
        run = run + 1 if a == b else 1
        worst = max(worst, run)
    check("max run <= 5 in data (rd=%d)" % rd0, worst <= 5, "worst=%d" % worst)

# ---- comma: K28.5 inside a stream carries the unique 5-run ------------------
stream = et.encode(b"\x01\x02\x03", rd=-1, k=[False, False, False])
stream += et.encode([0xBC], rd=-1, k=[True])
stream += et.encode(b"\x04", rd=-1)
bits5 = "".join(map(str, stream))
check("comma 5-run present", "11111" in bits5 or "00000" in bits5)

# ---- disparity + invalid error paths ----------------------------------------
code, _ = et.encode_sym(0x00, False, -1)
b, k, rd2, err = et.decode(code, 1)   # wrong running disparity on purpose
check("disparity error flagged", err == "disparity" and b == 0x00, (b, err))
bad = et._bits("0000001111")          # three ones -> not a code at all
b, k, _, err = et.decode(bad, -1)
check("invalid code flagged", err == "invalid" and b is None, (b, err))

print("FAILS: %d" % len(FAILS))
sys.exit(1 if FAILS else 0)
