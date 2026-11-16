---
group: audio
summary: "removes DC offset"
related: [biquad, hum_notch, am_demod]
---

One-pole DC blocker (high-pass at `cutoff` Hz): removes a DC offset or very slow drift, e.g. after
`am_demod` (the carrier becomes DC) or `fm_demod` (a frequency offset becomes DC), or on a sound card with a biased
input. Put it before dynamics processing, which would otherwise react to the offset.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
