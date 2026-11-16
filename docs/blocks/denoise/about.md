---
group: audio
summary: "neural speech denoise (DeepFilterNet, RNNoise)"
related: [spectral_nr, audio_in, gate]
---

Neural speech denoising. Backends: `deepfilternet` (DeepFilterNet3 on a CUDA GPU; installed into the mailab
venv on first use, audio passes through meanwhile), `rnnoise` (Xiph RNNoise on CPU, needs librnnoise), `maxine`
(NVIDIA Maxine, detection only), `auto` (deepfilternet with CUDA, else rnnoise). It resamples to 48 kHz internally;
the stats show the backend, device, real-time factor and latency. Use it for voice on a noisy mic or radio channel;
the `voice_cleanup` template wraps it with filters and dynamics.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
