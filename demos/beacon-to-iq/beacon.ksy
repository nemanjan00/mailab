meta:
  id: wifi_beacon
  endian: le
seq:
  - id: frame_control
    size: 2
  - id: duration
    type: u2
  - id: addr_dest
    size: 6
  - id: addr_src
    size: 6
  - id: bssid
    size: 6
  - id: seq_ctl
    type: u2
  - id: timestamp
    type: u8
  - id: beacon_interval
    type: u2
  - id: capability
    type: u2
  - id: tags
    type: tag
    repeat: eos
types:
  tag:
    seq:
      - id: number
        type: u1
      - id: len
        type: u1
      - id: body
        size: len
