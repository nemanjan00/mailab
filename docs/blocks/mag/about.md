---
group: dsp
summary: "magnitude |x|: envelope detector"
related: [scope, level_trigger, clock_recovery, measure]
---

Magnitude |x| of complex samples (real output). The envelope detector for OOK/ASK, burst detection and
amplitude measurements: `mag -> scope` shows a signal's envelope, `mag -> clock_recovery` (with `dc_block`) recovers
OOK symbols, `mag -> measure` gives an amplitude readout.
