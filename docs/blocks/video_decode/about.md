---
group: dsp
summary: "decode analog composite video (PAL/NTSC) into grayscale image frames"
related: [fm_demod, decimate, spectrum, scope]
---

Turns a raw composite video waveform into grayscale image frames. Feed it real
samples of a composite signal — directly, or the FM-discriminated output of an
analog FPV / ATV downlink (`fm_demod` → `video_decode`). Needs at least
2 MS/s of sample rate.

Sync detection is self-adaptive: the slicer threshold sits between the
sync-tip cluster (5th percentile of the waveform) and the blanking level
(12th percentile), both EMA-smoothed across buffers. That survives dark or
low-contrast fields, inverted polarity (`invert`), and a vsync tail flooding
the low end of the small rolling buffer. Short (<6.5 us) low runs are
horizontal syncs (the line period is tracked and low-passed); anything longer
than 20 us is a vertical sync and closes the current field.

Each line's active video is resampled into a `width`-pixel grayscale row; when
a vertical sync closes a field, the last ~576 (PAL) or ~480 (NTSC) rows are
packed into a PNG frame on the lab image stream `<device>_<id>`, suitable for
an image pane or the vision service. Every field also updates a stats value
(`<device>_<id>`: frame counter, detected line length, row count) and a frame
counter channel `<device>_<id>_frames`. Frames are published at most `fps`
times per second (stats still update every field).

A frame drops silently until at least half the expected active lines have been
assembled — give it a couple of field times before expecting pictures.
