---
group: digital
summary: "stamp sync pulses (level crossings) with sample index + host time to align instruments on one timebase"
related: [scope, measure, baud_est]
---

`sync_mark` watches a stream for level crossings — a sync pulse every instrument sees (a GPIO toggle, a
pulse injected into a scope channel and a flowgraph source at once) — and stamps each one as a mark:
`value <device>_<id>_mark` = `{index, t, rate}`, the global sample index of the edge, the estimated host
time of the edge, and the sample rate. Feed the marks of two instruments to the `timebase_align` MCP tool
to get the sample-grid offset between them (stated tolerance: one flowgraph tick, typically much better
since tick quantisation is common-mode when both edges land in the same tick). The math lives in
`src/utils/timebase` (`offsetSeconds`, `alignIndex`, `driftPpm`).

Real part is used for complex samples. `min_gap_s` throttles re-triggers (set it well below your pulse
period; a pulse train stamps every pulse).
