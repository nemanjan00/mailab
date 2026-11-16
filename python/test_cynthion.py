"""USB analyzer decoding checks on synthetic packet streams (stdlib only).
Run directly (python3 python/test_cynthion.py) or via jest."""

import random
import struct
import unittest

import usb_analyzer as U
import cynthion_bridge as B


def decode_all(packets):
    d = U.Decoder()
    for i, p in enumerate(packets):
        d.packet(i * 1000, p)
    d.flush()
    return d


class Crc(unittest.TestCase):
    def test_catalogue_check_values(self):
        # CRC-16/USB and CRC-5/USB check values over "123456789"
        self.assertEqual(U.crc16(b"123456789"), 0xB4C8)
        self.assertEqual(U.crc5(int.from_bytes(b"123456789", "little"), 72), 0x19)

    def test_known_tokens(self):
        # SETUP addr 0 ep 0 is 2D 00 10 on the wire
        self.assertEqual(U.token("SETUP", 0, 0), bytes([0x2D, 0x00, 0x10]))
        self.assertEqual(U.data_packet("DATA1", b""), bytes([0x4B, 0x00, 0x00]))


class Packets(unittest.TestCase):
    def test_pid_names(self):
        for name in U.PID_CODES:
            if name in U.TOKENS:
                raw = U.token(name, 3, 2)
            elif name in U.DATA:
                raw = U.data_packet(name, b"\x01\x02")
            elif name == "SOF":
                raw = U.sof(5)
            elif name in ("SPLIT", "EXT"):
                continue
            else:
                raw = U.handshake(name)
            self.assertEqual(U.decode_packet(raw)["name"], name)

    def test_pid_check(self):
        pkt = U.decode_packet(bytes([0x2C, 0, 0]))
        self.assertTrue(pkt["errors"])
        self.assertEqual(pkt["name"], "?")

    def test_token_fields_and_crc5(self):
        pkt = U.decode_packet(U.token("IN", 0x55, 0x9))
        self.assertEqual((pkt["addr"], pkt["ep"], pkt["errors"]), (0x55, 0x9, []))
        bad = bytearray(U.token("IN", 0x55, 0x9))
        bad[1] ^= 0x04
        self.assertIn("CRC5 mismatch", U.decode_packet(bytes(bad))["errors"])

    def test_sof(self):
        pkt = U.decode_packet(U.sof(0x7FF))
        self.assertEqual((pkt["frame"], pkt["errors"]), (0x7FF, []))

    def test_data_crc16(self):
        good = U.data_packet("DATA0", bytes(range(64)))
        pkt = U.decode_packet(good)
        self.assertEqual((pkt["data"], pkt["errors"]), (bytes(range(64)), []))
        bad = bytearray(good)
        bad[10] ^= 1
        self.assertIn("CRC16 mismatch", U.decode_packet(bytes(bad))["errors"])

    def test_split(self):
        field = 7 | (1 << 7) | (3 << 8) | (3 << 17)
        field |= U.crc5(field, 19) << 19
        pkt = U.decode_packet(bytes([U.pid_byte("SPLIT")]) + field.to_bytes(3, "little"))
        self.assertEqual((pkt["hub"], pkt["complete"], pkt["port"], pkt["endpointType"], pkt["errors"]),
                         (7, True, 3, "interrupt", []))

    def test_lengths(self):
        self.assertTrue(U.decode_packet(bytes([0xD2, 0]))["errors"])
        self.assertTrue(U.decode_packet(bytes([0xE1, 0]))["errors"])
        self.assertTrue(U.decode_packet(b"")["errors"])


class Stream(unittest.TestCase):
    RECORDS = [(0, "capture_start_full"), (5, U.token("SETUP", 0, 0)), (7, U.data_packet("DATA0", b"\x80\x06\x00\x01\x00\x00\x40\x00")),
               (3, U.handshake("ACK")), (0xFFFF, "none"), (2, "bus_reset"), (11, U.data_packet("DATA1", b"\x01\x02\x03"))]

    def check(self, chunks):
        parser = U.StreamParser()
        out = []
        for c in chunks:
            out += parser.feed(c)
        kinds = [(r["kind"], r.get("name") or r["data"]) for r in out]
        expected = [("event" if isinstance(x, str) else "packet", x) for _d, x in self.RECORDS]
        self.assertEqual(kinds, expected)
        cycles = sum(d for d, _x in self.RECORDS)
        self.assertEqual(out[-1]["t"], cycles * 1_000_000_000 // U.CLOCK_HZ)

    def test_whole(self):
        self.check([U.encode_stream(self.RECORDS)])

    def test_odd_length_padding_and_split_chunks(self):
        raw = U.encode_stream(self.RECORDS)
        # handshake (1 byte) and DATA1 (6 bytes) / token (3 bytes) are odd: padded
        self.assertEqual(len(raw) % 2, 0)
        self.check([raw[i:i + 1] for i in range(len(raw))])
        rng = random.Random(3)
        pos, chunks = 0, []
        while pos < len(raw):
            n = rng.randrange(1, 9)
            chunks.append(raw[pos:pos + n])
            pos += n
        self.check(chunks)


class Transfers(unittest.TestCase):
    def test_enumeration(self):
        d = decode_all(U.synthetic_enumeration(addr=7, vid=0x1d50, pid=0x615b, strings=("GSG", "Thing", "42")))
        requests = [x["request"] for x in d.transfers if x["type"] == "control"]
        self.assertEqual(requests[:3], ["GET_DESCRIPTOR DEVICE #0", "SET_ADDRESS 7", "GET_DESCRIPTOR DEVICE #0"])
        self.assertIn("SET_CONFIGURATION 1", requests)
        self.assertEqual(list(d.devices), [7])
        dev = d.devices[7]
        self.assertEqual(dev["device"]["id"], "1d50:615b")
        self.assertEqual(dev["strings"], {1: "GSG", 2: "Thing", 3: "42"})
        self.assertEqual(dev["languages"], [0x0409])
        self.assertEqual(dev["configuration"], 1)
        cfg = dev["configurations"][0]
        self.assertNotIn("partial", cfg)
        self.assertEqual(cfg["interfaces"][0]["class"], "HID")
        self.assertEqual(cfg["interfaces"][0]["endpoints"][0]["type"], "interrupt")
        self.assertEqual(dev["summary"], "1d50:615b GSG Thing serial 42 USB 2.00 (HID)")
        reports = [x for x in d.transfers if x["ep"] == 1]
        self.assertEqual(len(reports), 3)
        self.assertEqual(reports[0]["type"], "interrupt")
        self.assertEqual(d.stats["naks"], {"0.0": 1, "7.1": 3})
        self.assertEqual(d.stats["errors"], 0)

    def test_multi_packet_data_stage(self):
        payload = bytes(range(200))
        setup = U.setup_bytes(0x80, 6, 0x0200, 0, 255)
        config = bytes([9, 2, 200, 0, 1, 1, 0, 0x80, 50]) + payload[9:]
        d = decode_all(U.control_read(3, setup, config, mps=64))
        self.assertEqual(d.transfers[0]["length"], 200)

    def test_retransmission_dropped(self):
        pkts = [U.token("SETUP", 2, 0), U.data_packet("DATA0", U.setup_bytes(0x80, 6, 0x0100, 0, 18)), U.handshake("ACK"),
                # first IN: host's ACK lost (none seen) -> device resends DATA1
                U.token("IN", 2, 0), U.data_packet("DATA1", bytes(18)),
                U.token("IN", 2, 0), U.data_packet("DATA1", bytes(18)), U.handshake("ACK"),
                U.token("OUT", 2, 0), U.data_packet("DATA1", b""), U.handshake("ACK")]
        d = decode_all(pkts)
        self.assertEqual(d.transfers[0]["length"], 18)

    def test_stall(self):
        pkts = [U.token("SETUP", 2, 0), U.data_packet("DATA0", U.setup_bytes(0x80, 6, 0x0600, 0, 10)), U.handshake("ACK"),
                U.token("IN", 2, 0), U.handshake("STALL")]
        d = decode_all(pkts)
        self.assertEqual((d.transfers[0]["request"], d.transfers[0]["status"]), ("GET_DESCRIPTOR DEVICE_QUALIFIER #0", "STALL"))

    def test_corrupt_packets_counted_not_decoded(self):
        bad = bytearray(U.data_packet("DATA0", U.setup_bytes(0x80, 6, 0x0100, 0, 18)))
        bad[3] ^= 0xFF
        d = decode_all([U.token("SETUP", 2, 0), bytes(bad), U.handshake("ACK")])
        self.assertEqual(d.stats["errors"], 1)
        self.assertEqual(d.transfers, [])

    def test_vendor_request_and_bulk(self):
        pkts = U.control_nodata(4, U.setup_bytes(0x41, 0x01, 0x0003, 0, 0))
        pkts += [U.token("OUT", 4, 2), U.data_packet("DATA0", bytes(64)), U.handshake("ACK"),
                 U.token("OUT", 4, 2), U.data_packet("DATA1", bytes(10)), U.handshake("ACK")]
        d = decode_all(pkts)
        self.assertTrue(d.transfers[0]["request"].startswith("vendor request 0x01"))
        self.assertEqual((d.transfers[1]["type"], d.transfers[1]["length"]), ("bulk/interrupt", 74))


class Pcap(unittest.TestCase):
    def test_round_trip(self):
        packets = [(i * 1500, p) for i, p in enumerate(U.synthetic_enumeration())]
        raw = U.write_pcap(packets, start_ns=1_700_000_000_123_456_789)
        self.assertEqual(struct.unpack_from("<I", raw, 20)[0], 288)
        self.assertEqual(struct.unpack_from("<I", raw)[0], U.PCAP_MAGIC_NS)
        linktype, start, back = U.read_pcap(raw)
        self.assertEqual((linktype, start), (288, 1_700_000_000_123_456_789))
        self.assertEqual(back, packets)

    def test_big_endian_microseconds(self):
        data = U.token("IN", 1, 1)
        raw = struct.pack(">IHHiIII", U.PCAP_MAGIC_US, 2, 4, 0, 0, 65535, 288)
        raw += struct.pack(">IIII", 10, 5, 3, 3) + data + struct.pack(">IIII", 10, 7, 3, 3) + data
        linktype, start, back = U.read_pcap(raw)
        self.assertEqual((linktype, start, back), (288, 10_000_005_000, [(0, data), (2000, data)]))

    def test_rejects(self):
        with self.assertRaises(ValueError):
            U.read_pcap(b"\x0a\x0d\x0d\x0a" + bytes(40))
        with self.assertRaises(ValueError):
            U.read_pcap(bytes(40))


class Fuzz(unittest.TestCase):
    def test_cases_deterministic(self):
        self.assertEqual(B.fuzz_cases(150, 9), B.fuzz_cases(150, 9))
        self.assertEqual(len(B.fuzz_cases(150, 9)), 150)
        self.assertEqual(B.fuzz_cases(3)[0]["label"], "device.bLength=0x00")

    def test_mutate(self):
        device, config, _s = U.keyboard_descriptors()
        case = {"target": "config", "offset": 4, "value": 0xFF}
        self.assertEqual(B.mutate(config, case, "config")[4], 0xFF)
        self.assertEqual(B.mutate(device, case, "device"), device)
        # every fuzzed offset exists in the keyboard descriptors
        for t, o, _l in B.FUZZ_FIELDS:
            self.assertLess(o, len(device if t == "device" else config))


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    if result.wasSuccessful():
        print("ok cynthion")
    raise SystemExit(0 if result.wasSuccessful() else 1)
