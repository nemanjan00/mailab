---
group: dsp
summary: "normalizes IQ to unit power"
related: [audio_agc, symbol_sync, measure, carrier_recovery]
---

Automatic gain control for IQ (liquid agc_crcf): normalizes the signal to unit power with a loop `bandwidth`.
Put it in front of blocks that assume a known level: symbol timing and carrier recovery, slicers with fixed decision
thresholds, constellation views. Small bandwidths react slowly but don't modulate the signal; large ones track fades
fast. For audio levels use `audio_agc` (attack/release in ms, gain limits).
