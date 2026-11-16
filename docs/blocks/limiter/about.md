---
group: audio
summary: "brickwall lookahead limiter"
related: [compressor, audio_agc, audio]
---

Brickwall lookahead limiter: the output never exceeds `ceiling_db`. It delays the audio by `lookahead_ms` so
the gain is already down when a peak arrives, then recovers with `release_ms`. The last block before an `audio` sink,
a WAV file or a transmitter, protecting against clipping after gain stages; gain reduction is a channel.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
