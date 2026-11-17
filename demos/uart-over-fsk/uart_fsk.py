#!/usr/bin/env python3
"""UART text -> GFSK over a noisy channel -> recovered text, in a few MCP calls.

Types a line on a virtual UART, radios it as Gaussian-filtered FSK (GFSK,
h = 0.5) through an AWGN channel, then receives it the way a cheap sub-GHz
radio would: a frequency discriminator, Gardner timing recovery, a 2-level
slicer and a UART receiver - and the text comes out the other end. The panes
show the GFSK spectrum, the discriminator eye diagram and the received text.

This is a DSP demo: nothing radiates, the signal loops through the `channel`
block. Over-the-air transmit is a separate, approval-gated, band-limited path
(see demos/beacon-to-iq/README.md).

    python3 demos/uart-over-fsk/uart_fsk.py [http://127.0.0.1:3000] [token]

Needs a running mailab (`yarn watch`). With MAILAB_TOKENS set, pass a token.
"""

import json
import os
import sys
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
    text = "hello from mAIlab! "
    baud = 9600
    # one flowgraph: uart -> gfsk -> awgn -> discriminator -> timing -> slicer -> uart
    mcp("device_add", {"id": "fg", "driver": "flowgraph", "options": {"graph": {
        "blocks": [
            {"id": "uart", "type": "uart_tx", "params": {"text": text, "baud": baud, "sps": 1, "repeat_ms": 3000}},
            {"id": "tx", "type": "mod", "params": {"scheme": "gfsk", "sps": 8}},
            {"id": "air", "type": "channel", "params": {"snr_db": 16}},
            {"id": "spec", "type": "spectrum", "params": {"fft": 1024, "traces": ["avg"], "average": 16}},
            {"id": "disc", "type": "discriminator", "params": {"sps": 8, "h": 0.5}},
            {"id": "eye", "type": "eye", "params": {"sps": 8}},
            {"id": "clk", "type": "clock_recovery", "params": {"sps": 8}},
            {"id": "sl", "type": "slicer", "params": {"levels": 2}},
            {"id": "rx", "type": "uart_rx", "params": {"baud": baud}},
        ],
        "links": [["uart", "tx"], ["tx", "air"], ["air", "spec"], ["air", "disc"],
                  ["disc", "eye"], ["disc", "clk"], ["clk", "sl"], ["sl", "rx"]],
    }}})

    mcp("pane_add", {"type": "json", "title": "received UART text (after GFSK demod)", "config": {"value": "fg_rx"}, "x": 0, "y": 0, "w": 4, "h": 3})
    mcp("pane_add", {"type": "trace", "title": "GFSK spectrum (9600 baud, h = 0.5)", "config": {"trace": "fg_spec"}, "x": 4, "y": 0, "w": 8, "h": 4})
    mcp("pane_add", {"type": "trace", "title": "discriminator eye (two symbols per trace)", "config": {"trace": "fg_eye"}, "x": 0, "y": 3, "w": 4, "h": 5})
    mcp("pane_add", {"type": "flowgraph", "title": "uart -> gfsk -> awgn -> disc -> gardner -> slicer -> uart", "config": {"device": "fg"}, "x": 4, "y": 4, "w": 8, "h": 4})

    print("built: open", URL, "- uart text is GFSK-modulated, sent through AWGN",
          "and demodulated back to text; spectrum + eye are live")


if __name__ == "__main__":
    main()
