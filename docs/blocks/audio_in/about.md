---
group: sources
summary: "a lab audio stream (browser mic, another graph) into the graph"
related: [audio, audio_file, denoise, spectral_nr]
---

Brings a lab audio stream into the graph: a browser microphone (a `capture` pane streams it as
`<device>_mic`), another graph's `audio` sink, or any device that publishes audio. Samples arrive as real values in
[-1, 1) at the stream's rate; the flowgraph device subscribes to the stream and forwards it, dropping the oldest
chunks when the graph falls behind (`max_queue`). Use it for live audio processing on a mic (the `voice_cleanup`
template takes `{stream}`), for measuring an audio path, or for chaining two graphs. Typical chain:
`audio_in -> biquad -> denoise -> compressor -> audio`.
