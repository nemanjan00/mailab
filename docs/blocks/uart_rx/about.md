---
group: digital
summary: "UART receiver: line levels or bits to text"
related: [uart_tx, decode, slicer]
---

UART receiver on line levels (a logic capture, an analog trace, any oversampling: the rate divided by `baud`) or
on a bit stream: decoded bytes go to a value (text + hex), a blob, and each text line into the device log, where
classifiers and notifications can react to it; framing errors are counted. Set `invert` for idle-low lines (RS-232
levels). For other protocols, or sigrok's UART decoder with all its options, use `decode`.
