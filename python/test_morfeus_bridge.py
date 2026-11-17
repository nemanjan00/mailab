"""morfeus_bridge.py end to end against the simulated device
(MAILAB_MORFEUS_FAKE=1). No hardware, no pyusb needed.

Run directly (python3 python/test_morfeus_bridge.py) or via jest
(src/devices/morfeus/__tests__/bridge.test.js).
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


class Bridge:
    def __init__(self, *flags):
        env = dict(os.environ, MAILAB_MORFEUS_FAKE="1", MAILAB_DEVICE_ID="mrf", PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen([sys.executable, os.path.join(HERE, "morfeus_bridge.py")] + list(flags),
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


def test_state_roundtrip_and_sweep():
    b = Bridge()
    try:
        info = b.ok("info")
        assert info == {"freq_hz": 100000000, "mode": "mixer", "current": 1, "bias": False}

        assert b.ok("freq", {"hz": 433900000}) == {"freq_hz": 433900000}
        assert b.ok("mode", {"value": "generator"}) == {"mode": "generator"}
        assert b.ok("current", {"level": 4}) == {"current": 4}
        assert b.ok("bias", {"on": True}) == {"bias": True}
        assert b.ok("info") == {"freq_hz": 433900000, "mode": "generator", "current": 4, "bias": True}

        # reads without args
        assert b.ok("freq") == {"freq_hz": 433900000}
        assert b.ok("mode") == {"mode": "generator"}

        sweep = b.ok("sweep", {"start_hz": 100e6, "stop_hz": 103e6, "step_hz": 1e6, "dwell_ms": 10})
        assert sweep == {"steps": 4, "from_hz": 100e6, "to_hz": 103e6}

        # the transport saw the writes
        fake = b.ok("_fake")
        sets = [e for e in fake["log"] if e[0] == "set"]
        assert ["set", "freq", 433900000] in sets
        assert ["set", "mode", 1] in sets
        assert fake["values"]["freq"] == 103000000  # sweep ends on the stop frequency

        # validation
        assert "30M" in b.err("freq", {"hz": 1e6}) or "below" in b.err("freq", {"hz": 1e6})
        assert "mixer or generator" in b.err("mode", {"value": "warp"})
        assert "0..7" in b.err("current", {"level": 9}) or "limit" in b.err("current", {"level": 9})
        assert ">=" in b.err("sweep", {"start_hz": 200e6, "stop_hz": 100e6, "step_hz": 1e6})
    finally:
        b.close()


if __name__ == "__main__":
    test_state_roundtrip_and_sweep()
    print("ok morfeus bridge")
