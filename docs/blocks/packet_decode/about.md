---
group: digital
summary: "decode BLE advertising or nRF Enhanced ShockBurst packets out of a raw bit stream"
related: [slicer, clock_recovery, bits, decode]
---

Packet decoder for the two most common 2.4 GHz "protocols of opportunity". Feed it on-air bits in receive
order (first bit first, each byte LSB first — exactly what `slicer` / `uart_rx`-style chains produce at one
sample per bit):

- `protocol` `ble`: finds the advertising access address `0x8E89BED6`, dewhitens the PDU with the
  `channel` LFSR, and checks the CRC-24. Reports PDU type, length, advertiser address (`addr`) and payload.
- `protocol` `esb`: syncs on the pipe `address` (hex, 3-5 bytes), reads the 9-bit PCF (length / PID / no-ack)
  and checks the nRF CRC-8.

`max_errors` tolerates bit errors in the sync word. Every decoded packet lands in `value <device>_<id>`
(newest `keep` packets, each with a `crc_ok` flag), and a total count is published on channel
`<device>_<id>_count`. Pair it with `baud_est` + `clock_recovery` to pull packets off a raw IQ recording,
or watch an nRF sniffer live.
