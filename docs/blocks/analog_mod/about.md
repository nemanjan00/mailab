---
group: modem
summary: "audio to AM, DSB, SSB, FM or PM baseband"
related: [fm_demod, am_demod, signal, audio_file]
---

Analog modulator: real audio in, complex baseband out as AM (with carrier, `index` = modulation depth), DSB
(suppressed carrier), USB / LSB (single sideband), FM (`deviation` Hz) or PM (`index` radians). Use it to build test
signals for receivers (`analog_mod -> channel -> fm_demod -> audio`) or to feed a transmitter over `net_sink`.
Sample rate stays the same, so make sure it's high enough for the bandwidth (Carson: 2 x (deviation + audio bandwidth)).
