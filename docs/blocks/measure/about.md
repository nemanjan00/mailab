---
group: views
summary: "one statistic of the stream as a channel"
related: [scope, spectrum, agc, level_trigger]
---

Publishes one statistic of the stream as a channel, `fps` times a second: `power_db` (mean power, dB), `rms`,
`mean`, `peak` or the `last` sample. Channels are what the rest of the lab works with: chart and value panes, math,
safety rules, trends, `channel_read` for the AI. Put one anywhere in a chain as a probe.
