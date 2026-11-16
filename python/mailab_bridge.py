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
import queue
import sys
import threading
import time
import traceback

_out_lock = threading.Lock()


def emit(msg):
    with _out_lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def sample(field, value, unit=None, t=None):
    emit({"type": "sample", "field": field, "value": value, "unit": unit,
          "t": t if t is not None else time.time() * 1000})


def trace(name, x, series, x_unit="", y_unit="", mode="line"):
    emit({"type": "trace", "name": name, "x": x, "series": series,
          "xUnit": x_unit, "yUnit": y_unit, "mode": mode})


def point(dataset, x, y, cls, info=None, x_label="x", y_label="y"):
    emit({"type": "point", "dataset": dataset, "x": x, "y": y, "class": cls,
          "info": info, "xLabel": x_label, "yLabel": y_label})


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
