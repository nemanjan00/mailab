---
group: modem
summary: "symbols to bits (linear schemes or 2/4-level real), with EVM"
related: [symbol_sync, clock_recovery, ber, framer, bitview]
---

Turns symbols into bits. Complex input is demodulated against the linear `scheme` (and the EVM is published as a
channel); real input is sliced with an adaptive threshold (`levels` 2) or as Gray-coded 4-FSK (`levels` 4). It sits at
the end of every digital receive chain (`symbol_sync` or `clock_recovery` before it) and feeds `ber`, `framer`,
`bitview` or `uart_rx`.
