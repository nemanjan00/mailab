---
group: dsp
summary: "Kaiser FIR low-pass / channel filter"
related: [shift, resample, decimate, fir_filter]
---

Kaiser-windowed FIR low-pass (liquid firfilt) on complex or real samples: passes |f| below `cutoff`, more `taps`
give a sharper transition at the cost of delay and CPU. On complex IQ it is a channel filter (a band of ±cutoff around
0 Hz), so it usually follows `shift` and precedes `resample` or `decimate`. For audio-style filters (high-pass,
band-pass, notch, shelves) use `biquad` or `fir_filter`.
