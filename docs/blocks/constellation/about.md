---
group: views
summary: "I/Q scatter of symbols"
related: [symbol_sync, carrier_recovery, demod, eye]
---

I/Q scatter plot of the last `points` samples (the trace pane draws it in constellation mode). Feed it one sample
per symbol (after `symbol_sync` or `clock_recovery`) to judge a receiver: tight clusters mean good SNR, a ring means a
carrier offset (add `carrier_recovery`), smeared clusters mean timing problems. Fed raw samples it shows the pulse
shape's trajectories.
