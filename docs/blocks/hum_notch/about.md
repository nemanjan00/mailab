---
group: audio
summary: "50/60 Hz mains hum and harmonics remover"
related: [auto_notch, biquad, dc_block]
---

Removes mains hum: narrow notches at `freq` (50 or 60 Hz, or `auto` to pick it from the first second) and its
`harmonics`, each `width` Hz wide (or a fixed `q`), so the audio between the harmonics is untouched. Put it early in
the chain, after a `dc_block`. The `hum_removal` template combines it with `auto_notch`.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
