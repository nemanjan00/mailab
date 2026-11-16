---
group: audio
summary: "finds and notches stationary tones automatically"
related: [hum_notch, biquad, am_demod]
---

Finds and removes stationary tones automatically: it keeps a long-term spectrum (`resolution`, `average_s`),
picks up to `tones` peaks that stand `min_snr_db` above the floor for `persist_s`, and notches them, retuning as they
drift. Whistles, heterodynes on AM/SSB, coil whine. Give `freqs` to notch fixed frequencies instead. The tracked tones
are in the block's stats.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
