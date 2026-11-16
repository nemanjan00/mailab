#!/usr/bin/env python3
"""Bytes -> IQ -> spectrum, in a handful of MCP calls.

Crafts an 802.11 beacon frame, stores it as a lab blob (parsed by a Kaitai
struct in the kaitai pane), modulates the bytes as QAM256 and loops them
back through the `channel` block to a spectrum and a recovered constellation.

This is a DSP demo: it does NOT transmit, and single-carrier QAM256 is not
real 802.11 (which is OFDM), so no access point would decode it. Over-the-air
transmit is a separate, approval-gated, band-limited path (see the RF safety
notes in the README); this stays entirely in a loopback channel.

    python3 demos/beacon-to-iq/beacon.py [http://127.0.0.1:3000] [token]

Needs a running mailab (`yarn watch`). With MAILAB_TOKENS set, pass a token.
"""

import binascii
import json
import os
import struct
import sys
import urllib.request

URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000").rstrip("/")
TOKEN = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("MAILAB_TOKEN")
HEADERS = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
if TOKEN:
    HEADERS["authorization"] = "Bearer " + TOKEN


def beacon_frame(ssid=b"mAIlab", bssid="deadbeef0001"):
    """A minimal 802.11 beacon management frame (MAC header + fixed params + tags + FCS)."""
    bssid = bytes.fromhex(bssid)
    mac = b"\x80\x00" + b"\x00\x00" + b"\xff\xff\xff\xff\xff\xff" + bssid + bssid + b"\x00\x00"
    fixed = struct.pack("<QHH", 0, 100, 0x0401)           # timestamp, 100 TU interval, caps
    tags = bytes([0, len(ssid)]) + ssid + bytes([1, 4, 0x82, 0x84, 0x8b, 0x96])  # SSID, rates
    body = mac + fixed + tags
    return body + struct.pack("<I", binascii.crc32(body) & 0xFFFFFFFF)


def mcp(name, arguments):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": arguments}}).encode()
    req = urllib.request.Request(URL + "/mcp", body, HEADERS)
    res = json.loads(urllib.request.urlopen(req).read())["result"]
    if res.get("isError"):
        raise SystemExit("%s failed: %s" % (name, res["content"][0]["text"]))
    return json.loads(res["content"][0]["text"])


def main():
    frame = beacon_frame()
    here = os.path.dirname(os.path.abspath(__file__))
    ksy = open(os.path.join(here, "beacon.ksy")).read()
    print("beacon frame: %d bytes  %s" % (len(frame), frame.hex()))

    # 1. the crafted bytes as a blob (the kaitai pane parses them into fields)
    mcp("blob_write", {"name": "beacon", "hex": frame.hex()})

    # 2. one flowgraph: bytes -> QAM256 -> loopback channel -> spectrum + recovered constellation
    mcp("device_add", {"id": "fg", "driver": "flowgraph", "options": {"graph": {
        "blocks": [
            {"id": "src", "type": "bits", "params": {"pattern": "hex:" + frame.hex(), "bitrate": 20000, "preamble": "aaaa", "sync": "2dd4"}},
            {"id": "tx", "type": "mod", "params": {"scheme": "qam256", "sps": 8}},
            {"id": "air", "type": "channel", "params": {"snr_db": 30}},
            {"id": "spec", "type": "spectrum", "params": {}},
            {"id": "mf", "type": "matched_filter", "params": {"sps": 8}},
            {"id": "sync", "type": "symbol_sync", "params": {"sps": 8}},
            {"id": "con", "type": "constellation", "params": {}},
        ],
        "links": [["src", "tx"], ["tx", "air"], ["air", "spec"], ["air", "mf"], ["mf", "sync"], ["sync", "con"]],
    }}})

    # 3. panes: the parsed frame, the spectrum, the constellation, the graph
    mcp("pane_add", {"type": "kaitai", "title": "beacon frame", "config": {"blob": "beacon", "ksy": ksy}, "x": 0, "y": 0, "w": 6, "h": 7})
    mcp("pane_add", {"type": "trace", "title": "spectrum (QAM256 at baseband)", "config": {"trace": "fg_spec"}, "x": 6, "y": 0, "w": 6, "h": 4})
    mcp("pane_add", {"type": "trace", "title": "constellation (after loopback)", "config": {"trace": "fg_con"}, "x": 6, "y": 4, "w": 6, "h": 3})
    mcp("pane_add", {"type": "flowgraph", "title": "beacon -> QAM256 -> loopback", "config": {"device": "fg"}, "x": 0, "y": 7, "w": 12, "h": 4})

    print("built: open", URL, "- the beacon bytes flow bits -> QAM256 -> channel -> spectrum/constellation")


if __name__ == "__main__":
    main()
