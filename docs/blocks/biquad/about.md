---
group: audio
summary: "RBJ biquad: low/high/band-pass, notch, peaking, shelves"
related: [fir_filter, hum_notch, dc_block, lowpass]
---

Second-order IIR filter from the RBJ cookbook: lowpass, highpass, bandpass, notch, peaking EQ, low/high shelf,
allpass, with `stages` identical sections in cascade for a steeper slope. No added latency, and `freq`, `q` and
`gain_db` change live through `set_param` while audio plays. The everyday audio filter: an 80 Hz high-pass in front of
voice processing, a 3.4 kHz low-pass after a demodulator, a presence peak.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
