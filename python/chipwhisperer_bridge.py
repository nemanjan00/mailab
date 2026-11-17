"""mailab bridge for the ChipWhisperer Husky capture board (chipwhisperer
python API). Scope control (gain, clock, decimation, IO pins) and power
captures: the ADC trace lands as a lab trace (<id>_wave) and a float32
blob (<id>_wave_raw). MAILAB_CHIPWHISPERER_FAKE=1 swaps the scope for an
in-file simulation (tests; no hardware, no chipwhisperer install needed).
Hardware-untested [HW]: written against the chipwhisperer 6.x API docs.
"""

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mailab_bridge as lab  # noqa: E402


class FakeScope:
    """simulated Husky: records every mutation, returns a synthetic trace."""

    def __init__(self, _sn=None):
        self.log = []
        self.disconnected = False
        self.gain = type("G", (), {"db": 30.0})()
        self.adc = type("A", (), {"samples": 5000, "decimate": 1, "offset": 0,
                                  "clk_freq": 20e6, "presamples": 0})()
        self.clock = type("C", (), {"clkgen_freq": 20e6})()
        self.io = type("IO", (), {"tio1": "serial_rx", "tio2": "serial_tx", "tio3": "high_z",
                                  "tio4": "high_z", "hs2": "clkgen", "pdic": "high", "pdid": "high"})()
        self.trigger = type("T", (), {})()
        self.trigger.pins = "tio4"
        self.fw_version = {"major": 1, "minor": 4, "debug": 0}
        self.snippets = None

    def __setattr__(self, k, v):
        if k == "log" or not hasattr(self, "log"):
            object.__setattr__(self, k, v)
        else:
            self.log.append((k, v))
            object.__setattr__(self, k, v)

    def default_setup(self):
        self.log.append(("default_setup", None))

    def arm(self):
        self.log.append(("arm", None))

    def capture(self, _poll_done=False):
        self.log.append(("capture", None))

    def get_last_trace(self):
        n = int(self.adc.samples)
        t = np.arange(n, dtype=np.float64)
        return np.sin(2 * np.pi * t / 100.0) * 0.4 + np.random.default_rng(7).normal(0, 0.02, n)

    def dis(self):
        self.disconnected = True

    def __str__(self):
        return "ChipWhisperer Husky (fake)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", default=None, help="pick one of several Husky boards")
    ap.add_argument("--samples", type=int, default=5000)
    ap.add_argument("--clk-freq", type=float, default=20e6, help="ADC clock in Hz")
    ap.add_argument("--gain", type=float, default=30.0, help="gain in dB")
    opts = ap.parse_args()
    bridge = lab.Bridge()

    if os.environ.get("MAILAB_CHIPWHISPERER_FAKE") == "1":
        scope = FakeScope(opts.serial)
    else:
        import chipwhisperer as cw
        scope = cw.scope(sn=opts.serial or None)
        scope.default_setup()
    scope.adc.samples = opts.samples
    scope.gain.db = opts.gain
    scope.clock.clkgen_freq = opts.clk_freq

    @bridge.command("info", "board: type, firmware, clock/gain/adc settings")
    def info(_args):
        return {"board": str(scope),
                "fw": getattr(scope, "fw_version", None),
                "clk_freq": scope.clock.clkgen_freq,
                "gain_db": scope.gain.db,
                "samples": scope.adc.samples,
                "decimate": scope.adc.decimate,
                "io": {k: getattr(scope.io, k) for k in ("tio1", "tio2", "tio3", "tio4", "hs2", "pdic", "pdid")
                       if hasattr(scope.io, k)}}

    @bridge.command("capture", "arm + capture the ADC trace -> trace <id>_wave + blob <id>_wave_raw")
    def capture(args):
        n = lab.parse_number(args.get("samples", scope.adc.samples), "samples", 1, 131072)
        scope.adc.samples = int(n)
        scope.arm()
        scope.capture()
        wave = np.asarray(scope.get_last_trace(), dtype=np.float32)
        dt = 1.0 / float(scope.clock.clkgen_freq) * float(scope.adc.decimate or 1)
        lab.trace("wave", [round(i * dt, 12) for i in range(len(wave))],
                  [float(v) for v in wave], x_unit="s", y_unit="V", mode="line")
        lab.blob("wave_raw", wave.astype("<f4").tobytes())
        return {"samples": int(len(wave)), "min": float(wave.min()), "max": float(wave.max()),
                "dt": dt, "blob": lab.DEVICE_ID + "_wave_raw"}

    @bridge.command("gain", "{db?} read or set the frontend gain in dB")
    def gain(args):
        if args.get("db") is not None:
            scope.gain.db = lab.parse_number(args["db"], "db", -12, 60)
        return {"db": float(scope.gain.db)}

    @bridge.command("clock", "{hz?} read or set the CLKGEN frequency in Hz")
    def clock(args):
        if args.get("hz") is not None:
            scope.clock.clkgen_freq = lab.parse_number(args["hz"], "hz", 1e3, 200e6)
        return {"hz": float(scope.clock.clkgen_freq)}

    @bridge.command("decimate", "{n?} read or set the ADC decimation")
    def decimate(args):
        if args.get("n") is not None:
            scope.adc.decimate = int(lab.parse_number(args["n"], "n", 1, 65536))
        return {"n": int(scope.adc.decimate)}

    @bridge.command("io", "{tio1?, tio2?, tio3?, tio4?, hs2?, pdic?, pdid?} target IO pin states")
    def io_cmd(args):
        pins = ("tio1", "tio2", "tio3", "tio4", "hs2", "pdic", "pdid")
        for pin in pins:
            if args.get(pin) is not None and hasattr(scope.io, pin):
                setattr(scope.io, pin, str(args[pin]))
        return {k: getattr(scope.io, k) for k in pins if hasattr(scope.io, k)}

    if os.environ.get("MAILAB_CHIPWHISPERER_FAKE") == "1":
        @bridge.command("_fake", "test hook: the simulated scope's log")
        def fake(_args):
            return {"log": [[k, str(v)] for k, v in scope.log], "disconnected": scope.disconnected}

    try:
        bridge.run()
    finally:
        try:
            scope.dis()
        except Exception:
            pass


if __name__ == "__main__":
    main()
