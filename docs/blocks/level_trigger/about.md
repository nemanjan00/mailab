---
group: dsp
summary: "power squelch: catches bursts above a level (blob, trace, log)"
related: [mag, measure, spectrum, framer]
---

Power squelch and burst catcher: while the instantaneous level is above `threshold_db` (dBFS) it passes samples
downstream (`pass`), with `pretrigger_ms` of history before the edge and `hold_ms` after the level drops. Every
finished burst is logged and published: count channel, an event, the raw cf32 IQ as a blob (for later analysis or
replay) and its envelope as a trace. Use it to capture key fobs, sensors and other bursty transmitters, or to keep a
demodulator quiet between transmissions.
