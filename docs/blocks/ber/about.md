---
group: digital
summary: "bit error rate against a PRBS, self-synchronizing"
related: [bits, slicer, channel]
---

Bit error rate meter against a PRBS of order `prbs` (the transmitter's `bits` pattern). It synchronizes itself
from the received bits, so no alignment, delay or framing is needed, and publishes the BER per `window` bits plus a
running error count. Use it to compare receivers, tune loop bandwidths or sweep `channel` SNR (`set_param`) for a
waterfall curve. Phase ambiguities (a slicer locked 180 degrees off) show up as BER 0.5.
