"""Build mailab custom panes from Python bridges.

    import mailab_bridge as lab
    import mailab_ui as ui

    lab.panel("control", ui.col(
        ui.text("## MP305  ·  {{psu_v}} / {{psu_i}}"),
        ui.row(ui.value("psu_v", "voltage"), ui.value("psu_i", "current")),
        ui.row(ui.number("set V", "set_voltage", "volts", unit="V", channel="psu_v"),
               ui.toggle("output", "output", arg="on")),
        ui.chart(["psu_v", "psu_i"], seconds=60),
    ))

Commands target this device unless `device=` is given. Channel names are the
lab's (<device>_<field>); `{{channel}}` in text shows live values.
"""

import mailab_bridge as lab


def _clean(node):
    """drop unset fields so the UI never sees null keys"""
    return {k: v for k, v in node.items() if v is not None}


def row(*children):
    return {"row": list(children)}


def col(*children):
    return {"col": list(children)}


def text(markdown):
    return {"text": markdown}


def value(channel, label=None, precision=3):
    return _clean({"value": channel, "label": label or channel, "precision": precision})


def chart(channels, seconds=30):
    return _clean({"chart": list(channels) if not isinstance(channels, str) else [channels], "seconds": seconds})


def button(label, command, args=None, device=None):
    return _clean({"button": label, "command": command, "args": args or {}, "device": device})


def toggle(label, command, arg="on", channel=None, args=None, device=None):
    return _clean({"toggle": label, "command": command, "arg": arg, "channel": channel, "args": args or {}, "device": device})


def slider(label, command, arg="value", min=0, max=1, step=None, unit="", value=None, args=None, device=None):
    return _clean({"slider": label, "command": command, "arg": arg, "min": min, "max": max, "step": step,
            "unit": unit, "value": value, "args": args or {}, "device": device})


def number(label, command, arg="value", unit="", channel=None, value=None, args=None, device=None):
    return _clean({"number": label, "command": command, "arg": arg, "unit": unit, "channel": channel,
            "value": value, "args": args or {}, "device": device})


def table(value_name):
    return {"table": value_name}


def image(name):
    return {"image": name}
