---
group: views
summary: "spectrum analyzer trace: RBW, window, max/min hold, averaging"
related: [scope, constellation, measure, signal]
---

Spectrum analyzer: set a resolution bandwidth `rbw` (FFT size follows from the rate and window) or an `fft` size,
a `window` (hann, blackmanharris for dynamic range, flattop for amplitude accuracy), and which `traces` to draw: live,
max hold, min hold, power average over `average` frames. `points` reduces the display with a peak or sample detector.
Real input shows positive frequencies only, `center` shifts the axis to RF. Put two spectrum blocks before and after a
chain and `overlay` one on the other for before/after in one plot. In the trace pane: markers, peak search, and a
waterfall pane on the same trace.
