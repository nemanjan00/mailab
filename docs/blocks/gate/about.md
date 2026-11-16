---
group: audio
summary: "noise gate / downward expander"
related: [compressor, spectral_nr, audio_agc]
---

Noise gate (`ratio` 0) or downward expander (`ratio` > 1): below `threshold_db` the audio is attenuated by up
to `range_db`. The gate opens above the threshold and closes `hysteresis_db` below it after `hold_ms`, with
`attack_ms` / `release_ms` ramps, so it doesn't chatter. Silences hiss and hum between words; for noise during speech
use `spectral_nr` or `denoise`.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
