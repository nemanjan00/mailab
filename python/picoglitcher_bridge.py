"""mailab bridge for the PicoGlitcher, via findus (pip install findus).

Exposes the glitcher primitives plus a generic random-search campaign:
reset target -> arm(delay, length) -> read the target's UART reply ->
classify -> emit a scatter point (delay vs length, coloured by class).

The classification is deliberately generic (expected / no-reply / other);
real targets usually need their own rules, so treat `campaign` as a template.
"""

import argparse
import random
import time

import mailab_bridge as lab
from findus import PicoGlitcher

parser = argparse.ArgumentParser()
parser.add_argument("--port", default="/dev/ttyACM0", help="PicoGlitcher serial port")
parser.add_argument("--target-port", default=None, help="target UART (optional)")
parser.add_argument("--target-baud", type=int, default=115200)
opts = parser.parse_args()

bridge = lab.Bridge()
glitcher = PicoGlitcher()
glitcher.init(port=opts.port)
target = None
if opts.target_port:
    import serial
    target = serial.Serial(opts.target_port, opts.target_baud, timeout=0.1)
lab.log("PicoGlitcher ready on %s" % opts.port)
lab.status("running")
state = {"stop": False}


@bridge.command("trigger", "{mode: rising|falling|tio|uart, pin, pattern, baudrate}")
def trigger(args):
    mode = args.get("mode", "rising")
    pin = args.get("pin", "default")
    if mode == "rising":
        glitcher.rising_edge_trigger(pin_trigger=pin)
    elif mode == "falling":
        glitcher.falling_edge_trigger(pin_trigger=pin)
    elif mode == "tio":
        glitcher.tio_trigger(pin_trigger=pin)
    elif mode == "uart":
        glitcher.uart_trigger(int(args["pattern"]), baudrate=int(args.get("baudrate", 115200)), pin_trigger=pin)
    else:
        raise ValueError("unknown trigger mode: %s" % mode)
    return {"ok": True}


@bridge.command("mode", "{glitch: lp|hp|mux|ext}")
def mode(args):
    kind = args.get("glitch", "hp")
    {"lp": glitcher.set_lpglitch, "hp": glitcher.set_hpglitch,
     "mux": glitcher.set_multiplexing, "ext": glitcher.set_ext_mosfet}[kind]()
    return {"ok": True}


@bridge.command("reset", "{time} pulse target reset")
def reset(args):
    glitcher.reset(float(args.get("time", 0.01)))
    return {"ok": True}


@bridge.command("power_cycle", "{time} power-cycle the target")
def power_cycle(args):
    glitcher.power_cycle_target(float(args.get("time", 0.2)))
    return {"ok": True}


def read_target(timeout):
    if target is None:
        return b""
    deadline = time.monotonic() + timeout
    data = b""
    while time.monotonic() < deadline:
        data += target.read(256)
    return data


def classify(reply, expected):
    if not reply:
        return "no-reply"
    if expected and expected.encode() in reply:
        return "expected"
    return "other"


@bridge.command("glitch", "{delay, length, timeout, expected} one attempt")
def glitch(args):
    delay, length = int(args["delay"]), int(args["length"])
    if target is not None:
        target.reset_input_buffer()
    glitcher.arm(delay, length)
    glitcher.reset(0.01)
    glitcher.block(float(args.get("timeout", 1.0)))
    reply = read_target(float(args.get("timeout", 0.2)))
    cls = classify(reply, args.get("expected"))
    lab.point("glitch", delay, length, cls, reply[:64].hex(), "delay", "length")
    return {"class": cls, "reply": reply[:256].decode("latin1")}


@bridge.command("campaign", "{delay: [min, max], length: [min, max], count, timeout, expected}")
def campaign(args):
    state["stop"] = False
    counts = {}
    for n in range(int(args.get("count", 1000))):
        if state["stop"]:
            break
        attempt = {
            "delay": random.randint(*args["delay"]),
            "length": random.randint(*args["length"]),
            "timeout": args.get("timeout", 0.2),
            "expected": args.get("expected"),
        }
        try:
            cls = glitch(attempt)["class"]
        except Exception as err:  # a glitch can wedge the glitcher; keep going
            cls = "error"
            lab.log("attempt failed: %s" % err, "warn")
        counts[cls] = counts.get(cls, 0) + 1
        lab.sample("attempts", n + 1)
    return counts


bridge.run()
