"""mailab bridge for ISDT MP305A/B bench supplies, via pymp305 (>= 0.6.3).

Transports: USB-HID (default) or Bluetooth LE (`--transport ble`, needs bleak;
MP305BLE is asyncio, so it runs on its own event-loop thread and every call is
marshalled onto it). MAILAB_MP305_FAKE=1 swaps the HID handle for the
simulated unit in mp305_fake.py (tests; no hardware).

Safety: every setpoint the bridge sends (DC set_output, program steps, the
USB-PD voltages it advertises) is checked against --max-volts / --max-amps,
which default to the MP305's 30 V / 5 A and can only be lowered. Turning an
output on with a setpoint left on the device checks that setpoint too.
Approval for power-on, mode changes, PD and program runs is the lab's policy
(src/safety DEFAULT_POLICY), not this file's.
"""

import argparse
import asyncio
import os
import threading

import mailab_bridge as lab
import mailab_ui as ui
from pymp305 import MP305, MP305Error
from pymp305 import commands as C

HW_MAX_VOLTS = 30.0
HW_MAX_AMPS = 5.0
MIN_STEP_SECONDS = 0.1
MAX_STEP_SECONDS = 86400.0
# one 0xDA frame: 1 + 12 bytes per step (+ terminator) must fit the u8 length byte
MAX_PROGRAM_STEPS = 20
MAX_PROGRAM_SLOT = 10
MODES = {"dc": 0, "program": 1, "pd": 2}
MODE_NAMES = {0: "dc", 1: "program", 2: "pd", 3: "charge"}
PD_FIXED_SLOTS = 5      # PDO items 0..4 are fixed-voltage; 5+ are ranges (APDO/AVS)


# ---- transports -------------------------------------------------------------

class SyncBLE:
    """Blocking facade over pymp305.MP305BLE: a private asyncio loop thread, every
    coroutine method run on it (bleak needs one loop for the client's lifetime)."""

    def __init__(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True, name="mp305-ble")
        self._thread.start()
        self._ble = None

    def run(self, coro, timeout=120):
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(timeout)

    def open(self, address):
        from pymp305 import MP305BLE
        self._ble = self.run(MP305BLE.open(address=address, timeout=20.0))
        return self

    def __getattr__(self, name):
        ble = object.__getattribute__(self, "_ble")
        if ble is None:
            raise AttributeError(name)
        attr = getattr(ble, name)
        if asyncio.iscoroutinefunction(attr):
            return lambda *a, **k: self.run(attr(*a, **k))
        return attr

    def close(self):
        try:
            if self._ble is not None:
                self.run(self._ble.close(), timeout=10)
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)


def open_psu(opts):
    if os.environ.get("MAILAB_MP305_FAKE") == "1":
        import mp305_fake
        lab.log("MAILAB_MP305_FAKE=1: simulated MP305, no hardware", "warn")
        return MP305(mp305_fake.FakeMP305())
    if opts.transport == "ble":
        lab.log("connecting over BLE%s: accept the pairing / remote-control prompt on the MP305 screen"
                % (" to " + opts.address if opts.address else " (scanning)"))
        return SyncBLE().open(opts.address)
    return MP305.open(path=opts.path.encode() if opts.path else None, serial=opts.serial)


# ---- helpers ----------------------------------------------------------------

def limit(value, hardware, name):
    """per-device limit: a number in (0, hardware]; can only be stricter than the MP305"""
    if value is None:
        return hardware
    return lab.parse_number(value, name, lo=0.001, hi=hardware)


def plain(obj):
    """dataclass / dict -> JSON-safe dict (bytes dropped)"""
    src = obj if isinstance(obj, dict) else vars(obj)
    out = {}
    for k, v in src.items():
        if isinstance(v, (bytes, bytearray)):
            continue
        if isinstance(v, (int, float, str, bool)) or v is None:
            out[k] = v
        elif isinstance(v, (list, tuple)):
            out[k] = [plain(x) if hasattr(x, "__dict__") or isinstance(x, dict) else x for x in v]
        elif isinstance(v, dict) or hasattr(v, "__dict__"):
            out[k] = plain(v)
    return out


def optional_switch(args, key):
    return lab.parse_switch(args[key], key) if key in args and args[key] is not None else None


def pdo_voltage(item):
    """highest voltage a PDO item can put on VBUS"""
    return float(item.get("max_voltage_v") or item.get("voltage_v") or (20.0 if item.get("kind") == "SPRAVS" else 0))


class Driver:
    def __init__(self, psu, transport, max_volts, max_amps):
        self.psu = psu
        self.transport = transport
        self.max_volts = max_volts
        self.max_amps = max_amps

    def state(self):
        return self.psu.read_state()

    def require_mode(self, mode):
        st = self.state()
        if st.model != MODES[mode]:
            raise ValueError("the MP305 is in %s mode; run mode {\"mode\": \"%s\"} first"
                             % (MODE_NAMES.get(st.model, st.model), mode))
        return st

    def volts(self, value, name="voltage"):
        return lab.parse_number(value, name, lo=0, hi=self.max_volts, unit=" V")

    def amps(self, value, name="current"):
        return lab.parse_number(value, name, lo=0, hi=self.max_amps, unit=" A")

    # ---- DC ---------------------------------------------------------------
    def set_output(self, voltage=None, current=None, on=None, ocp=None, reapply=False):
        st = self.require_mode("dc")
        v = self.volts(voltage) if voltage is not None else None
        a = self.amps(current) if current is not None else None
        if on or (on is None and st.output):
            # the setpoint that will be live, including one left on the device by the panel
            self.volts(st.set_voltage if v is None else v, "voltage setpoint on the device")
            self.amps(st.set_current if a is None else a, "current setpoint on the device")
        kw = {"voltage": v, "current": a, "on": on}
        if ocp is not None:
            kw["current_over"] = 1 if ocp else 0
        if reapply and self.transport == "usb":
            kw["reapply"] = True
        st = self.psu.set_output(**kw)
        if reapply and self.transport != "usb" and st.output:
            # MP305BLE.set_output has no reapply: cycle the output ourselves
            self.psu.set_output(on=False)
            st = self.psu.set_output(on=True)
        return st

    # ---- USB-PD -------------------------------------------------------------
    def pd_profile(self, pdo_id=None):
        index = self.psu.read_pdo_index()
        p = self.psu.read_pdo(index if pdo_id is None else pdo_id)
        mask = sum(1 << j for j, it in enumerate(p.items) if it.get("type"))
        return index, p, mask

    def check_pd_mask(self, items, mask):
        too_high = [round(pdo_voltage(it), 2) for j, it in enumerate(items)
                    if mask >> j & 1 and pdo_voltage(it) > self.max_volts]
        if too_high:
            raise ValueError("advertised USB-PD voltage(s) %s V above the %g V limit" % (too_high, self.max_volts))

    def pd_apply(self, mask, output, update):
        self.psu.pdo_connect(C.PDOConnect(remote_con=1, src_enable_mask=mask & 0xFFFF,
                                          update=1 if update else 0, output=1 if output else 0))

    # ---- programmable ---------------------------------------------------------
    def program_entries(self):
        return [{"seq": k + 1, "name": e.name, "count": e.num} for k, e in enumerate(self.psu.read_program_list().entries)]

    def program_steps(self, seq):
        entries = self.program_entries()
        entry = next((e for e in entries if e["seq"] == seq), None)
        if entry is None:
            raise ValueError("no program %d (have %s)" % (seq, [e["seq"] for e in entries]))
        steps = [{"v": s["V"], "a": s["A"], "s": s["S"]} for s in self.psu.read_program_steps(seq, entry["count"]).steps]
        while steps and steps[-1]["s"] == 0 and steps[-1]["v"] == 0 and steps[-1]["a"] == 0:
            steps.pop()   # (0, 0, 0) terminator
        return entry, steps

    def check_steps(self, steps):
        if not isinstance(steps, list) or not steps:
            raise ValueError("steps must be a non-empty list of {v, a, s}")
        if len(steps) > MAX_PROGRAM_STEPS:
            raise ValueError("at most %d steps" % MAX_PROGRAM_STEPS)
        out = []
        for k, st in enumerate(steps):
            if not isinstance(st, dict):
                raise ValueError("step %d must be {v, a, s}" % (k + 1))
            out.append({
                "V": self.volts(st.get("v"), "step %d v" % (k + 1)),
                "A": self.amps(st.get("a"), "step %d a" % (k + 1)),
                "S": lab.parse_number(st.get("s"), "step %d s" % (k + 1), lo=MIN_STEP_SECONDS, hi=MAX_STEP_SECONDS, unit=" s"),
            })
        return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--poll", type=float, default=0.25, help="telemetry period, seconds")
    parser.add_argument("--transport", choices=["usb", "ble"], default="usb")
    parser.add_argument("--serial", default=None, help="USB serial number (several supplies connected)")
    parser.add_argument("--path", default=None, help="hidraw path")
    parser.add_argument("--address", default=None, help="BLE address (default: first MP305 found)")
    parser.add_argument("--max-volts", default=None, help="voltage limit, <= 30")
    parser.add_argument("--max-amps", default=None, help="current limit, <= 5")
    parser.add_argument("--panel", default="on", help="publish the control pane (on/off)")
    opts = parser.parse_args()

    max_volts = limit(opts.max_volts, HW_MAX_VOLTS, "maxVolts")
    max_amps = limit(opts.max_amps, HW_MAX_AMPS, "maxAmps")
    bridge = lab.Bridge()
    psu = open_psu(opts)
    drv = Driver(psu, "ble" if opts.transport == "ble" and not os.environ.get("MAILAB_MP305_FAKE") else "usb", max_volts, max_amps)
    info = psu.hardware_info()
    lab.log("connected: %s %s, limits %g V / %g A" % (info.device_name or "MP305", info.app_version, max_volts, max_amps))
    lab.status("running")

    if lab.parse_switch(opts.panel, "panel"):
        ch = lab.channel
        lab.panel("control", ui.col(
            ui.text("**MP305** · {{%s}} · {{%s}} · {{%s}} · mode {{%s|0}} (0 DC, 1 program, 2 USB-PD)"
                    % (ch("v"), ch("i"), ch("p"), ch("mode"))),
            ui.row(ui.value(ch("v"), "V"), ui.value(ch("i"), "A"), ui.value(ch("p"), "W"), ui.value(ch("temp"), "°C", 0)),
            ui.row(ui.number("set V", "set_voltage", "volts", unit="V", channel=ch("set_v")),
                   ui.number("set A", "set_current", "amps", unit="A", channel=ch("set_i")),
                   ui.toggle("output", "output", arg="on", channel=ch("on"))),
            ui.row(ui.button("DC", "mode", {"mode": "dc"}), ui.button("USB-PD", "mode", {"mode": "pd"}),
                   ui.button("program", "mode", {"mode": "program"}), ui.button("panel control", "release")),
            ui.chart([ch("v"), ch("i")], seconds=60),
        ), title="MP305", w=6, h=8)

    def poll():
        st = psu.read_state()
        lab.sample("v", st.voltage, "V")
        lab.sample("i", st.current, "A")
        lab.sample("p", st.power, "W")
        lab.sample("temp", st.temperature, "°C")
        lab.sample("set_v", st.set_voltage, "V")
        lab.sample("set_i", st.set_current, "A")
        lab.sample("on", st.output)
        lab.sample("mode", st.model)
        if st.model == MODES["program"]:
            lab.sample("step", psu.read_program_state().working_index)

    def state_doc(st):
        doc = plain(st)
        doc["mode_name"] = MODE_NAMES.get(st.model, str(st.model))
        doc["regulation"] = "CC" if st.out_state == 2 else "CV"
        doc["ocp"] = bool(st.current_over)
        doc["limits"] = {"maxVolts": max_volts, "maxAmps": max_amps}
        return doc

    @bridge.command("list", "connected units: USB (path, serial) or, with transport ble, a BLE scan")
    def list_units(_args):
        if drv.transport == "ble":
            from pymp305 import MP305BLE
            return [{"address": d.address, "name": d.name} for d in psu.run(MP305BLE.discover())]
        return [{k: (v.decode() if isinstance(v, bytes) else v) for k, v in d.items()} for d in MP305.list_devices()]

    @bridge.command("state", "full telemetry (V/I/P, setpoints, output, mode, regulation CV/CC, OCP, errors) + limits")
    def state(_args):
        return state_doc(psu.read_state())

    @bridge.command("info", "hardware info (model, firmware) and system settings")
    def hw_info(_args):
        out = {"hardware": plain(psu.hardware_info()), "transport": drv.transport}
        try:
            out["settings"] = plain(psu.read_system_settings())
        except MP305Error as err:
            out["settings_error"] = str(err)
        return out

    @bridge.command("set_output", "{voltage?, current?, on (required), ocp?, reapply?} DC mode; V/A <= maxVolts/maxAmps; "
                    "ocp: true = trip (OCP), false = current limit (CC); reapply: cycle the output so a lowered limit engages CC")
    def set_output(args):
        if "on" not in args:
            raise ValueError("on is required (true/false)")
        st = drv.set_output(args.get("voltage"), args.get("current"), lab.parse_switch(args["on"], "on"),
                            optional_switch(args, "ocp"), bool(optional_switch(args, "reapply")))
        return state_doc(st)

    @bridge.command("set_voltage", "{volts} DC setpoint, output state kept")
    def set_voltage(args):
        return state_doc(drv.set_output(voltage=args.get("volts")))

    @bridge.command("set_current", "{amps} DC current limit, output state kept")
    def set_current(args):
        return state_doc(drv.set_output(current=args.get("amps")))

    @bridge.command("output", "{on} DC output on/off with the current setpoints (checked against the limits)")
    def output(args):
        return state_doc(drv.set_output(on=lab.parse_switch(args.get("on"), "on")))

    @bridge.command("output_off", "turn the output off (any mode)")
    def output_off(_args):
        st = psu.read_state()
        if st.model == MODES["pd"]:
            _i, _p, mask = drv.pd_profile()
            drv.pd_apply(mask, False, False)
        elif st.model == MODES["program"]:
            psu.program_connect(C.ProgramConnect(remote_con=1, program_control=2, output=0, model=1))
        else:
            psu.set_output(on=False)
        return state_doc(psu.read_state())

    @bridge.command("release", "give the front panel control back (the unit reverts to DC mode)")
    def release(_args):
        psu.release_remote()
        return {"ok": True}

    @bridge.command("mode", "{mode: dc|pd|program} switch operating mode (output goes off; held while remote is held)")
    def mode(args):
        name = str(args.get("mode", "")).strip().lower()
        if name not in MODES:
            raise ValueError("mode must be one of %s" % ", ".join(MODES))
        psu.set_mode(MODES[name])
        return state_doc(psu.read_state())

    # ---- USB-PD source ----
    @bridge.command("pd_profiles", "{id?} USB-PD source profile (default: the active one): items, advertised mask")
    def pd_profiles(args):
        pdo_id = None if args.get("id") is None else int(lab.parse_number(args["id"], "id", lo=0, hi=255))
        index, p, mask = drv.pd_profile(pdo_id)
        items = [dict(it, index=j, advertised=bool(mask >> j & 1), max_v=pdo_voltage(it)) for j, it in enumerate(p.items)]
        return {"active": index, "id": p.pdo_id, "name": p.name, "power_w": p.power, "mask": mask, "items": items}

    @bridge.command("pd_set", "{mask | voltages: [5, 9, ...]} which items of the active profile are advertised "
                    "(5 V is always on); all <= maxVolts. PD mode; output state kept")
    def pd_set(args):
        st = drv.require_mode("pd")
        _index, p, _old = drv.pd_profile()
        if args.get("voltages") is not None:
            wanted = [lab.parse_number(v, "voltages") for v in args["voltages"]]
            mask = 0
            for v in wanted:
                j = next((j for j, it in enumerate(p.items[:PD_FIXED_SLOTS]) if abs(pdo_voltage(it) - v) < 0.05), None)
                if j is None:
                    raise ValueError("%g V is not a fixed PDO of profile %r (%s)" % (
                        v, p.name, [pdo_voltage(it) for it in p.items[:PD_FIXED_SLOTS]]))
                mask |= 1 << j
        else:
            mask = int(lab.parse_number(args.get("mask"), "mask", lo=0, hi=0xFFFF))
        mask |= 1   # 5 V (item 0) is always advertised
        drv.check_pd_mask(p.items, mask)
        drv.pd_apply(mask, st.output, True)
        return {"mask": mask, "output": bool(st.output)}

    @bridge.command("pd_output", "{on} USB-PD source output; advertised voltages must be <= maxVolts. PD mode")
    def pd_output(args):
        on = lab.parse_switch(args.get("on"), "on")
        drv.require_mode("pd")
        _index, p, mask = drv.pd_profile()
        if on:
            drv.check_pd_mask(p.items, mask)
        drv.pd_apply(mask, on, False)
        return state_doc(psu.read_state())

    # ---- programmable sequences ----
    @bridge.command("program_list", "stored programmable sequences [{seq, name, count}]")
    def program_list(_args):
        return drv.program_entries()

    @bridge.command("program_read", "{seq} steps of a stored sequence [{v, a, s}]")
    def program_read(args):
        seq = int(lab.parse_number(args.get("seq", 1), "seq", lo=1, hi=MAX_PROGRAM_SLOT))
        entry, steps = drv.program_steps(seq)
        return {"seq": seq, "name": entry["name"], "steps": steps}

    @bridge.command("program_write", "{seq?: 1, name?, steps: [{v, a, s}]} overwrite a sequence (switches to program mode); "
                    "v <= maxVolts, a <= maxAmps, s >= 0.1; at most 20 steps. Slot 1 is the hardware-verified one")
    def program_write(args):
        seq = int(lab.parse_number(args.get("seq", 1), "seq", lo=1, hi=MAX_PROGRAM_SLOT))
        steps = drv.check_steps(args.get("steps")) + [{"V": 0, "A": 0, "S": 0}]   # terminator
        name = str(args.get("name") or "mailab")[:16]
        psu.set_mode(MODES["program"])
        psu.program_change(seq, name, len(steps), is_last=1, remove=2)   # 2: step items follow
        psu.write_program(seq, steps)
        entry, written = drv.program_steps(seq)
        return {"seq": seq, "name": entry["name"], "steps": written}

    @bridge.command("program_run", "start the stored sequence (program mode); every stored step is checked against the limits first")
    def program_run(_args):
        drv.require_mode("program")
        for entry in drv.program_entries():
            _e, steps = drv.program_steps(entry["seq"])
            drv.check_steps(steps)
        psu.program_connect(C.ProgramConnect(remote_con=1, program_control=2, output=1, model=1))
        return plain(psu.read_program_state())

    @bridge.command("program_stop", "stop the running sequence (output off)")
    def program_stop(_args):
        drv.require_mode("program")
        psu.program_connect(C.ProgramConnect(remote_con=1, program_control=2, output=0, model=1))
        return plain(psu.read_program_state())

    @bridge.command("program_state", "running sequence: step (1-based), running, V/I")
    def program_state(_args):
        ps = psu.read_program_state()
        doc = plain(ps)
        doc.pop("emark", None)
        doc["running"] = ps.is_stop == 0
        return doc

    @bridge.command("charge_state", "battery-charge telemetry (read-only; charge mode is unverified upstream)")
    def charge_state(_args):
        return plain(psu.read_charge_state())

    if os.environ.get("MAILAB_MP305_FAKE") == "1":
        @bridge.command("_fake", "test hook: the simulated unit's state and the commands it received")
        def fake(_args):
            dev = psu._dev
            return {"set_v": dev.set_v, "set_a": dev.set_a, "output": dev.output, "model": dev.model,
                    "pd_mask": dev.pd_mask, "running": dev.program_running, "remote": dev.remote,
                    "programs": dev.programs, "cmds": [c for c, _p in dev.log]}

    bridge.every(opts.poll, poll)
    try:
        bridge.run()
    finally:
        psu.close()


if __name__ == "__main__":
    main()
