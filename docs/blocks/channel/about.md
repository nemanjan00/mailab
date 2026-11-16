---
group: channel
summary: "AWGN, carrier offset, phase and gain between TX and RX"
related: [modulated, symbol_sync, carrier_recovery, ber]
---

A test channel between a transmitter and a receiver: AWGN at `snr_db` relative to the measured signal power, a
carrier frequency offset `cfo`, a fixed `phase` rotation and a linear `gain`. Put it after `mod` (or `analog_mod`) to see
how a receiver copes: sweep `snr_db` with `set_param` while watching a `ber` meter or the EVM from `slicer`, add a few
hundred Hz of `cfo` to exercise `carrier_recovery`. Real input becomes complex.
