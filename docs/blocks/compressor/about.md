---
group: audio
summary: "dynamics compressor with knee, lookahead, sidechain HPF"
related: [limiter, gate, audio_agc]
---

Dynamics compressor: above `threshold_db` the level rises only 1/`ratio` dB per input dB, with a soft `knee`,
`attack_ms` / `release_ms` smoothing of the gain, `makeup_db` after it, RMS or peak detection, an optional sidechain
high-pass (so bass doesn't pump the gain) and `lookahead_ms` so the gain leads transients. Evens out speech levels
before a limiter; the gain reduction is a channel. All parameters change live.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
