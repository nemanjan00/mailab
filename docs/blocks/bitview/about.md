---
group: digital
summary: "shows the last bits of a stream as binary and hex"
related: [bits, slicer, framer, uart_rx]
---

Shows the last `bits` bits of a stream as binary and hex in a value (and keeps the whole stream as a blob). The
first thing to look at after a `slicer` on an unknown signal: preambles (`0101...` / `aa`), sync words and repeating
structure stand out before you configure a `framer` or a decoder.
