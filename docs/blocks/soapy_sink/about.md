---
group: sources
summary: "IQ out to a SoapySDR transmitter (bladeRF, HackRF, LimeSDR...)"
related: [soapy, net_sink, modulated, spectrum]
---

Transmits complex baseband to any SoapySDR device with a TX path (bladeRF, HackRF, LimeSDR, PlutoSDR...) at center
`freq`, sample `rate` and `gain`. `args` selects the device the way `SoapySDRUtil --find` prints it,
e.g. `driver=bladerf` or `driver=hackrf`.

**This block is gated.** The lab refuses to start a graph containing a `soapy_sink` outside the shared TX policy
(`src/txpolicy`): the frequency must sit inside the `MAILAB_RF_REGION` bands plus any `MAILAB_RF_TX_EXTRA`
person-configured ranges, TX gain is capped by `MAILAB_RF_TX_MAX_GAIN`, the run asks for approval like any other
transmission, and the lab opens a TX session that auto-stops after `MAILAB_RF_TX_MAX_SECONDS` and can be killed
from the UI banner, `POST /api/tx/kill`, or the MCP `tx_kill` tool. Under `MAILAB_RF_CHAMBER` / `MAILAB_UNSAFE`
the band check is skipped. The bridge re-checks the band a second time on load unless `--chamber` was passed.

Feed it like any sink: a `modulated` source for a test carrier, or a full modem chain (`mod` → `channel` → pulse
shape → `soapy_sink`). Watch the transmitted spectrum with a second (receive) device or an `rtl_power` scan.
