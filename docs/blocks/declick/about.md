---
group: audio
summary: "removes clicks and crackle"
related: [spectral_nr, limiter, audio_file]
---

De-click / de-crackle: impulses are detected on the second difference against a running level and
interpolated over (up to `max_ms` long, `width` samples of margin). `mode: crackle` lowers the threshold for dense
vinyl crackle. Repairs clicks from bad connections, switching transients and record noise without dulling the audio.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
