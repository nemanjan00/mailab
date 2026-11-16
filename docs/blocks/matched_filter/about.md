---
group: dsp
summary: "RRC receive filter matching the transmitter"
related: [mod, eye, clock_recovery, symbol_sync]
---

Root-raised-cosine receive filter matching the transmitter's RRC shaping (same `sps` and `beta`). Transmit RRC
times receive RRC is a raised cosine, which has no inter-symbol interference at the symbol instants and maximizes SNR,
so the eye opens. Use it before `clock_recovery` or an `eye` view; `symbol_sync` already contains one (don't put both).
