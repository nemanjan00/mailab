---
group: views
summary: "eye diagram"
related: [matched_filter, clock_recovery, discriminator, scope]
---

Eye diagram: overlays `traces` two-symbol-long segments of the input (at `sps` samples per symbol), real or
imaginary `part`. The vertical opening shows noise margin, the horizontal opening timing margin; a closed eye means
inter-symbol interference (missing matched filter) or too much noise. Look at it after `matched_filter` (linear
schemes) or `discriminator` (FSK), before timing recovery.
