---
group: audio
summary: "audio level AGC to a target dBFS"
related: [agc, compressor, limiter]
---

Audio automatic gain control: brings the RMS level to `target_db` with gain between `min_gain_db` and
`max_gain_db`, reducing gain fast (`attack_ms`) and raising it slowly (`release_ms`); below `noise_floor_db` it holds
the gain so silence isn't pumped up into hiss. Use it after a demodulator or on a mic of unknown level, followed by a
`limiter`. The gain is a channel.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
