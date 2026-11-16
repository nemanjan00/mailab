"""A simulated ISDT MP305 at the USB-HID level, for testing mp305_bridge.py
without hardware (MAILAB_MP305_FAKE=1).

It answers the HID reports pymp305 writes with frames built by pymp305's own
protocol module, so the whole stack above the hidapi handle (framing,
fragmentation, remote handshake, mode switching, parsers) runs for real.
Behaviour follows pymp305's tests and PROTOCOL.md, NOT a captured device: a
passing test proves the bridge drives pymp305 correctly, not that the MP305
reacts the same way.
"""

import struct
import time

from pymp305 import commands as C
from pymp305 import protocol as P

LOAD_OHMS = 10.0

# active USB-PD profile: 5 fixed PDOs (5/9/12/15/20 V) + an APDO, first three advertised
PD_ITEMS = [
    {"type": 1, "voltage_v": 5.0, "current_a": 3.0},
    {"type": 1, "voltage_v": 9.0, "current_a": 3.0},
    {"type": 1, "voltage_v": 12.0, "current_a": 3.0},
    {"type": 0, "voltage_v": 15.0, "current_a": 3.0},
    {"type": 0, "voltage_v": 20.0, "current_a": 3.0},
    {"type": 0, "max_current_a": 3.0, "max_voltage_v": 21.0, "min_voltage_v": 3.3},
]


def _name16(name):
    return name.encode("ascii", "replace")[:16].ljust(16, b"\x00")


class FakeMP305:
    """hidapi `device`-like object: write() takes reports, read() returns answers."""

    def __init__(self):
        self.set_v = 5.0
        self.set_a = 1.0
        self.output = 0
        self.model = 0
        self.current_over = 0
        self.remote = False
        self.pd_index = 2
        self.pd_mask = 0b111
        self.programs = [{"name": "Seq", "steps": [(3.3, 0.5, 2.0), (5.0, 1.0, 3.0)]}]
        self.program_running = False
        self.program_t0 = 0.0
        self.log = []           # (cmd, payload) of every complete frame received
        self._replies = []
        self._partial = None    # fragmented frame being reassembled

    # ---- hidapi surface ---------------------------------------------------
    def write(self, report):
        data = bytes(report)
        if len(data) < P.REPORT_SIZE + 1 or self._partial is not None:
            self._fragment(data)
        else:
            self._frame(P.parse_report(data))
        return len(data)

    def read(self, _n, timeout_ms=0):
        if self._replies:
            return list(self._replies.pop(0))
        time.sleep(min(timeout_ms, 20) / 1000.0)   # nothing to say (e.g. 0xBD is never answered)
        return []

    def set_nonblocking(self, _v):
        pass

    def close(self):
        pass

    # ---- reassembly of WebLink-style unpadded fragments --------------------
    def _fragment(self, data):
        chunk = data[2:2 + data[1]]
        self._partial = chunk if self._partial is None else self._partial + chunk
        # length byte 0: parse_report then keeps every byte (long frames overflow the u8 anyway)
        frame = P.parse_report(bytes([0]) + self._partial)
        if frame is not None and len(frame.values) >= 5 + frame.values[3]:
            self._partial = None
            self._frame(frame)

    def _reply(self, cmd, payload=b""):
        self._replies.append(bytes([P.REPORT_ID]) + P.build_frame(cmd, payload))

    # ---- device model -------------------------------------------------------
    def _active_step(self):
        steps = self.programs[0]["steps"] if self.programs else []
        if not self.program_running or not steps:
            return 0, None
        elapsed = time.monotonic() - self.program_t0
        total = sum(s for _v, _a, s in steps)
        t = elapsed % total if total else 0
        for k, (v, a, s) in enumerate(steps):
            if t < s:
                return k + 1, (v, a)
            t -= s
        return len(steps), steps[-1][:2]

    def measure(self):
        if self.model == 1:
            _k, step = self._active_step()
            if step is None:
                return 0.0, 0.0
            sv, sa = step
        elif self.model == 2:
            sv = max([it["voltage_v"] for j, it in enumerate(PD_ITEMS[:5]) if self.pd_mask >> j & 1] or [5.0])
            sa = 3.0
        else:
            sv, sa = self.set_v, self.set_a
        if not self.output:
            return 0.0, 0.0
        v = min(sv, sa * LOAD_OHMS)
        return v, v / LOAD_OHMS

    def _state(self):
        v, i = self.measure()
        out_state = 2 if self.output and v < self.set_v else 1
        return (bytes([out_state, 0, 0])
                + struct.pack("<HHHH", int(round(v * 100)), int(round(self.set_v * 100)),
                              int(round(i * 1000)), int(round(self.set_a * 1000)))
                + struct.pack("<II", 10, 0) + struct.pack("<H", int(round(v * i * 100)))
                + bytes([self.current_over, 3, 0, self.output, self.model, 0, 0, 31]))

    def _connect(self, payload, apply):
        """shared remote handshake of every mode's connect command (0xC8/0xE2/0xE8/0xEE)"""
        remote_con, model = payload[0], payload[-1] if payload else 0
        if remote_con == 2:
            self.remote = True
            return 0
        if remote_con == 0:
            self.remote = False
            self.model = 0
            self.output = 0
            return 0
        if not self.remote:
            return 1
        if model != self.model:   # a connect naming another mode switches to it, output off
            self.model = model
            self.output = 0
            self.program_running = False
            return 0
        apply()
        return 0

    def _frame(self, f):
        if f is None:
            return
        cmd, pl = f.cmd, f.payload
        self.log.append((cmd, bytes(pl)))
        if cmd == P.CMD_STATE_INFO:
            self._reply(P.RESP_STATE, self._state())
        elif cmd == P.CMD_HW_INFO:
            self._reply(P.RESP_HW_INFO, bytes(range(8)) + bytes([1, 0, 0, 0, 1, 0, 0, 2, 1, 6, 0, 48]) + b"MP305B".ljust(10, b"\x00"))
        elif cmd == P.CMD_SYS_GET:
            self._reply(P.RESP_SYS, struct.pack("<BBBBBHH", 90, 3, 0, 0, 0, 0, self.current_over))
        elif cmd == P.CMD_CONTROL:
            rc, sv, sa, _rch, _vs, co, out, model, _ref = struct.unpack("<BHHBBBBBB", pl[:11])

            def apply():
                self.set_v, self.set_a, self.current_over, self.output = sv / 100.0, sa / 1000.0, co, out
            self._reply(P.RESP_CONTROL, bytes([self._connect(bytes([rc, model]), apply)]))
        elif cmd == 0xE8:
            rc, mask, update, out, model = struct.unpack("<BHBBB", pl[:6])

            def apply():
                if update:
                    self.pd_mask = mask
                self.output = out
            self._reply(P.RESP_PDO_CONNECT, bytes([self._connect(bytes([rc, model]), apply)]))
        elif cmd == 0xE2:
            rc, control, out, model = pl[0], pl[1], pl[2], pl[3]

            def apply():
                self.output = out
                self.program_running = bool(out) and control == 2
                self.program_t0 = time.monotonic()
            self._reply(P.RESP_PROGRAM_CONNECT, bytes([self._connect(bytes([rc, model]), apply)]))
        elif cmd == 0xE4:
            self._reply(0xE5, bytes([self.pd_index]))
        elif cmd == 0xD0:
            items = [dict(it, type=self.pd_mask >> j & 1) for j, it in enumerate(PD_ITEMS)]
            body = bytes([pl[0]]) + _name16("PD 60W") + bytes([60, len(items)])
            body += b"".join(struct.pack("<I", C._pack_pdo_item(j, it)) for j, it in enumerate(items))
            self._reply(P.RESP_PDO, body)
        elif cmd == 0xD4:
            body = bytes([len(self.programs)])
            body += b"".join(_name16(p["name"]) + bytes([len(p["steps"]) + 1]) for p in self.programs)
            self._reply(P.RESP_PROGRAM_LIST, body)
        elif cmd == 0xD8:
            seq = pl[0]
            steps = [{"V": v, "A": a, "S": s} for v, a, s in self.programs[seq - 1]["steps"]] + [{"V": 0, "A": 0, "S": 0}]
            self._reply(P.RESP_PROGRAM_STEPS, C.programmable_write(seq, steps)[1])
        elif cmd == 0xD6:
            seq, name = pl[0], pl[1:17].split(b"\x00")[0].decode("ascii", "replace")
            while len(self.programs) < seq:
                self.programs.append({"name": "", "steps": []})
            self.programs[seq - 1]["name"] = name
            self._reply(P.RESP_PROGRAM_CHANGE, b"\x00")
        elif cmd == 0xDA:
            seq, body = pl[0], pl[1:]
            raw = [struct.unpack("<iii", body[k:k + 12]) for k in range(0, len(body), 12)]
            steps = [(v / 1000.0, a / 1000.0, t / 10.0) for v, a, t in raw if t]
            while len(self.programs) < seq:
                self.programs.append({"name": "", "steps": []})
            self.programs[seq - 1]["steps"] = steps
            self._reply(P.RESP_PROGRAM_WRITE, b"\x00")
        elif cmd == 0xDE:
            k, _step = self._active_step()
            v, i = self.measure()
            body = (bytes([1, 0, 0]) + struct.pack("<HH", int(round(v * 100)), int(round(i * 1000)))
                    + struct.pack("<IIH", 0, 0, 0) + bytes([k, self.output, self.model, 31, 0 if self.program_running else 1])
                    + struct.pack("<I", 0))
            self._reply(P.RESP_PROGRAM_STATE, body)
        elif cmd == P.CMD_CHARGE_INFO:
            self._reply(P.RESP_CHARGE, bytes(30))
        # anything else (0xBD realtime, unknown) is never answered, like the real unit
