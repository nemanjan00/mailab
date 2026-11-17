"""mailab bridge for the Othernet moRFeus RF generator/mixer (USB HID).

Protocol (from the tai/morfeus library and Othernet forum, no official doc):
16-byte HID reports, big-endian:
  write  [0x00, cmd, param, value(8B for SET)]
  cmd:   0x72 = GET, 0x77 = SET
  param: 0x81 = frequency Hz, 0x82 = mode (0 mixer / 1 generator),
         0x83 = mixer current 0..7, 0x84 = bias-T (0/1)
  read   16 bytes; value in bytes [2:10] big-endian

MAILAB_MORFEUS_FAKE=1 swaps the HID transport for an in-file simulation
(tests; no hardware, no pyusb needed).
Hardware-verified on a moRFeus v1: enumerate, get/set all four params.
"""

import argparse
import enum
import os
import sys
import time
from struct import pack

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mailab_bridge as lab  # noqa: E402

VID = 0x10C4
PID = 0xEAC9
CMD_GET = 0x72
CMD_SET = 0x77

PARAMS = {"freq": 0x81, "mode": 0x82, "current": 0x83, "bias": 0x84}
# 0x85: LCD backlight (0 always on, 1 = 10 s, 2 = 60 s — moRFeusQt, unverified)
# 0x87: frequency override on/off (undocumented; found by scanning 0x80-0x90
# live, settable, survives reads)
PARAM_BACKLIGHT = 0x85
PARAM_OVERRIDE = 0x87
PARAM_NAMES = {v: k for k, v in PARAMS.items()}


class Mode(enum.Enum):
    MIXER = 0
    GENERATOR = 1


class HidTransport:
    """plain /dev/hidraw report I/O — exactly what hidapi does under the
    hood (write the 16-byte report, read the 16-byte reply). No driver
    detaching, no extra dependencies: find the hidraw node by VID:PID."""

    def __init__(self, index=0):
        self.fd = None
        matches = []
        for name in sorted(os.listdir("/sys/class/hidraw")):
            try:
                with open(os.path.join("/sys/class/hidraw", name, "device", "uevent")) as fh:
                    if "0003:%08X:%08X" % (VID, PID) in fh.read():
                        matches.append(os.path.join("/dev", name))
            except (FileNotFoundError, PermissionError):
                continue
        if len(matches) <= index:
            raise Exception("no moRFeus hidraw node found (10c4:eac9); is it connected?")
        self.fd = os.open(matches[index], os.O_RDWR)

    def write_read(self, msg, read_len=16, timeout_ms=2000):
        os.write(self.fd, msg)
        return os.read(self.fd, read_len)

    def close(self):
        if self.fd is not None:
            # leave the LCD on page 1: a final freq read, best-effort
            try:
                self.write_read(pack(">BBB14x", 0x00, CMD_GET, PARAMS["freq"]))
            except Exception:
                pass
            os.close(self.fd)
            self.fd = None


class FakeTransport:
    """test seam: scripted values + a mutation log."""

    def __init__(self):
        self.values = {0x81: 100_000_000, 0x82: 0, 0x83: 1, 0x84: 0, 0x85: 0, 0x87: 0}
        self.log = []

    def write_read(self, msg, read_len=16, timeout_ms=2000):
        cmd = msg[1]
        param = msg[2]
        if cmd == CMD_GET:
            self.log.append(("get", PARAM_NAMES.get(param, param)))
            value = self.values.get(param, 0)
        elif cmd == CMD_SET:
            value = int.from_bytes(msg[3:11], byteorder="big")
            self.log.append(("set", PARAM_NAMES.get(param, param), value))
            self.values[param] = value
        else:
            raise Exception("unknown cmd 0x%02x" % cmd)
        # real replies echo cmd + param: [0x72|0x77, param, value(8B), ...]
        return bytes([cmd, param]) + value.to_bytes(8, byteorder="big") + bytes(6)

    def close(self):
        pass


def get(transport, param):
    # the device can hand back a stale reply (one exchange behind); the
    # reply echoes the param byte (ret[1]), so mismatch = retry
    last = None
    for _attempt in range(3):
        ret = bytes(transport.write_read(pack(">BBB14x", 0x00, CMD_GET, param)))
        last = ret
        if len(ret) >= 10 and ret[1] == param and ret[0] == CMD_GET:
            return int.from_bytes(ret[2:10], byteorder="big")
    raise Exception("no clean reply for param 0x%02x (last: %s)" % (param, last.hex() if last else "none"))


def set_(transport, param, value):
    transport.write_read(pack(">BBBQ6x", 0x00, CMD_SET, param, int(value)))
    return int(value)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", type=int, default=0, help="device index when several are connected")
    args = ap.parse_args()

    if os.environ.get("MAILAB_MORFEUS_FAKE") == "1":
        transport = FakeTransport()
    else:
        transport = HidTransport(args.index)

    bridge = lab.Bridge()

    @bridge.command("info", "current state: frequency, mode, current, bias")
    def info(_a):
        # the LCD jumps to the page of the last parameter touched; read
        # bias/current/mode first and FREQ last so the display stays on
        # page 1 (the official tool behaves the same way)
        bias = bool(get(transport, PARAMS["bias"]))
        current = get(transport, PARAMS["current"])
        raw_mode = get(transport, PARAMS["mode"])
        mode = Mode(raw_mode).name.lower() if raw_mode in [m.value for m in Mode] else "unknown(%d)" % raw_mode
        freq_hz = get(transport, PARAMS["freq"])
        lab.sample("freq", freq_hz / 1e6, unit="MHz")
        return {"freq_hz": freq_hz, "mode": mode, "current": current, "bias": bias}

    @bridge.command("freq", "{hz?} read or set the LO/output frequency in Hz (30M..6G)")
    def freq(a):
        if a.get("hz") is not None:
            hz = lab.parse_number(a["hz"], "hz", 30e6, 6e9)
            set_(transport, PARAMS["freq"], hz)
        hz = get(transport, PARAMS["freq"])
        io_hz = {"freq_hz": hz}
        lab.sample("freq", hz / 1e6, unit="MHz")
        return io_hz

    @bridge.command("mode", "{value?: mixer|generator} read or set the function mode (generator = RF output)")
    def mode(a):
        if a.get("value") is not None:
            name = str(a["value"]).strip().upper()
            if name not in Mode.__members__:
                raise Exception("mode must be mixer or generator")
            set_(transport, PARAMS["mode"], Mode[name].value)
        value = get(transport, PARAMS["mode"])
        return {"mode": Mode(value).name.lower() if value in [m.value for m in Mode] else "unknown(%d)" % value}

    @bridge.command("current", "{level?} read or set the mixer current level 0..7")
    def current(a):
        if a.get("level") is not None:
            level = lab.parse_number(a["level"], "level", 0, 7)
            set_(transport, PARAMS["current"], level)
        level = get(transport, PARAMS["current"])
        lab.sample("current", level)
        return {"current": level}

    @bridge.command("bias", "{on?} read or set the bias-T (5V on the mixer input)")
    def bias(a):
        if a.get("on") is not None:
            set_(transport, PARAMS["bias"], 1 if a["on"] else 0)
        on = bool(get(transport, PARAMS["bias"]))
        lab.sample("bias", 1 if on else 0)
        return {"bias": on}

    @bridge.command("override", "{on?} read or set the frequency override (undocumented param 0x87)")
    def override(a):
        if a.get("on") is not None:
            set_(transport, PARAM_OVERRIDE, 1 if a["on"] else 0)
        on = bool(get(transport, PARAM_OVERRIDE))
        lab.sample("override", 1 if on else 0)
        return {"override": on}

    @bridge.command("lcd", "{timeout?} LCD backlight: 0 always on, 1 = 10 s, 2 = 60 s (unverified)")
    def lcd(a):
        if a.get("timeout") is not None:
            set_(transport, PARAM_BACKLIGHT, lab.parse_number(a["timeout"], "timeout", 0, 2))
        return {"timeout": get(transport, PARAM_BACKLIGHT)}

    @bridge.command("sweep", "{start_hz, stop_hz, step_hz, dwell_ms?} step the frequency, sampling each step")
    def sweep(a):
        start = lab.parse_number(a.get("start_hz"), "start_hz", 30e6, 6e9)
        stop = lab.parse_number(a.get("stop_hz"), "stop_hz", 30e6, 6e9)
        step = lab.parse_number(a.get("step_hz"), "step_hz", 1, 1e9)
        dwell = lab.parse_number(a.get("dwell_ms", 100), "dwell_ms", 10, 60000)
        if stop < start:
            raise Exception("stop_hz must be >= start_hz")
        steps = int((stop - start) / step) + 1
        if steps > 10000:
            raise Exception("sweep has %d steps (> 10000); raise step_hz" % steps)
        hz = start
        done = 0
        while hz <= stop:
            set_(transport, PARAMS["freq"], hz)
            lab.sample("sweep_freq", hz / 1e6, unit="MHz")
            done += 1
            if hz == stop:
                break
            hz = min(hz + step, stop)
            time.sleep(dwell / 1000.0)
        return {"steps": done, "from_hz": start, "to_hz": stop}

    if os.environ.get("MAILAB_MORFEUS_FAKE") == "1":
        @bridge.command("_fake", "test hook: the simulated transport's log + values")
        def fake(_a):
            return {
                "log": [list(e) for e in transport.log],
                "values": {PARAM_NAMES.get(k, k): v for k, v in transport.values.items()},
            }

    bridge.run()


if __name__ == "__main__":
    main()
