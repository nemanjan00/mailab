---
group: sources
summary: "complex tone plus noise, the basic test signal"
related: [modulated, spectrum, scope, channel]
---

The simplest source: a complex exponential at `freq` plus complex white noise, generated in real time at `rate`.
Use it to test a chain before real hardware is connected: filter responses (spectrum before/after), mixers and
resamplers, AGC, scope triggers and measurements. Because it is complex, a positive `freq` shows up on the right of a
spectrum and a negative one on the left; blocks that want real audio (audio sinks, audio processing, `analog_mod`) use
its real part, a cosine. Typical chains: `signal -> spectrum`, `signal -> lowpass -> spectrum`, `signal -> analog_mod -> fm_demod -> scope`.
