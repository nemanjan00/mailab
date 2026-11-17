---
group: dsp
summary: "TIE / jitter measurement against an ideal UI grid"
related: [cdr, eye_mask, eye, baud_est, measure]
---

`tie_jitter` measures the time error of the waveform's threshold crossings
against an ideal grid of unit intervals at `bitrate` — the classic TIE
(time error) trace used for jitter analysis (libscopehal's TIE decoder is
the reference concept). Crossing times are interpolated, so sub-sample
resolution is kept. Output: trace `<device>_<id>` (TIE in UI vs edge time),
channels `<device>_<id>_rms` and `<device>_<id>_pp` (UI), plus a value
summary. Feed it a clock or a line code where you know the line rate; pair
with `cdr` when the rate itself drifts.
