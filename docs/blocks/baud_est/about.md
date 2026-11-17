---
group: digital
summary: "estimate the symbol rate of an FSK/OOK stream from its zero crossings"
related: [bits, discriminator, clock_recovery, uart_rx]
---

Baud estimation from the mid-level crossings of a demodulated or sliced stream. Feed it the output of a
`discriminator` (complex IQ in) or a sliced/NRZ bit stream (real values in): it measures the mean interval
between crossings, expects each crossing pair to span two symbol periods, and publishes the estimated baud
to `value <device>_<id>` a few times per second (`fps`). Handy when the air rate of an unknown FSK signal
has to be found before `clock_recovery` / `uart_rx` can be configured — or to confirm a drifted crystal.
Constant input (dead carrier) publishes no estimate.
