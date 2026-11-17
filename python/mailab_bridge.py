"""Helper side of the mailab "process" driver protocol (JSON lines on stdio).

Usage:
    bridge = Bridge()

    @bridge.command("set_voltage", "{volts}")
    def set_voltage(args):
        psu.set_voltage(args["volts"])
        return {"ok": True}

    bridge.every(0.25, poll)   # optional periodic task
    bridge.run()

Commands run on the main thread, one at a time, interleaved with periodic
tasks, so device libraries never see concurrent calls.
"""

import json
import os
import queue
import sys
import threading
import time
import traceback

_out_lock = threading.Lock()
# protocol stream; None = sys.stdout (see protect_stdout)
_out = None


_SWITCH = {"on": True, "off": False, "true": True, "false": False}


def parse_switch(value, name="value"):
    """Strict on/off: bool or "on"/"off"/"true"/"false". bool("false") is True,
    so never coerce hardware switches with bool()."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in _SWITCH:
        return _SWITCH[value.strip().lower()]
    raise ValueError('%s must be true/false or "on"/"off", got %r' % (name, value))


def parse_number(value, name="value", lo=None, hi=None, unit=""):
    """Strict number for hardware setpoints: int/float or a numeric string,
    finite, within [lo, hi]. Rejects bools (True would be 1 V)."""
    if isinstance(value, bool) or value is None:
        raise ValueError("%s must be a number, got %r" % (name, value))
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("%s must be a number, got %r" % (name, value)) from None
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError("%s must be finite, got %r" % (name, value))
    if lo is not None and number < lo:
        raise ValueError("%s %g%s is below the minimum %g%s" % (name, number, unit, lo, unit))
    if hi is not None and number > hi:
        raise ValueError("%s %g%s is above the limit %g%s" % (name, number, unit, hi, unit))
    return number


# the lab device this bridge runs as (set by the process driver); lab channels are <device>_<field>
DEVICE_ID = __import__("os").environ.get("MAILAB_DEVICE_ID") or "device"


def channel(field):
    """full lab channel name of one of this bridge's sample fields (for panels)"""
    return "%s_%s" % (DEVICE_ID, field)


def emit(msg):
    with _out_lock:
        out = _out or sys.stdout
        out.write(json.dumps(msg) + "\n")
        out.flush()


def protect_stdout():
    """Keep the protocol on a private copy of stdout and send everything else
    written there (library print()s, C stdio) to stderr, where the lab logs it.
    For bridges around chatty libraries."""
    global _out
    if _out is not None:
        return
    sys.stdout.flush()
    _out = os.fdopen(os.dup(1), "w")
    os.dup2(2, 1)
    sys.stdout = sys.stderr


def sample(field, value, unit=None, t=None):
    emit({"type": "sample", "field": field, "value": value, "unit": unit,
          "t": t if t is not None else time.time() * 1000})


def trace(name, x, series, x_unit="", y_unit="", mode="line"):
    emit({"type": "trace", "name": name, "x": x, "series": series,
          "xUnit": x_unit, "yUnit": y_unit, "mode": mode})


def point(dataset, x, y, cls, info=None, x_label="x", y_label="y"):
    emit({"type": "point", "dataset": dataset, "x": x, "y": y, "class": cls,
          "info": info, "xLabel": x_label, "yLabel": y_label})


def value(name, doc):
    emit({"type": "value", "name": name, "value": doc})


def blob(name, data):
    emit({"type": "blob", "name": name, "data": __import__("base64").b64encode(bytes(data)).decode()})


def image(name, data, mime="image/png"):
    """publish an image as <device>_<name>; data is raw encoded bytes (PNG...)"""
    emit({"type": "image", "name": name, "mime": mime,
          "data": __import__("base64").b64encode(bytes(data)).decode()})


def event(name, data=None):
    """notify subscribers (AI sessions, channel bridge): triggers, detections"""
    emit({"type": "event", "name": name, "data": data or {}})


def panel(name, layout, title=None, w=6, h=6):
    """publish (or update) this device's custom pane; layout from mailab_ui"""
    emit({"type": "panel", "name": name, "title": title, "layout": layout, "w": w, "h": h})


def log(text, level="info"):
    emit({"type": "log", "text": str(text), "level": level})


def status(state, detail=""):
    emit({"type": "status", "state": state, "detail": detail})


class Bridge:
    def __init__(self):
        self._commands = {}
        self._tasks = []
        self._inbox = queue.Queue()
        self.stopping = False
        self.command("help", "list commands")(self._help)

    def command(self, name, doc=""):
        def register(fn):
            self._commands[name] = (fn, doc)
            return fn
        return register

    def every(self, seconds, fn):
        self._tasks.append({"period": seconds, "fn": fn, "due": 0})

    def _help(self, _args):
        return {name: doc for name, (_fn, doc) in self._commands.items()}

    def _reader(self):
        for line in sys.stdin:
            line = line.strip()
            if line:
                self._inbox.put(line)
        self._inbox.put(None)

    def _handle(self, line):
        msg = json.loads(line)
        entry = self._commands.get(msg.get("command"))
        if entry is None:
            emit({"type": "result", "id": msg.get("id"), "error": "unknown command: %s" % msg.get("command")})
            return
        try:
            result = entry[0](msg.get("args") or {})
            emit({"type": "result", "id": msg.get("id"), "result": result})
        except Exception as err:  # report every failure back to the lab
            log(traceback.format_exc(), "error")
            emit({"type": "result", "id": msg.get("id"), "error": str(err)})

    def run(self):
        threading.Thread(target=self._reader, daemon=True).start()
        while not self.stopping:
            now = time.monotonic()
            for task in self._tasks:
                if now >= task["due"]:
                    task["due"] = now + task["period"]
                    try:
                        task["fn"]()
                    except Exception as err:
                        log("periodic task failed: %s" % err, "error")
            try:
                line = self._inbox.get(timeout=0.01)
            except queue.Empty:
                continue
            if line is None:
                break
            self._handle(line)
