---
group: audio
summary: "spectral noise reduction (Wiener / subtraction)"
related: [denoise, gate, hum_notch]
---

Classic spectral noise reduction on an STFT (sqrt-Hann, 50 % overlap): Wiener filtering with a
decision-directed SNR estimate, or spectral subtraction. The noise profile is tracked automatically (minimum
statistics), learned on demand (`noise: learn` during a noise-only stretch, then `hold`), or learned from the first
`learn_s` seconds. `floor_db` caps the attenuation so the result doesn't sound watery. CPU-only, a few ms of latency;
for stronger, speech-aware reduction use `denoise`.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
