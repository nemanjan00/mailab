#!/usr/bin/env python3
"""PRBS -> 16-QAM -> AWGN -> BER waterfall, swept live with the sweep tool.

Builds an uncoded 16-QAM link (PRBS-15 -> RRC pulse shaping -> symbol timing
recovery -> slicer -> self-synchronizing BER meter), then sweeps the channel
SNR from 4 to 20 dB with the `sweep` tool - one approval-free plan, nine
points - and stores the BER-vs-SNR table and curve. The panes show the
waterfall next to the live constellation and spectrum.

This is a DSP demo: nothing radiates, the signal loops through the `channel`
block. Over-the-air transmit is a separate, approval-gated, band-limited path
(see demos/beacon-to-iq/README.md).

    python3 demos/qam-ber/qam_ber.py [http://127.0.0.1:3000] [token]

Needs a running mailab (`yarn watch`). With MAILAB_TOKENS set, pass a token.
The sweep takes about a minute.
"""

import json
import os
import sys
import time
import urllib.request

URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000").rstrip("/")
TOKEN = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("MAILAB_TOKEN")
HEADERS = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
if TOKEN:
    HEADERS["authorization"] = "Bearer " + TOKEN


def mcp(name, arguments):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": arguments}}).encode()
    req = urllib.request.Request(URL + "/mcp", body, HEADERS)
    res = json.loads(urllib.request.urlopen(req).read())["result"]
    if res.get("isError"):
        raise SystemExit("%s failed: %s" % (name, res["content"][0]["text"]))
    return json.loads(res["content"][0]["text"])


def main():
    # one flowgraph: prbs -> 16-qam -> awgn -> symbol sync -> slicer -> ber
    mcp("device_add", {"id": "fg", "driver": "flowgraph", "options": {"graph": {
        "blocks": [
            {"id": "src", "type": "bits", "params": {"pattern": "prbs15", "bitrate": 9600}},
            {"id": "tx", "type": "mod", "params": {"scheme": "qam16", "sps": 8, "beta": 0.35}},
            {"id": "air", "type": "channel", "params": {"snr_db": 12}},
            {"id": "spec", "type": "spectrum", "params": {"fft": 1024, "traces": ["avg"], "average": 16}},
            {"id": "sym", "type": "symbol_sync", "params": {"sps": 8, "beta": 0.35}},
            {"id": "const", "type": "constellation", "params": {"points": 2000}},
            {"id": "sl", "type": "slicer", "params": {"scheme": "qam16"}},
            {"id": "ber", "type": "ber", "params": {"prbs": 15, "window": 20000, "fps": 2}},
        ],
        "links": [["src", "tx"], ["tx", "air"], ["air", "spec"], ["air", "sym"],
                  ["sym", "const"], ["sym", "sl"], ["sl", "ber"]],
    }}})

    # the waterfall: step the channel SNR, average the BER meter over each point
    print("sweeping SNR 4..20 dB (about a minute)...")
    table = mcp("sweep", {
        "name": "ber_vs_snr",
        "x": {"device": "fg", "command": "set_param",
              "args": {"block": "air", "key": "snr_db", "value": "$value"},
              "from": 4, "to": 20, "steps": 9, "unit": "dB"},
        "reads": [{"channel": "fg_ber", "mode": "mean", "windowMs": 4000}],
        "settleMs": 1500,
        "yUnit": "BER",
        "after": {"device": "fg", "command": "set_param", "args": {"block": "air", "key": "snr_db", "value": 16}},
    })
    print(json.dumps(table, indent=1)[:600])

    mcp("pane_add", {"type": "trace", "title": "BER vs SNR, uncoded 16-QAM (swept live)", "config": {"trace": "ber_vs_snr"}, "x": 0, "y": 0, "w": 6, "h": 5})
    mcp("pane_add", {"type": "json", "title": "sweep table (SNR dB -> BER)", "config": {"value": "ber_vs_snr"}, "x": 0, "y": 5, "w": 3, "h": 4})
    mcp("pane_add", {"type": "trace", "title": "received constellation at 16 dB", "config": {"trace": "fg_const"}, "x": 6, "y": 0, "w": 6, "h": 5})
    mcp("pane_add", {"type": "trace", "title": "spectrum at 16 dB", "config": {"trace": "fg_spec"}, "x": 6, "y": 5, "w": 6, "h": 4})
    mcp("pane_add", {"type": "flowgraph", "title": "prbs -> 16-qam -> awgn -> sym sync -> slicer -> ber", "config": {"device": "fg"}, "x": 3, "y": 5, "w": 3, "h": 4})

    # give the constellation a moment to clean up at 16 dB, then show the BER
    time.sleep(3)
    print("built: open", URL, "- BER waterfall swept 4..20 dB; constellation",
          "and spectrum live at 16 dB")


if __name__ == "__main__":
    main()
