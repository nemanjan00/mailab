"""mailab bridge for Harogic HTRA spectrum analyzers (SAE/SAM/SAN...), sweep mode.

Uses the vendor libhtraapi through ctypes. The struct layouts below are
transcribed from htra_api.h (SDK v0.55.x); the header and library are vendor
files and are not part of this repo. Point --lib at a libhtraapi.so (e.g. the
one bundled with SAStudio4); /etc/htrausb.conf and the udev rule must be
installed (see the SAStudio setup).
"""

import argparse
import ctypes
import os

import numpy as np

import mailab_bridge as lab

DEFAULT_LIB = os.path.expanduser("~/sastudio/SAStudio4_x86_64_4.4.55.50/lib/libhtraapi.so")

parser = argparse.ArgumentParser()
parser.add_argument("--lib", default=DEFAULT_LIB, help="path to libhtraapi.so")
parser.add_argument("--index", type=int, default=0, help="device number when several are connected")
parser.add_argument("--start", type=float, default=88e6)
parser.add_argument("--stop", type=float, default=108e6)
parser.add_argument("--rbw", type=float, default=30e3)
parser.add_argument("--ref-level", type=float, default=0.0)
parser.add_argument("--interval", type=float, default=0.0, help="seconds between sweeps")
opts = parser.parse_args()

E = ctypes.c_int  # C enums are int-sized


class BootProfile(ctypes.Structure):
    _fields_ = [("PhysicalInterface", E), ("DevicePowerSupply", E), ("ETH_IPVersion", E),
                ("ETH_IPAddress", ctypes.c_uint8 * 16), ("ETH_RemotePort", ctypes.c_uint16),
                ("ETH_ErrorCode", ctypes.c_int32), ("ETH_ReadTimeOut", ctypes.c_int32)]


class DeviceInfo(ctypes.Structure):
    _fields_ = [("DeviceUID", ctypes.c_uint64), ("Model", ctypes.c_uint16), ("HardwareVersion", ctypes.c_uint16),
                ("MFWVersion", ctypes.c_uint32), ("FFWVersion", ctypes.c_uint32)]


class BootInfo(ctypes.Structure):
    _fields_ = [("DeviceInfo", DeviceInfo), ("BusSpeed", ctypes.c_uint32), ("BusVersion", ctypes.c_uint32),
                ("APIVersion", ctypes.c_uint32), ("ErrorCodes", ctypes.c_int * 7), ("Errors", ctypes.c_int),
                ("WarningCodes", ctypes.c_int * 7), ("Warnings", ctypes.c_int)]


class MeasAuxInfo(ctypes.Structure):
    _fields_ = [("MaxIndex", ctypes.c_uint32), ("MaxPower_dBm", ctypes.c_float), ("Temperature", ctypes.c_int16),
                ("RFState", ctypes.c_uint16), ("BBState", ctypes.c_uint16), ("GainPattern", ctypes.c_uint16),
                ("ConvertPattern", ctypes.c_uint32), ("SysTimeStamp", ctypes.c_double),
                ("AbsoluteTimeStamp", ctypes.c_double), ("Latitude", ctypes.c_float), ("Longitude", ctypes.c_float)]


class SwpProfile(ctypes.Structure):
    _fields_ = [("StartFreq_Hz", ctypes.c_double), ("StopFreq_Hz", ctypes.c_double), ("CenterFreq_Hz", ctypes.c_double),
                ("Span_Hz", ctypes.c_double), ("RefLevel_dBm", ctypes.c_double), ("RBW_Hz", ctypes.c_double),
                ("VBW_Hz", ctypes.c_double), ("SweepTime", ctypes.c_double), ("TraceBinSize_Hz", ctypes.c_double),
                ("FreqAssignment", E), ("Window", E), ("RBWMode", E), ("VBWMode", E), ("SweepTimeMode", E),
                ("Detector", E), ("TraceFormat", E), ("TraceDetectMode", E), ("TraceDetector", E),
                ("TracePoints", ctypes.c_uint32), ("TracePointsStrategy", E), ("TraceAlign", E),
                ("FFTExecutionStrategy", E), ("RxPort", E), ("SpurRejection", E), ("ReferenceClockSource", E),
                ("ReferenceClockFrequency", ctypes.c_double), ("EnableReferenceClockOut", ctypes.c_uint8),
                ("SystemClockSource", E), ("ExternalSystemClockFrequency", ctypes.c_double),
                ("TriggerSource", E), ("TriggerEdge", E), ("TriggerOutMode", E), ("TriggerOutPulsePolarity", E),
                ("PowerBalance", ctypes.c_uint32), ("GainStrategy", E), ("Preamplifier", E),
                ("AnalogIFBWGrade", ctypes.c_uint8), ("IFGainGrade", ctypes.c_uint8), ("EnableDebugMode", ctypes.c_uint8),
                ("CalibrationSettings", ctypes.c_uint8), ("Atten", ctypes.c_int8), ("TraceType", E), ("LOOptimization", E)]


class SwpTraceInfo(ctypes.Structure):
    _fields_ = [("FullsweepTracePoints", ctypes.c_int), ("PartialsweepTracePoints", ctypes.c_int), ("TotalHops", ctypes.c_int),
                ("UserStartIndex", ctypes.c_uint32), ("UserStopIndex", ctypes.c_uint32), ("TraceBinBW_Hz", ctypes.c_double),
                ("StartFreq_Hz", ctypes.c_double), ("AnalysisBW_Hz", ctypes.c_double), ("TraceDetectRatio", ctypes.c_int),
                ("DecimateFactor", ctypes.c_int), ("FrameTimeMultiple", ctypes.c_float), ("FrameTime", ctypes.c_double),
                ("EstimateMinSweepTime", ctypes.c_double), ("DataFormat", E), ("SamplePoints", ctypes.c_uint64),
                ("GainParameter", ctypes.c_uint32), ("DSPPlatform", E)]


api = ctypes.CDLL(opts.lib)
P = ctypes.POINTER
api.Device_Open.argtypes = [P(ctypes.c_void_p), ctypes.c_int, P(BootProfile), P(BootInfo)]
api.Device_Close.argtypes = [P(ctypes.c_void_p)]
api.SWP_ProfileDeInit.argtypes = [P(ctypes.c_void_p), P(SwpProfile)]
api.SWP_Configuration.argtypes = [P(ctypes.c_void_p), P(SwpProfile), P(SwpProfile), P(SwpTraceInfo)]
api.SWP_GetFullSweep.argtypes = [P(ctypes.c_void_p), P(ctypes.c_double), P(ctypes.c_float), P(MeasAuxInfo)]

device = ctypes.c_void_p()
boot = BootProfile()  # zeroed: USB interface, USB data+power port supply
info = BootInfo()
status = api.Device_Open(ctypes.byref(device), opts.index, ctypes.byref(boot), ctypes.byref(info))
if status < 0:
    raise SystemExit("Device_Open failed: %d (udev rule, /etc/htrausb.conf, device busy in SAStudio?)" % status)
dev_info = {"uid": "%016x" % info.DeviceInfo.DeviceUID, "model": info.DeviceInfo.Model,
            "hardware": info.DeviceInfo.HardwareVersion, "mcu_fw": info.DeviceInfo.MFWVersion,
            "fpga_fw": info.DeviceInfo.FFWVersion, "api": info.APIVersion, "boot_status": status}
lab.log("opened HTRA %s" % dev_info)

state = {"running": True, "profile": None, "trace": None, "freq": None, "power": None}
settings = {"start": opts.start, "stop": opts.stop, "rbw": opts.rbw, "ref_level": opts.ref_level}


def configure():
    profile = SwpProfile()
    api.SWP_ProfileDeInit(ctypes.byref(device), ctypes.byref(profile))
    profile.FreqAssignment = 0  # StartStop
    profile.StartFreq_Hz = settings["start"]
    profile.StopFreq_Hz = settings["stop"]
    profile.RBW_Hz = settings["rbw"]
    profile.RefLevel_dBm = settings["ref_level"]
    out = SwpProfile()
    trace = SwpTraceInfo()
    code = api.SWP_Configuration(ctypes.byref(device), ctypes.byref(profile), ctypes.byref(out), ctypes.byref(trace))
    if code < 0:
        raise RuntimeError("SWP_Configuration failed: %d" % code)
    n = trace.FullsweepTracePoints
    state.update(profile=out, trace=trace, freq=(ctypes.c_double * n)(), power=(ctypes.c_float * n)())
    return {"points": n, "rbw": out.RBW_Hz, "start": out.StartFreq_Hz, "stop": out.StopFreq_Hz,
            "sweep_time_min": trace.EstimateMinSweepTime, "code": code}


def sweep():
    aux = MeasAuxInfo()
    code = api.SWP_GetFullSweep(ctypes.byref(device), state["freq"], state["power"], ctypes.byref(aux))
    if code < 0:
        raise RuntimeError("SWP_GetFullSweep failed: %d" % code)
    n = state["trace"].FullsweepTracePoints
    freq = np.ctypeslib.as_array(state["freq"])[:n]
    power = np.ctypeslib.as_array(state["power"])[:n]
    lab.trace("spectrum", freq.tolist(), [{"label": "dBm", "y": np.round(power, 2).tolist()}], "Hz", "dBm")
    peak = int(np.argmax(power))
    lab.sample("peak_freq", float(freq[peak]), "Hz")
    lab.sample("peak_dbm", float(power[peak]), "dBm")
    lab.sample("temp", aux.Temperature * 0.01, "°C")
    return {"points": n, "peak_hz": float(freq[peak]), "peak_dbm": float(power[peak]), "code": code}


bridge = lab.Bridge()


@bridge.command("info", "device identity")
def cmd_info(_args):
    return dev_info


@bridge.command("configure", "{start, stop, rbw, ref_level} Hz / Hz / Hz / dBm")
def cmd_configure(args):
    for key in ("start", "stop", "rbw", "ref_level"):
        if key in args:
            settings[key] = float(args[key])
    return configure()


@bridge.command("sweep", "one sweep now")
def cmd_sweep(_args):
    return sweep()


@bridge.command("continuous", "{on}")
def cmd_continuous(args):
    state["running"] = lab.parse_switch(args["on"], "on")
    return {"running": state["running"]}


def tick():
    if state["running"]:
        sweep()


lab.log("configured: %s" % configure())
lab.status("running")
bridge.every(max(opts.interval, 0.01), tick)
try:
    bridge.run()
finally:
    api.Device_Close(ctypes.byref(device))
