---
group: modem
summary: "bits to IQ: PSK, QAM, APSK, OOK, FSK, MSK, GFSK, GMSK..."
related: [bits, channel, symbol_sync, discriminator]
---

Digital modulator: bits in, complex baseband out. Linear schemes (bpsk, qpsk, psk8..256, dpsk, ask, qam4..256,
apsk, ook, pi4dqpsk, V.29...) are root-raised-cosine shaped with roll-off `beta`; CPFSK schemes (2fsk, 4fsk, msk,
gfsk, gmsk) use modulation index `h` and Gaussian `bt`. The output rate is bitrate / bits-per-symbol x `sps`. Feed it
from `bits` (PRBS for BER, or a framed pattern), follow with `channel` for impairments, and receive with
`symbol_sync` + `slicer` (linear) or `discriminator` + `clock_recovery` + `slicer` (FSK).
