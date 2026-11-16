---
group: modem
summary: "FSK / FM discriminator, symbols as ±1"
related: [mod, clock_recovery, slicer, eye]
---

FSK / FM discriminator: the phase difference between samples, scaled with the signal's modulation index `h` so
CPFSK symbols come out as ±1 (±1/±3 for 4fsk). By default it averages over one symbol (`integrate`), which removes most
of the inter-symbol interference of Gaussian-filtered GFSK/GMSK. Follow with `clock_recovery` (one sample per symbol)
and `slicer` (`levels` 2 or 4).
