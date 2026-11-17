---
group: views
summary: "eye diagram with a keep-out mask and hit statistics"
related: [eye, cdr, tie_jitter, matched_filter, scope]
---

`eye_mask` is `eye` plus the mask-compliance test from libscopehal's
EyeMask decoder: it overlays two-symbol segments (at `sps` samples per
symbol, real or imaginary `part`) *and* counts how many overlay samples
fall inside a keep-out polygon. The mask is a polygon `[[x_ui, y], ...]`
with `x` in UI across the two-symbol window (the crossing sits at x = 1)
and `y` in observed amplitude units; the default is the classic hexagon
around the crossing. A signal that never enters the mask has margin —
every hit eats into it. Output: trace `<device>_<id>` (mode eye) and value
`<device>_<id>` with `hits`, `samples` and `pct` inside the mask. Note the
value semantics: `pct` *high* = failing. Pair with `cdr`/`tie_jitter` when
the eye closes from timing rather than noise.
