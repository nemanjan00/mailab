"""Checks for rfcat_bridge.py helpers and the device logic on the fake dongle
(no rflib, no radio). Run: python3 test_rfcat.py (jest runs it too)."""

import base64
import io
import json
import sys

import rfcat_bridge as rb


def raises(fn, match):
    try:
        fn()
    except ValueError as err:
        assert match in str(err), "%r does not mention %r" % (str(err), match)
        return
    raise AssertionError("expected ValueError mentioning %r" % match)


def test_bands():
    eu = rb.allowed_bands("eu")
    assert rb.check_tx(433.92e6, 10e3, eu)
    assert rb.check_tx(868.3e6, 39.2e3, eu)
    raises(lambda: rb.check_tx(434.78e6, 20e3, eu), "outside the allowed bands")   # edge spills over
    raises(lambda: rb.check_tx(915e6, 10e3, eu), "outside")                         # US band in EU
    raises(lambda: rb.check_tx(145.5e6, 1e3, eu), "outside")                        # licensed (2 m)
    us = rb.allowed_bands("US")
    assert rb.check_tx(915e6, 50e3, us)
    assert rb.check_tx(315e6, 10e3, us)
    raises(lambda: rb.check_tx(433.92e6, 1e3, rb.allowed_bands("none")), "region is 'none'")
    # custom bands narrow, never widen
    narrow = rb.allowed_bands("eu", "433.9M-433.95M")
    assert narrow == [(433.9e6, 433.95e6)]
    raises(lambda: rb.check_tx(434.2e6, 1e3, narrow), "outside")
    raises(lambda: rb.allowed_bands("eu", "430M-440M"), "outside the eu bands")
    raises(lambda: rb.allowed_bands("eu", "902M-928M"), "outside the eu bands")
    raises(lambda: rb.allowed_bands("mars"), "unknown region")
    raises(lambda: rb.parse_bands("434M"), "expected lo-hi")
    raises(lambda: rb.parse_bands("435M-434M"), "below")
    assert rb.parse_bands("433050000-434790000, 868e6-868.6e6") == [(433.05e6, 434.79e6), (868e6, 868.6e6)]
    assert rb.occupied_half_bw("ASK_OOK", 4800, 0) == 4800
    assert rb.occupied_half_bw("GFSK", 38400, 20000) == 39200
    print("ok bands")


def test_parsing():
    assert rb.parse_freq("433.92M") == 433.92e6
    assert rb.parse_freq("868300k") == 868.3e6
    assert rb.parse_freq(433920000) == 433920000
    raises(lambda: rb.parse_number(True, "x"), "must be a number")
    raises(lambda: rb.parse_number("nan", "x"), "finite")
    raises(lambda: rb.parse_number(1.5, "x", integer=True), "integer")
    raises(lambda: rb.check_tune(380e6), "outside the CC1111 ranges")
    assert rb.parse_modulation("ook") == "ASK_OOK"
    assert rb.parse_modulation("gfsk") == "GFSK"
    raises(lambda: rb.parse_modulation("4FSK"), "CC1101 only")
    raises(lambda: rb.parse_modulation("QPSK"), "modulation must be")
    assert rb.parse_sync_mode("30/32") == 3 and rb.parse_sync_mode(2) == 2
    raises(lambda: rb.parse_sync_mode(9), "<= 7")
    assert rb.parse_sync_word("0xd391") == 0xD391 and rb.parse_sync_word("d391") == 0xD391
    raises(lambda: rb.parse_sync_word(0x10000), "16 bits")
    assert rb.preamble_flag(4) == 0x20 and rb.preamble_bytes(0x20) == 4
    raises(lambda: rb.preamble_flag(5), "preamble must be")
    assert rb.parse_payload({"hex": "de:ad be-ef"}) == b"\xde\xad\xbe\xef"
    assert rb.parse_payload({"hex": "0x0102"}) == b"\x01\x02"
    assert rb.parse_payload({"text": "hi"}) == b"hi"
    assert rb.parse_payload({"data": base64.b64encode(b"\x00\x01").decode()}) == b"\x00\x01"
    raises(lambda: rb.parse_payload({"hex": "00", "text": "x"}), "exactly one")
    raises(lambda: rb.parse_payload({}), "exactly one")
    assert rb.tx_plan({"repeat": 3, "delayMs": 10}) == (3, 10)
    raises(lambda: rb.tx_plan({"repeat": 1001}), "repeat must be")
    raises(lambda: rb.tx_plan({"repeat": 1000, "delayMs": 100}), "over 60 s")
    print("ok parsing")


def test_format():
    row = rb.format_packet(7, b"Hi\x00\xff", 1000.5, -60.0, offset=12)
    assert row == {"n": 7, "t": 1000.5, "len": 4, "hex": "486900ff", "bytes": [72, 105, 0, 255],
                   "ascii": "Hi..", "rssi": -60.0, "offset": 12}
    assert rb.rssi_dbm(b"\xa0") == (0xA0 - 256) / 2.0 - rb.RSSI_OFFSET_DB
    assert rb.rssi_dbm(0x10) == 8 - rb.RSSI_OFFSET_DB
    assert rb.specan_dbm(bytes([rb.specan_byte(-85), rb.specan_byte(-40), 0x80])) == [-85.0, -40.0, -88.0]
    print("ok format")


def capture_output(fn):
    old = sys.stdout
    sys.stdout = io.StringIO()
    try:
        result = fn()
        lines = [json.loads(line) for line in sys.stdout.getvalue().splitlines() if line.strip()]
    finally:
        sys.stdout = old
    return result, lines


def test_device():
    dev = rb.RfcatDevice(rb.FakeRfCat(), (rb.FakeTimeout,), rb.allowed_bands("eu"), "eu")
    applied = dev.apply({"freq": "433.92M", "modulation": "ASK_OOK", "drate": 4800, "syncWord": "0xd391",
                         "pktLen": 16, "variable": "off", "crc": "off", "preamble": 4})
    assert applied["modulation"] == "ASK_OOK" and applied["variable"] is False
    eff = dev.effective()
    assert eff["modulation"] == "ASK_OOK" and eff["syncWord"] == "0xd391" and eff["pktLen"] == 16
    assert eff["crc"] is False and eff["preamble"] == 4 and eff["registers"]["sync1"] == "0xd3"
    raises(lambda: dev.apply({"crc": "maybe"}), "crc must be")
    # rx: the fake has two packets in the air
    _r, out = capture_output(lambda: [dev.recv(50), dev.recv(50)])
    assert [e["data"]["hex"] for e in out if e["type"] == "event"] == ["aa5501020304", b"hello rfcat".hex()]
    empty, _out = capture_output(lambda: dev.recv(20))
    assert empty is None
    # tx loops back; replay by packet number
    result, out = capture_output(lambda: dev.transmit(b"\x01\x02", {"repeat": 2}))
    assert result["repeat"] == 2 and dev.d.sent == [b"\x01\x02", b"\x01\x02"]
    assert dev.packet_bytes(1) == bytes.fromhex("aa5501020304")
    raises(lambda: dev.packet_bytes(99), "no captured packet 99")
    # out of band TX never reaches the radio
    dev.apply({"freq": 915e6})
    raises(lambda: dev.transmit(b"\x00", {}), "TX refused")
    assert len(dev.d.sent) == 2
    # specan frames
    dev.d._doSpecAn(433.92e6, 25e3, 100)
    dev.specan = {"base": 433.92e6 - 50 * 25e3, "inc": 25e3, "count": 100, "rate": 5, "frames": 0, "last": None, "published": 0}
    dbm, out = capture_output(dev.specan_frame)
    assert max(dbm) == -40.0 and dbm.index(-40.0) == 50
    assert any(e["type"] == "trace" and e["name"] == "spectrum" and e["yUnit"] == "dBm" for e in out)
    try:
        dev.no_specan()
        raise AssertionError("no_specan should refuse while specan runs")
    except RuntimeError:
        pass
    print("ok device")


if __name__ == "__main__":
    test_bands()
    test_parsing()
    test_format()
    test_device()
