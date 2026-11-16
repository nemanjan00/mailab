---
group: modem
summary: "symbol timing recovery, one sample per symbol out"
related: [matched_filter, carrier_recovery, slicer, constellation]
---

Symbol timing recovery for RRC-shaped linear modulations: a polyphase matched filter bank and timing loop
(liquid symsync) take samples at `sps` per symbol and output one sample per symbol at the optimum instant. `method`
gardner (matched filter + Gardner detector) is better for rectangular qam32, where the liquid loop can mis-lock; for
QAM64 and up lower `bandwidth` to 0.001-0.003. Follow with `carrier_recovery` if there is a frequency offset, then
`slicer` or `demod`.
