---
group: sources
summary: "ready-made RRC-shaped digital test signal (PSK/QAM/APSK) with noise and offsets"
related: [mod, symbol_sync, constellation, eye]
---

A ready-made digitally modulated test signal: random symbols of `scheme` (bpsk, qpsk, psk8, qam16, qam64,
apsk16 and every other liquid-dsp linear scheme), root-raised-cosine shaped at `sps` samples per symbol, with AWGN at
`snr_db`, an optional carrier offset (`cfo`) and phase. It saves wiring `bits -> mod -> channel` when you only need a
signal to look at or to exercise a receiver: symbol timing, carrier recovery, demodulation, EVM. It does not carry a
known bit pattern, so use `bits` + `mod` when you need a BER measurement.
