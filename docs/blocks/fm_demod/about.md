---
group: modem
summary: "FM demodulator to audio"
related: [analog_mod, soapy, resample, audio]
---

FM demodulator (liquid freqdem): complex baseband in, real audio out, scaled so a `deviation` Hz swing gives ±1.
The FM signal must be centered at 0 Hz (use `shift`) and filtered to its channel (`lowpass`); for voice, resample to
48 kHz first and follow with `dc_block`, a 3.4 kHz low-pass and an `audio` sink. The `sdr_fm_audio` template builds
the whole NBFM receiver.
