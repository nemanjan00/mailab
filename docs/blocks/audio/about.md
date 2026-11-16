---
group: views
summary: "plays audio in the browser (lab audio stream)"
related: [audio_file, fm_demod, limiter, wav]
---

Plays real samples in the browser: the block publishes an audio stream `<device>_<id>` (int16 PCM, resampled to
`rate`), which an `audio` pane plays (press listen; browsers need a click before audio). Other graphs can take the
stream with `audio_in`. The end of every receiver and audio processing chain.
