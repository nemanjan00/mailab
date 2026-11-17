---
group: dsp
summary: "clock/data recovery (CDR) with a second-order PLL"
related: [tie_jitter, eye_mask, baud_est, clock_recovery]
---

`cdr` tracks the threshold crossings of a clock or line code with a
second-order PLL (proportional `kp` + integral `ki` gain per edge) — the
libscopehal CDCDR / ClockPLL concept. It recovers the actual line rate
near the nominal `bitrate` and measures TIE against the *tracked* clock,
so slow frequency drift does not leak into the jitter number. The period is
clamped to ±5 % of nominal: when the edges can no longer be folded into
that window the PLL declares loss of lock and resyncs rather than running
away. Output: trace `<device>_<id>` (TIE in UI), channels
`<device>_<id>_freq` (Hz) and `<device>_<id>_locked` (0/1), plus a value
summary. Use `tie_jitter` for a rate you trust, `cdr` for a rate that
drifts.
