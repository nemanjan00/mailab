---
group: digital
summary: "PRBS or pattern bit source, optionally framed"
related: [mod, ber, framer, bitview]
---

A bit source at `bitrate`: a PRBS (prbs7, 9, 15, 23, 31: what `ber` checks against), or a repeated pattern given
as `hex:...`, `text:...` or `bits:...`, optionally sent behind a `preamble` and `sync` word (framed mode, for `framer`).
It is the start of every digital link test: `bits -> mod -> channel -> ... -> slicer -> ber`.
