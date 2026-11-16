---
group: dsp
summary: "keeps every n-th sample (no filtering)"
related: [resample, lowpass, spectrum]
---

Keeps every `n`-th sample: the output rate is the input rate divided by `n`. It does no filtering, so anything
above the new Nyquist frequency aliases; put a `lowpass` with a cutoff below `rate / (2n)` in front, or use `resample`,
which filters for you and allows any ratio. Cheap and exact for integer ratios.
