"""chipwhisperer_bridge.py end to end against the simulated Husky
(MAILAB_CHIPWHISPERER_FAKE=1). No hardware: proves the bridge drives the
chipwhisperer API surface correctly (and enforces argument checks), not that
a real Husky behaves like the fake.

Run directly (python3 python/test_chipwhisperer_bridge.py) or via jest
(src/devices/chipwhisperer/__tests__/bridge.test.js).
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


class Bridge:
    def __init__(self, *flags):
        env = dict(os.environ, MAILAB_CHIPWHISPERER_FAKE="1", MAILAB_DEVICE_ID="cw1", PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen([sys.executable, os.path.join(HERE, "chipwhisperer_bridge.py")] + list(flags),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env, cwd=HERE)
        self.next_id = 1

    def call(self, command, args=None):
        msg_id = self.next_id
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"id": msg_id, "command": command, "args": args or {}}) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            assert line, "bridge exited"
            msg = json.loads(line)
            if msg.get("type") == "result" and msg.get("id") == msg_id:
                return msg

    def ok(self, command, args=None):
        msg = self.call(command, args)
        assert "error" not in msg, msg
        return msg["result"]

    def err(self, command, args=None):
        msg = self.call(command, args)
        assert "error" in msg, msg
        return msg["error"]

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(10)


def test_info_capture_and_options():
    b = Bridge()
    try:
        info = b.ok("info")
        assert "Husky" in info["board"] and info["fw"]["major"] == 1
        assert info["gain_db"] == 30.0 and info["samples"] == 5000 and info["decimate"] == 1
        assert info["clk_freq"] == 20e6 and info["io"]["tio1"] == "serial_rx"

        # capture: the fake trace is a +/-0.4 sine, dt = 1/clkgen
        cap = b.ok("capture", {"samples": 64})
        assert cap["samples"] == 64 and cap["blob"] == "cw1_wave_raw"
        assert cap["min"] < 0 < cap["max"]
        assert cap["max"] > 0.3 and cap["min"] < -0.15  # 64 samples ~ 2/3 period
        assert abs(cap["dt"] - 5e-8) < 1e-15

        # options chain through and read back
        assert b.ok("gain", {"db": 45})["db"] == 45.0
        assert b.ok("decimate", {"n": 10})["n"] == 10
        assert b.ok("clock", {"hz": 10e6})["hz"] == 10e6
        assert b.ok("io", {"tio1": "gpio_low", "pdic": "low"})["tio1"] == "gpio_low"
        info = b.ok("info")
        assert info["gain_db"] == 45.0 and info["decimate"] == 10 and info["clk_freq"] == 10e6
        assert info["io"]["pdic"] == "low"

        # the capture path really ran arm+capture on the scope
        log = b.ok("_fake")["log"]
        assert ["arm", "None"] in log and ["capture", "None"] in log  # the hook stringifies values

        # argument validation
        assert "above the limit" in b.err("gain", {"db": 90})
        assert "below the minimum" in b.err("gain", {"db": -20})
        assert "below the minimum" in b.err("decimate", {"n": 0})
        assert "must be a number" in b.err("clock", {"hz": "fast"})
        assert "below the minimum" in b.err("capture", {"samples": 0})
    finally:
        b.close()


if __name__ == "__main__":
    test_info_capture_and_options()
    print("ok chipwhisperer bridge")
