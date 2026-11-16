---
group: modem
summary: "Gardner timing recovery for FSK / OOK / real symbols"
related: [discriminator, slicer, mag, matched_filter]
---

Gardner timing recovery for real or complex input: takes `sps` samples per symbol and outputs one sample per
symbol at the eye's center. It is the timing loop for FSK after `discriminator` and for OOK/ASK after `mag`
(with `dc_block` on), and it also works after a `matched_filter` on linear schemes. Follow with `slicer`.
