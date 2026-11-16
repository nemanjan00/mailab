---
group: sources
summary: "802.11a/g-style OFDM transmitter: 64-pt IFFT, 48 data + 4 pilot subcarriers, STF/LTF preamble"
related: [ofdm_demod, channel, spectrum, mod]
---

An 802.11a/g-style OFDM *signal source*: `input` bits (hex:.. / text:.. / bits:..) are scrambled, mapped to
QAM per subcarrier (802.11 Gray mapping and K_MOD normalization; `scheme` bpsk|qpsk|qam16|qam64|qam256, or the
`mcs` alias), placed on 48 data + 4 pilot subcarriers (−26…26, DC and guards nulled, pilots on ±7/±21 with the
standard polarity sequence), 64-point IFFT, 16-sample cyclic prefix, and a short+long training preamble
(STF 160 + LTF 160 samples). The packet repeats with a `gap` of zeros at `rate`. Loop it through `channel` into
`ofdm_demod` to recover the bytes. Faithful in shape and demodulation, but *not* a bit-compatible 802.11 frame
(no convolutional code, interleaver or SIGNAL field) and **not a transmitter** — the TX path stays behind the
SDR safety gate.
