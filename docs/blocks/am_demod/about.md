---
group: modem
summary: "AM / USB / LSB demodulator to audio"
related: [analog_mod, fm_demod, auto_notch, audio]
---

AM / SSB demodulator (liquid ampmodem): `am` is an envelope detector for double-sideband AM, `usb` / `lsb`
recover single-sideband voice. The signal has to be centered at 0 Hz (for SSB: the suppressed carrier at 0 Hz) and
filtered to the channel. Follow with `dc_block` (AM leaves the carrier as DC), an audio low-pass and `audio`; the
`sdr_am_audio` template adds a heterodyne notch, noise reduction and AGC.
