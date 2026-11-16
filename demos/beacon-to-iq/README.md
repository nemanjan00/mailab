# Bytes → IQ → spectrum, in a few MCP calls

Craft an 802.11 beacon frame, parse it, modulate the bytes as QAM256 and watch
the signal — the whole thing an AI drives in six tool calls.

![beacon to IQ](screenshot.png)

```sh
# with mailab running (yarn watch):
python3 demos/beacon-to-iq/beacon.py            # or: beacon.py http://host:3000 <token>
```

The calls:

| call | |
|---|---|
| `blob_write` | the crafted beacon bytes → blob `beacon` |
| `device_add fg flowgraph` | `bits(hex:…) → mod(qam256) → channel` then `spectrum`, and `matched_filter → symbol_sync → constellation` |
| `pane_add kaitai` | the frame parsed into fields ([beacon.ksy](beacon.ksy)) |
| `pane_add trace fg_spec` | the QAM256 spectrum at baseband |
| `pane_add trace fg_con` | the recovered constellation |
| `pane_add flowgraph fg` | the graph |

`kaitai_parse` reads the frame back as: frame control `0x8000` (beacon),
broadcast destination, BSSID `de:ad:be:ef:00:01`, beacon interval 100 TU,
SSID `mAIlab`, supported-rates tag, FCS.

## This is a DSP demo, not a transmitter

- **Nothing radiates.** The signal loops through the `channel` block (AWGN at
  30 dB), the same way the modem toolkit is tested. There is no SDR in the chain.
- **It is not real Wi-Fi.** 802.11 is OFDM — dozens of subcarriers with pilots,
  scrambling, convolutional coding and interleaving, plus a preamble.
  Single-carrier QAM256 makes a pretty constellation but not a frame any access
  point would lock onto.
- **Transmitting fabricated beacons over the air is spoofing / interference.**
  mailab's SDR TX path (`soapy_sink` / `tx_arm`) is deliberately gated: only the
  lab's allowed bands (`MAILAB_RF_REGION`, operator-configured extras), a
  person's approval per transmit, power caps and an auto-stop — 2.4 GHz Wi-Fi
  injection is not on that list. The licensed way to emit a beacon is a real
  Wi-Fi NIC in AP mode.
