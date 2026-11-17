"""video_decode regression checks: a synthetic PAL/NTSC composite signal
(sync tips at 0, blanking at 0.3, white at 1.0) is assembled back into
grayscale frames with the right dimensions and brightness layout, across
odd chunk sizes. Run directly (python3 python/test_video.py) or via jest."""

import os
import sys
import time
import zlib

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import flowgraph_bridge as fb

RATE = 8e6
US = RATE / 1e6  # samples per microsecond


def synth_frame(standard="pal", n_lines=600, pattern="gradient", vsync=True,
                  noise=0.0, seed=7):
    """One field-ish of composite video (no color subcarrier, grayscale)."""
    line_us = fb.VideoDecode.LINE_US[standard]
    line = int(line_us * US)
    sync_us = 4.7
    x = np.full(n_lines * line, 0.3)  # blanking level
    rows = np.zeros((n_lines, 720))
    rng = np.random.default_rng(seed)
    for n in range(n_lines):
        base = n * line
        x[base:base + int(sync_us * US)] = 0.0  # H sync tip
        a0 = base + int(9.4 * US)
        a1 = base + int(61.4 * US)
        if a1 <= a0 or a1 > base + line:
            continue
        if pattern == "gradient":
            level = 0.3 + 0.7 * (n / max(1, n_lines - 1))  # brightens down the field
            x[a0:a1] = level
            rows[n, :] = level
        else:  # ramp: brightness sweeps left->right within the line
            ramp = np.linspace(0.3, 1.0, a1 - a0)
            x[a0:a1] = ramp
            rows[n, :] = np.interp(np.linspace(0, 1, 720),
                                   np.linspace(0, 1, len(ramp)), ramp)
    if vsync:
        # a vertical-sync interval: two whole lines held at sync-tip level
        vs = np.full(2 * line, 0.0)
        x = np.concatenate([x, vs])
    if noise:
        x = x + rng.normal(0, noise, len(x))
    return np.clip(x, -0.2, 1.2), rows


def run_block(params, x, chunk=100003):
    values = []
    images = []
    samples = []
    fb.lab.value = lambda name, v: values.append((name, v))
    fb.lab.sample = lambda name, v, unit=None: samples.append((name, v))
    fb.lab.image = lambda name, data, mime="image/png": images.append((name, data))
    blk = fb.BLOCKS["video_decode"]("vid", params)
    for i in range(0, len(x), chunk):
        blk.work(x[i:i + chunk], RATE)
    return values, images, samples


def png_size(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def test_pal_gradient():
    x, _rows = synth_frame("pal", n_lines=600)
    values, images, samples = run_block({"standard": "pal", "width": "360", "fps": "30"}, x)
    frames = [v for name, v in values if name == "vid"]
    assert frames, "no frame stats published"
    last = frames[-1]
    assert last["standard"] == "pal" and last["width"] == 360, last
    assert 500 <= last["height"] <= 600, last  # 576 active + sync-line slack
    assert images, "no PNG frame published"
    name, data = images[-1]
    assert name == "vid"
    w, h = png_size(data)
    assert (w, h) == (360, last["height"]), (w, h, last)
    assert samples and samples[-1][0] == "vid_frames" and samples[-1][1] >= 1
    # decode the PNG pixels back and check the vertical gradient survived:
    # last rows must be brighter than first rows (filter byte 0 per scanline)
    raw = zlib.decompress(data[data.index(b"IDAT") + 4:-12])
    stride = w + 1
    first = np.frombuffer(raw[1:1 + w], dtype=np.uint8).mean()
    lastrow = np.frombuffer(raw[(h - 1) * stride + 1:(h - 1) * stride + 1 + w],
                            dtype=np.uint8).mean()
    assert lastrow > first + 60, (first, lastrow)


def test_ntsc_ramp_odd_chunks():
    x, _rows = synth_frame("ntsc", n_lines=500, pattern="ramp")
    values, images, _ = run_block({"standard": "ntsc", "width": "180", "fps": "30"}, x,
                                  chunk=65537)
    frames = [v for name, v in values if name == "vid"]
    assert frames, "no frame stats published"
    last = frames[-1]
    assert last["standard"] == "ntsc" and 400 <= last["height"] <= 500, last
    assert images, "no PNG frame published"
    w, h = png_size(images[-1][1])
    assert (w, h) == (180, last["height"]), (w, h, last)
    # ramp: right half of a middle row brighter than left half
    raw = zlib.decompress(images[-1][1][images[-1][1].index(b"IDAT") + 4:-12])
    stride = w + 1
    mid = np.frombuffer(raw[(h // 2) * stride + 1:(h // 2) * stride + 1 + w],
                        dtype=np.uint8)
    assert mid[w // 2:].mean() > mid[:w // 2].mean() + 40, (mid[:w // 2].mean(), mid[w // 2:].mean())


def test_noise_and_inverted():
    x, _ = synth_frame("pal", n_lines=600, noise=0.04)
    x = 1.0 - x  # inverted video (sync tips at the top)
    values, images, _ = run_block({"standard": "pal", "invert": "true",
                                   "width": "180", "fps": "30"}, x)
    assert images, "no frame with inverted + noisy video"
    last = [v for name, v in values if name == "vid"][-1]
    assert 500 <= last["height"] <= 600, last


def test_low_rate_refused():
    blk = fb.BLOCKS["video_decode"]("vid", {})
    try:
        blk.work(np.zeros(16), 192000)
    except ValueError as e:
        assert "MS/s" in str(e), e
    else:
        raise AssertionError("low sample rate not refused")


if __name__ == "__main__":
    for name, fn in sorted({k: v for k, v in globals().items()
                            if k.startswith("test_")}.items()):
        t0 = time.time()
        fn()
        print("ok %-28s %.2fs" % (name, time.time() - t0))
    print("all video_decode tests passed")
