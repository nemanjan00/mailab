"""mp305_bridge.py end to end against the simulated MP305 (mp305_fake.py, HID
level, MAILAB_MP305_FAKE=1). Needs pymp305 >= 0.6.3 importable. No hardware:
this proves the bridge drives pymp305 correctly and enforces its limits, not
that a real unit behaves like the fake.

Run directly (python3 python/test_mp305_bridge.py) or via jest
(src/devices/mp305/__tests__/bridge.test.js).
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


class Bridge:
    def __init__(self, *flags):
        env = dict(os.environ, MAILAB_MP305_FAKE="1", MAILAB_DEVICE_ID="psu", PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen([sys.executable, os.path.join(HERE, "mp305_bridge.py"), "--poll", "0.05"] + list(flags),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env, cwd=HERE)
        self.next_id = 1
        self.messages = []

    def call(self, command, args=None):
        msg_id = self.next_id
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"id": msg_id, "command": command, "args": args or {}}) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            assert line, "bridge exited"
            msg = json.loads(line)
            self.messages.append(msg)
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


def test_dc_and_limits():
    b = Bridge("--max-volts", "12", "--max-amps", "2")
    try:
        st = b.ok("state")
        assert st["mode_name"] == "dc" and st["limits"] == {"maxVolts": 12.0, "maxAmps": 2.0}
        st = b.ok("set_output", {"voltage": 9, "current": 0.5, "on": True})
        assert st["output"] == 1 and abs(st["set_voltage"] - 9) < 1e-6 and abs(st["voltage"] - 5.0) < 1e-6  # CC on 10 ohm
        assert st["regulation"] == "CC"
        # limits: rejected before anything is sent
        before = len(b.ok("_fake")["cmds"])
        assert "above the limit" in b.err("set_output", {"voltage": 12.5, "on": True})
        assert "above the limit" in b.err("set_current", {"amps": 3})
        assert "must be true/false" in b.err("set_output", {"voltage": 3, "on": "yes"})
        assert "on is required" in b.err("set_output", {"voltage": 3})
        assert "must be a number" in b.err("set_voltage", {"volts": True})
        fake = b.ok("_fake")
        assert [c for c in fake["cmds"][before:] if c == 0xC8] == []
        assert fake["set_v"] == 9.0
        # ocp + reapply reach the 0xC8 frame
        st = b.ok("set_output", {"current": 0.3, "on": True, "ocp": True, "reapply": True})
        assert st["ocp"] is True and abs(st["set_current"] - 0.3) < 1e-6
        assert b.ok("output_off")["output"] == 0
        assert b.ok("info")["hardware"]["device_name"] == "MP305B"
    finally:
        b.close()


def test_output_on_checks_a_setpoint_left_on_the_device():
    b = Bridge("--max-volts", "4")
    try:
        # the simulated unit powers up with a 5 V setpoint: turning it on must be refused
        assert "setpoint on the device" in b.err("output", {"on": True})
        assert b.ok("_fake")["output"] == 0
    finally:
        b.close()


def test_modes_pd_and_programs():
    b = Bridge("--max-volts", "12")
    try:
        assert "run mode" in b.err("pd_output", {"on": True})
        assert b.ok("mode", {"mode": "pd"})["mode_name"] == "pd"
        assert "in pd mode" in b.err("set_output", {"voltage": 3, "on": True})
        prof = b.ok("pd_profiles")
        assert prof["active"] == 2 and prof["mask"] == 0b111
        assert [round(it["max_v"]) for it in prof["items"][:5]] == [5, 9, 12, 15, 20]
        assert "above the 12 V limit" in b.err("pd_set", {"voltages": [9, 15]})
        assert "not a fixed PDO" in b.err("pd_set", {"voltages": [7]})
        assert b.ok("pd_set", {"voltages": [9]})["mask"] == 0b11
        assert b.ok("pd_output", {"on": True})["output"] == 1
        assert b.ok("_fake")["pd_mask"] == 0b11
        b.ok("pd_output", {"on": False})
        assert "mode must be" in b.err("mode", {"mode": "charge"})

        assert b.ok("program_list") == [{"seq": 1, "name": "Seq", "count": 3}]
        assert b.ok("program_read", {"seq": 1})["steps"] == [{"v": 3.3, "a": 0.5, "s": 2.0}, {"v": 5.0, "a": 1.0, "s": 3.0}]
        assert "above the limit" in b.err("program_write", {"steps": [{"v": 13, "a": 1, "s": 1}]})
        assert "below the minimum" in b.err("program_write", {"steps": [{"v": 3, "a": 1, "s": 0}]})
        assert "at most 20" in b.err("program_write", {"steps": [{"v": 1, "a": 1, "s": 1}] * 21})
        # 20 steps + terminator: a fragmented HID write (> 63 bytes)
        steps = [{"v": 1 + k * 0.5, "a": 0.25, "s": 0.5} for k in range(20)]
        wrote = b.ok("program_write", {"name": "ramp", "steps": steps})
        assert wrote["name"] == "ramp" and wrote["steps"] == steps
        assert b.ok("state")["mode_name"] == "program"
        b.ok("program_write", {"steps": [{"v": 3.3, "a": 0.5, "s": 1}, {"v": 5, "a": 1, "s": 1}]})
        run = b.ok("program_run")
        assert run["output"] == 1 and run["working_index"] >= 1
        assert b.ok("program_state")["running"] is True
        assert b.ok("program_stop")["output"] == 0
        assert b.ok("_fake")["running"] is False
        b.ok("release")
        assert b.ok("state")["mode_name"] == "dc"
    finally:
        b.close()


def test_program_run_rechecks_stored_steps():
    b = Bridge("--max-volts", "4")
    try:
        b.ok("mode", {"mode": "program"})
        # the stored "Seq" program has a 5 V step: above this device's 4 V limit
        assert "above the limit" in b.err("program_run")
        assert b.ok("_fake")["running"] is False
    finally:
        b.close()


def test_telemetry_and_panel():
    b = Bridge()
    try:
        b.ok("set_output", {"voltage": 3.3, "current": 1, "on": True})
        b.ok("state")
        fields = {m["field"] for m in b.messages if m.get("type") == "sample"}
        assert {"v", "i", "p", "temp", "set_v", "set_i", "on", "mode"} <= fields
        panel = next(m for m in b.messages if m.get("type") == "panel")
        text = json.dumps(panel["layout"])
        assert "psu_v" in text and "set_voltage" in text and '"toggle": "output"' in text
    finally:
        b.close()


def test_bad_limits_refuse_to_start():
    env = dict(os.environ, MAILAB_MP305_FAKE="1")
    run = subprocess.run([sys.executable, os.path.join(HERE, "mp305_bridge.py"), "--max-volts", "31"],
                         input="", capture_output=True, text=True, env=env, cwd=HERE, timeout=30)
    assert run.returncode != 0 and "maxVolts" in run.stderr


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok " + name[5:])
