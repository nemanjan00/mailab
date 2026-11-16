---
group: modem
summary: "decision-directed PLL removing carrier offset and phase"
related: [symbol_sync, channel, slicer, demod]
---

Decision-directed carrier PLL on symbols: removes a residual carrier frequency offset and phase by rotating each
symbol toward the nearest point of `scheme`'s constellation. It works one sample per symbol, so it goes after
`symbol_sync`; `bandwidth` trades lock range and speed against jitter. Like any decision-directed loop it has the
constellation's phase ambiguity (90 degrees for QPSK), so use differential schemes or a sync word when the absolute
phase matters.
