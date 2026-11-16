---
group: modem
summary: "symbol decisions and EVM for a linear scheme"
related: [slicer, symbol_sync, constellation]
---

Symbol decisions for a linear `scheme`: outputs the symbol index of the nearest constellation point for each
input symbol and publishes the EVM (error vector magnitude, dB) as a channel. Use it as a link-quality meter on a
received constellation. To get bits out (for `ber`, `framer`, `bitview`) use `slicer`, which also measures EVM.
