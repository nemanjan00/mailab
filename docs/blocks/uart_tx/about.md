---
group: digital
summary: "UART transmitter: text or hex to line levels"
related: [uart_rx, decode, scope]
---

UART transmitter: `text` (escape sequences like `\r\n` work) or `hex` bytes framed with start bit, `bits` data
bits, optional parity and `stop` bits, as line levels (1 = idle) at `baud` x `sps` samples per second, repeated every
`repeat_ms`. Use it to test `uart_rx` and `decode`, to generate a reference waveform, or with `sps` 1 as a bit stream
into `mod` for an over-the-air serial link.
