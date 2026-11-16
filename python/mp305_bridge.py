"""mailab bridge for ISDT MP305A/B bench supplies, via pymp305 (pip install pymp305)."""

import argparse

import mailab_bridge as lab
from pymp305 import MP305

parser = argparse.ArgumentParser()
parser.add_argument("--poll", type=float, default=0.25, help="telemetry period, seconds")
parser.add_argument("--serial", default=None, help="USB serial number (several supplies connected)")
parser.add_argument("--path", default=None, help="hidraw path")
opts = parser.parse_args()

bridge = lab.Bridge()
psu = MP305.open(path=opts.path.encode() if opts.path else None, serial=opts.serial)
lab.log("connected: %s" % (psu.hardware_info(),))
lab.status("running")


def poll():
    st = psu.read_state()
    lab.sample("v", st.voltage, "V")
    lab.sample("i", st.current, "A")
    lab.sample("p", st.power, "W")
    lab.sample("temp", st.temperature, "°C")


@bridge.command("list", "connected MP305 units (path, serial)")
def list_units(_args):
    return [{k: (v.decode() if isinstance(v, bytes) else v) for k, v in d.items()} for d in MP305.list_devices()]


@bridge.command("state", "read full telemetry")
def state(_args):
    st = psu.read_state()
    return {k: v for k, v in vars(st).items() if isinstance(v, (int, float, str, bool))}


@bridge.command("set_output", "{voltage, current, on} volts / amps / bool")
def set_output(args):
    psu.set_output(voltage=float(args["voltage"]), current=float(args["current"]), on=bool(args.get("on", True)))
    return {"ok": True}


@bridge.command("output_off", "turn the output off")
def output_off(_args):
    psu.output_off()
    return {"ok": True}


@bridge.command("release", "give the front panel control back")
def release(_args):
    psu.release_remote()
    return {"ok": True}


bridge.every(opts.poll, poll)
try:
    bridge.run()
finally:
    psu.close()
