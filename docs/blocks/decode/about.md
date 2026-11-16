---
group: digital
summary: "sigrok / builtin protocol decoder on logic samples (UART, SPI, I2C...)"
related: [uart_tx, uart_rx, net_source, framer]
---

Protocol decoder on logic samples: bit k of each input word is channel k (analog input is thresholded into
channel 0). Runs the real libsigrokdecode decoder scripts (uart, spi, i2c, can, onewire_link, spiflash... any installed
decoder, stackable) or builtin numpy decoders (uart, spi, i2c, manchester) when sigrok isn't installed. Annotations
land in a table value, events, log lines and a blob of data bytes. Feed it from `uart_tx`, a logic stream over
`net_source` (u8/u16 words), or push captures with the device's `feed` command; one-shot decodes of a capture use the
`decode` command instead of a block.
