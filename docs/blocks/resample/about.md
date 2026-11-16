---
group: dsp
summary: "any-ratio, anti-aliased resampler to a new rate"
related: [decimate, lowpass, fm_demod, audio]
---

Arbitrary-ratio resampler (liquid msresamp, anti-aliased) to an output `rate`. Use it to bring a channel down to
a rate the next block likes (48 kHz audio, a multiple of the symbol rate), or to match the rate of an audio sink or
WAV file. Unlike `decimate`, any ratio works and filtering is built in. Typical chain:
`soapy -> shift -> lowpass -> resample (48 kHz) -> fm_demod -> audio`.
