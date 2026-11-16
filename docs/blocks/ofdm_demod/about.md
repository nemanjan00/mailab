---
group: modem
summary: "802.11a/g-style OFDM receiver: packet detect, CFO correct, LTF equalize, pilots, demap, descramble"
related: [ofdm_mod, channel, bitview, constellation]
---

The loopback receiver for `ofdm_mod`: STF autocorrelation **packet detection** (`threshold`), coarse/fine
**carrier-frequency-offset** estimate + correction (STF then LTF), 64-point FFT, **LTF least-squares channel
estimate** (published as trace `<dev>_<id>_chan`, |H| in dB per used subcarrier), per-subcarrier **zero-forcing
equalization**, **pilot** residual-phase tracking, QAM demap and descramble → output bits for `bitview` or `ber`.
The equalized subcarrier constellation is published as `<dev>_<id>_const` (trace mode `constellation`). Match
`scheme`, `cp_len` and `n_sym` to the transmitter (n_sym 0 = all symbols after the LTF). In a loopback
`ofdm_mod → channel → ofdm_demod` the bytes come back with BER ≈ 0.
