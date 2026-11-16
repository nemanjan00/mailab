---
group: sources
summary: "plays an audio file (WAV/FLAC/MP3/..., via ffmpeg) as real samples"
related: [audio, biquad, spectral_nr, denoise]
---

Decodes an audio file (WAV, FLAC, MP3, OGG, Opus, or the audio track of a video) with ffmpeg and plays it into
the graph as real samples at `rate`, paced like a live source (or as fast as the graph runs with `realtime: false`).
It is the usual input for building and tuning an audio processing chain before switching to a live microphone
(`audio_in`). Pick one `channel` of a multichannel file or mix them down. The file must be inside `DATA_DIR/media` or
`MAILAB_MEDIA_DIRS`. Typical chain: `audio_file -> biquad -> spectral_nr -> compressor -> audio`, or use
`load_template` (voice_cleanup, broadcast...) with `{path}`.
