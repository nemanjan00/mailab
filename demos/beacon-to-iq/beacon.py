#!/usr/bin/env python3
"""Bytes -> real OFDM -> spectrum + recovered constellation, in a few MCP calls.

Crafts an 802.11 beacon frame, stores it as a lab blob (parsed by a Kaitai
struct in the kaitai pane), then modulates the bytes with a real 802.11a/g-style
OFDM transmitter (`ofdm_mod`: 64-pt IFFT, 48 data + 4 pilot subcarriers, cyclic
prefix, STF/LTF preamble, scrambled QAM) and loops the IQ back through the
`channel` block into `ofdm_demod`, which packet-detects, corrects the carrier
offset, equalizes from the LTF, tracks the pilots and recovers the bytes. The
panes show the OFDM spectrum (the ~filled block), the equalized subcarrier
constellation (a clean QAM grid) and the recovered frame.

This is a DSP demo: it does NOT transmit. The OFDM waveform is faithful enough
to look and demod like 802.11 OFDM, but it omits the convolutional code,
interleaver and SIGNAL field, so it is not a bit-compatible 802.11 frame. Over-
the-air transmit is a separate, approval-gated, band-limited path (see the RF
safety notes in the README); this stays entirely in a loopback channel.

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

    # 16-QAM OFDM: 48 data subcarriers x 4 bits = 192 bits per OFDM symbol
    scheme = "qam16"
    bits_per_sym = 48 * 4
    n_sym = -(-len(frame) * 8 // bits_per_sym)   # ceil

    # 1. the crafted bytes as a blob (the kaitai pane parses them into fields)
    mcp("blob_write", {"name": "beacon", "hex": frame.hex()})

    # 2. one flowgraph: beacon bytes -> real OFDM -> loopback channel ->
    #    OFDM spectrum, and ofdm_demod -> equalized constellation + recovered bits
    mcp("device_add", {"id": "fg", "driver": "flowgraph", "options": {"graph": {
        "blocks": [
            {"id": "tx", "type": "ofdm_mod", "params": {"input": "hex:" + frame.hex(), "scheme": scheme, "n_sym": n_sym, "rate": 20e6}},
            {"id": "air", "type": "channel", "params": {"snr_db": 40}},
            {"id": "spec", "type": "spectrum", "params": {"fft": 256, "traces": ["avg"], "average": 16}},
            {"id": "rx", "type": "ofdm_demod", "params": {"scheme": scheme, "n_sym": n_sym}},
            {"id": "bits", "type": "bitview", "params": {"bits": len(frame) * 8}},
        ],
        "links": [["tx", "air"], ["air", "spec"], ["air", "rx"], ["rx", "bits"]],
    }}})

    # 3. panes: parsed frame, OFDM spectrum, equalized constellation, channel est, recovered bytes, graph
    mcp("pane_add", {"type": "kaitai", "title": "beacon frame", "config": {"blob": "beacon", "ksy": ksy}, "x": 0, "y": 0, "w": 6, "h": 8})
    mcp("pane_add", {"type": "trace", "title": "OFDM spectrum (48 data + 4 pilots, 64-pt FFT)", "config": {"trace": "fg_spec"}, "x": 6, "y": 0, "w": 6, "h": 4})
    mcp("pane_add", {"type": "trace", "title": "equalized subcarrier constellation (16-QAM)", "config": {"trace": "fg_rx_const"}, "x": 6, "y": 4, "w": 6, "h": 4})
    mcp("pane_add", {"type": "json", "title": "recovered bytes (after OFDM demod)", "config": {"value": "fg_bits"}, "x": 0, "y": 8, "w": 3, "h": 3})
    mcp("pane_add", {"type": "trace", "title": "LTF channel estimate |H|", "config": {"trace": "fg_rx_chan"}, "x": 3, "y": 8, "w": 3, "h": 3})
    mcp("pane_add", {"type": "flowgraph", "title": "beacon -> OFDM -> loopback -> demod", "config": {"device": "fg"}, "x": 6, "y": 8, "w": 6, "h": 3})

    print("built: open", URL, "- beacon bytes -> OFDM -> channel -> ofdm_demod recovers them;",
          "spectrum + equalized constellation + channel estimate are live")


if __name__ == "__main__":
    main()
