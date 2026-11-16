---
group: views
summary: "records audio to a WAV file"
related: [audio_file, audio, level_trigger]
---

Records real samples to a 16-bit mono WAV file at the input rate, in `DATA_DIR/media` (default name
`<block id>.wav`) or another path inside the media directories. The file is finalized when the graph changes or stops.
Use it to keep a demodulated transmission or a processed recording; read it back with `audio_file` or the media tools
(`media_probe`, `audio_to_pcm`).
