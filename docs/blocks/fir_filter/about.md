---
group: audio
summary: "linear-phase FIR low/high/band-pass, band-stop"
related: [biquad, lowpass, hum_notch]
---

Linear-phase windowed-sinc FIR (Kaiser window, `beta` sets the stopband): lowpass, highpass, bandpass,
bandstop. Unlike `biquad` it has constant group delay (latency (taps-1)/2 samples, shown in the stats) and a very flat
passband, so use it where phase matters or a brick-wall band edge is wanted, e.g. a telephone band 300-3400 Hz.

The example plays a generated test recording (`$MEDIA/demo.wav`: a buzzy voice-like signal with 50 Hz hum, a 4 kHz whistle, hiss and clicks); with a microphone, swap `src` for `audio_in` {stream: "browser_mic"}.
