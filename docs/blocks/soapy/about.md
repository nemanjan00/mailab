---
group: sources
summary: "live IQ from a SoapySDR receiver (RTL-SDR, HackRF, bladeRF...)"
related: [spectrum, file, net_source, fm_demod]
---

Receives complex baseband from any SoapySDR device (RTL-SDR, HackRF, bladeRF, Airspy, LimeSDR, PlutoSDR... as
long as its Soapy module is installed) at center `freq`, sample `rate` and `gain`. `args` selects the device the way
`SoapySDRUtil --find` prints it, e.g. `driver=rtlsdr` or `driver=bladerf,serial=...`. Use it as the front of every
live-radio chain: spectrum and waterfall to find a signal, then `shift`/`lowpass`/`resample` to a channel and a
demodulator. The `sdr_fm_audio` and `sdr_am_audio` templates build complete voice receivers around it. Set the
spectrum's `center` to `freq` so the x axis shows RF frequencies.
