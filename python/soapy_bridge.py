"""mailab bridge for SoapySDR receivers (bladeRF, HackRF, RTL-SDR, ...).

Streams an averaged FFT spectrum as trace "<device>_spectrum" plus peak
frequency / power channels. Uncalibrated: levels are dBFS, not dBm.
"""

import argparse
import time

import numpy as np
import SoapySDR
from SoapySDR import SOAPY_SDR_RX, SOAPY_SDR_CF32

import mailab_bridge as lab

parser = argparse.ArgumentParser()
parser.add_argument("--args", default="", help="Soapy device args, e.g. driver=bladerf")
parser.add_argument("--freq", type=float, default=100e6)
parser.add_argument("--rate", type=float, default=10e6)
parser.add_argument("--gain", type=float, default=30)
parser.add_argument("--fft", type=int, default=1024)
parser.add_argument("--average", type=int, default=16, help="FFT frames averaged per update")
parser.add_argument("--fps", type=float, default=5)
opts = parser.parse_args()

cfg = {"freq": opts.freq, "rate": opts.rate, "gain": opts.gain, "fft": opts.fft, "average": opts.average}
sdr = SoapySDR.Device(opts.args)
lab.log("opened %s" % sdr.getHardwareKey())


def apply():
    sdr.setSampleRate(SOAPY_SDR_RX, 0, cfg["rate"])
    sdr.setFrequency(SOAPY_SDR_RX, 0, cfg["freq"])
    sdr.setGain(SOAPY_SDR_RX, 0, cfg["gain"])


apply()
stream = sdr.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
sdr.activateStream(stream)
bridge = lab.Bridge()
lab.status("running")


def read(n):
    buf = np.empty(n, np.complex64)
    got = 0
    while got < n:
        sr = sdr.readStream(stream, [buf[got:]], n - got, timeoutUs=500000)
        if sr.ret <= 0:
            raise RuntimeError("readStream: %d" % sr.ret)
        got += sr.ret
    return buf


def spectrum():
    n = cfg["fft"]
    window = np.hanning(n)
    iq = read(n * cfg["average"]).reshape(cfg["average"], n)
    power = np.mean(np.abs(np.fft.fftshift(np.fft.fft(iq * window, axis=1), axes=1)) ** 2, axis=0)
    db = 10 * np.log10(power / (np.sum(window) ** 2) + 1e-20)
    freqs = cfg["freq"] + np.fft.fftshift(np.fft.fftfreq(n, 1 / cfg["rate"]))
    return freqs, db


def tick():
    freqs, db = spectrum()
    peak = int(np.argmax(db))
    lab.trace("spectrum", freqs.tolist(), [{"label": "dBFS", "y": np.round(db, 2).tolist()}], "Hz", "dBFS")
    lab.sample("peak_freq", float(freqs[peak]), "Hz")
    lab.sample("peak_db", float(db[peak]), "dBFS")


@bridge.command("tune", "{freq, rate, gain, fft, average} any subset")
def tune(args):
    for key in ("freq", "rate", "gain"):
        if key in args:
            cfg[key] = float(args[key])
    for key in ("fft", "average"):
        if key in args:
            cfg[key] = int(args[key])
    apply()
    return cfg


@bridge.command("capture", "{samples, path} save raw cf32 IQ to a file")
def capture(args):
    iq = read(int(args.get("samples", 1 << 20)))
    path = args.get("path", "/tmp/mailab_%d.cf32" % int(time.time()))
    iq.tofile(path)
    return {"path": path, "samples": len(iq), "rate": cfg["rate"], "freq": cfg["freq"]}


bridge.every(1 / opts.fps, tick)
try:
    bridge.run()
finally:
    sdr.deactivateStream(stream)
    sdr.closeStream(stream)
