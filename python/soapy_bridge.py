"""mailab bridge for SoapySDR receivers (bladeRF, HackRF, RTL-SDR, ...).

Streams an averaged FFT spectrum as trace "<device>_spectrum" plus peak
frequency / power channels. Uncalibrated: levels are dBFS, not dBm.
"""

import argparse
import threading
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


# one reader at a time: the spectrum tick, capture and demod share the
# single RX stream
streamLock = threading.Lock()


def read(n):
    buf = np.empty(n, np.complex64)
    got = 0
    with streamLock:
        while got < n:
            sr = sdr.readStream(stream, [buf[got:]], n - got, timeoutUs=1000000)
            if sr.ret == -4 or sr.ret == -1:
                # TIMEOUT / STREAM_ERROR: a retune on the live stream (or a
                # stall) can wedge the flow -- bounce the stream once
                try:
                    sdr.deactivateStream(stream)
                except Exception:
                    pass
                try:
                    sdr.activateStream(stream)
                except Exception:
                    pass
                raise RuntimeError("readStream: %d" % sr.ret)
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
    # retuning a live stream wedges some backends (HackRF): bounce it
    with streamLock:
        try:
            sdr.deactivateStream(stream)
        except Exception:
            pass
        apply()
        try:
            sdr.activateStream(stream)
        except Exception:
            pass
    return cfg


@bridge.command("capture", "{samples, path} save raw cf32 IQ to a file")
def capture(args):
    iq = read(int(args.get("samples", 1 << 20)))
    path = args.get("path", "/tmp/mailab_%d.cf32" % int(time.time()))
    iq.tofile(path)
    return {"path": path, "samples": len(iq), "rate": cfg["rate"], "freq": cfg["freq"]}


@bridge.command("demod", "{offset, mode: fm|am|usb|lsb, seconds, audio_rate, deviation, path} demodulate (liquid-dsp) -> WAV + traces audio, audio_spectrum")
def demod(args):
    import wave
    import liquid_dsp as dsp

    rate = cfg["rate"]
    audio_rate = float(args.get("audio_rate", 48000))
    mode = args.get("mode", "fm")
    iq = read(int(rate * float(args.get("seconds", 2))))
    bb = dsp.resample(dsp.shift(iq, float(args.get("offset", 0)), rate), audio_rate / rate)
    if mode == "fm":
        audio = dsp.fm_demod(bb, float(args.get("deviation", 5000)), audio_rate)
    else:
        kind = {"am": dsp.AM_DSB, "usb": dsp.AM_USB, "lsb": dsp.AM_LSB}[mode]
        audio = dsp.am_demod(bb, kind)
        audio = audio - np.mean(audio)
    audio = audio / (np.max(np.abs(audio)) or 1)

    path = args.get("path", "/tmp/mailab_demod_%d.wav" % int(time.time()))
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(int(audio_rate))
        out.writeframes((audio * 32767).astype("<i2").tobytes())

    # the AI can't listen, but it can look: waveform + audio spectrum
    shown = audio[: int(audio_rate * 0.1)]
    lab.trace("audio", (np.arange(len(shown)) / audio_rate).tolist(), [{"label": mode, "y": np.round(shown, 4).tolist()}], "s", "")
    spec = np.abs(np.fft.rfft(audio * np.hanning(len(audio))))
    freqs = np.fft.rfftfreq(len(audio), 1 / audio_rate)
    spec_db = 20 * np.log10(spec / (np.max(spec) or 1) + 1e-9)
    step = max(1, len(freqs) // 2000)
    lab.trace("audio_spectrum", freqs[::step].tolist(), [{"label": "dB", "y": np.round(spec_db[::step], 2).tolist()}], "Hz", "dB")
    peak = int(np.argmax(spec[1:]) + 1)
    return {"path": path, "samples": len(audio), "audio_rate": audio_rate, "peak_audio_hz": float(freqs[peak])}


tick_errors = 0


def safe_tick():
    global tick_errors
    try:
        tick()
        tick_errors = 0
    except Exception as err:
        tick_errors += 1
        if tick_errors <= 3 or tick_errors % 60 == 0:
            lab.log("spectrum tick: %s" % err, "warn")


bridge.every(1 / opts.fps, safe_tick)
try:
    bridge.run()
finally:
    sdr.deactivateStream(stream)
    sdr.closeStream(stream)
