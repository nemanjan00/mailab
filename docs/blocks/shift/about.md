---
group: dsp
summary: "moves a signal at +offset Hz to 0 Hz"
related: [lowpass, resample, spectrum, file]
---

Frequency shift (complex mixer, liquid NCO): moves a signal sitting at `+offset` Hz down to 0 Hz. It is the first
step of tuning to one channel inside a wider capture: `shift` the channel to baseband, `lowpass` to its bandwidth,
`resample` (or `decimate`) to a sensible rate, then demodulate. A negative offset moves a signal from below center.
