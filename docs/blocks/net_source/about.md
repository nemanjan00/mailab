---
group: network
summary: "IQ or logic samples in over TCP / UDP"
related: [net_sink, decode, spectrum, file]
---

Raw samples in over TCP (server or client) or UDP: interleaved IQ as cf32, cs16 or cu8 (GNU Radio's TCP/UDP
sinks, SDR++ network sink, `rtl_sdr -` piped through `nc`), or logic words (u8/u16/u32, packed `bits`) for `decode`.
`rate` tells the graph the stream's sample rate (the network doesn't). Connect a remote SDR, another tool's output or
another mailab graph's `net_sink`.
