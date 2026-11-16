---
group: sources
summary: "plays a raw cf32 IQ recording in real time"
related: [spectrum, net_source, soapy, shift]
---

Plays a raw complex-float32 (cf32, GNU Radio's "complex" file sink format, `rtl_sdr` converted with `csdr` or
SDR++ baseband recordings saved as raw cf32) IQ recording back in real time at `rate`, looping by default. Use it to
develop a receive chain against a capture instead of live hardware, or to replay a signal you recorded earlier. The
path must be inside `DATA_DIR/media` or a directory in `MAILAB_MEDIA_DIRS` (absolute path), so a graph can't read
arbitrary files. Typical chain: `file -> shift -> lowpass -> resample -> fm_demod -> audio`.
