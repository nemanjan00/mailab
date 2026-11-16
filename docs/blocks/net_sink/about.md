---
group: network
summary: "IQ or logic samples out over TCP / UDP"
related: [net_source, soapy, file]
---

Sends the stream out over TCP (server: one client at a time; client) or UDP as raw interleaved cf32, cs16 or
cu8 IQ, or logic words. Feed GNU Radio, SDR++, inspectrum/`nc > file` recorders, a transmitter on another machine, or
another mailab graph's `net_source`. UDP datagrams are 8 KB; a TCP peer that disconnects is dropped and re-accepted.
