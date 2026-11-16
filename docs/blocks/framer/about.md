---
group: digital
summary: "finds a sync word and cuts frames from bits"
related: [bits, slicer, bitview, decode]
---

Finds a `sync` word in a bit stream (allowing `max_errors` bit errors) and cuts the `frame_bytes` that follow it
into frames: the last `keep` frames as a value (number, time, hex, ascii), the payloads as a blob (parse them with a
Kaitai struct) and a frame counter. The receive half of a packet link: `... -> slicer -> framer`, with
`bits {sync, preamble, pattern}` as the transmitter.
