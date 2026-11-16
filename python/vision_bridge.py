"""mailab vision service: OpenCV on lab images, one long-running process.

Requests (mailab_bridge JSON lines):
    ops                                  the op catalog
    run   {image, ops, annotate, output, key}
          image: base64 (PNG/JPEG/...); ops: [{op: "crop", ...params}, ...]
          -> {results: [{op, ms, ...}], annotated: b64 png, output: b64 png, size: [w, h]}
    watch {key, image, rois, annotate}
          rois: [{name, rect: [x, y, w, h], kind, params}]
          kind: led | value_ocr | seven_seg | color | motion | template
          -> {rois: {name: {value, text, state, ...}}, annotated, ms}
    forget {key}                         drop per-stream state (previous frames)

Image params (template, reference) arrive as "<param>_data" (base64), resolved
by the lab from lab image names. Coordinates are pixels of the image the op
sees (after earlier crops / warps); overlays are drawn on the image as it was
before the last geometric change (crop offsets are kept, so crops overlay on
the full frame).
"""

import base64
import math
import re
import subprocess
import time

import cv2
import numpy as np

from mailab_bridge import Bridge

TESSERACT = "tesseract"
OCR_TIMEOUT_S = 10
GREEN = (0, 220, 0)
RED = (0, 0, 255)
YELLOW = (0, 220, 255)
CYAN = (255, 220, 0)
MAX_KEYS = 64

# ---- helpers ------------------------------------------------------------------


def decode(data):
    if isinstance(data, str):
        data = base64.b64decode(data)
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("can't decode image")
    return img


def encode(img, fmt=".png"):
    ok, buf = cv2.imencode(fmt, img)
    if not ok:
        raise ValueError("can't encode image")
    return base64.b64encode(buf.tobytes()).decode()


def gray(img):
    if img.ndim == 2:
        return img
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def bgr(img):
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    return img


def clip_rect(rect, shape):
    """[x, y, w, h] clipped to the image; None = whole image"""
    h, w = shape[:2]
    if rect is None:
        return 0, 0, w, h
    x, y, rw, rh = [int(round(float(v))) for v in rect]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(w, x + rw), min(h, y + rh)
    if x1 <= x0 or y1 <= y0:
        raise ValueError("rect %s is outside the %dx%d image" % (rect, w, h))
    return x0, y0, x1 - x0, y1 - y0


def sub(img, rect):
    x, y, w, h = clip_rect(rect, img.shape)
    return img[y:y + h, x:x + w], (x, y, w, h)


def number(text):
    m = re.search(r"-?\d+(?:[.,]\d+)?", text or "")
    if not m:
        return None
    return float(m.group(0).replace(",", "."))


def binarize(g, threshold=None, invert=False):
    if threshold is None:
        _t, out = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    else:
        _t, out = cv2.threshold(g, float(threshold), 255, cv2.THRESH_BINARY)
    if invert:
        out = 255 - out
    return out


def color_name(h, s, v):
    """name of an OpenCV HSV colour (H 0..179)"""
    if v < 50:
        return "black"
    if s < 50:
        return "white" if v > 180 else "gray"
    if h < 8 or h >= 165:
        return "red"
    if h < 22:
        return "orange"
    if h < 35:
        return "yellow"
    if h < 85:
        return "green"
    if h < 100:
        return "cyan"
    if h < 130:
        return "blue"
    return "magenta"


def mean_hue(hsv_pixels):
    """circular mean of OpenCV hues (red wraps around 0/180)"""
    if not len(hsv_pixels):
        return 0.0
    ang = hsv_pixels[:, 0].astype(np.float64) * (2 * math.pi / 180.0)
    a = math.atan2(np.sin(ang).mean(), np.cos(ang).mean())
    return (a * 180.0 / (2 * math.pi)) % 180.0


class Ctx:
    """pipeline state: current image, overlay canvas (+ offset), scale"""

    def __init__(self, img, annotate):
        self.img = img
        self.annotate = annotate
        self.canvas = img.copy() if annotate else None
        self.offset = (0, 0)
        self.mm_per_px = None
        self.prev = {}

    def geometry_changed(self):
        if self.annotate:
            self.canvas = bgr(self.img).copy()
        self.offset = (0, 0)

    def rect(self, rect, color=GREEN, label=None):
        if self.canvas is None:
            return
        x, y, w, h = [int(v) for v in rect]
        ox, oy = self.offset
        cv2.rectangle(self.canvas, (x + ox, y + oy), (x + ox + w, y + oy + h), color, 2)
        if label:
            self.text(label, (x + ox, y + oy - 4 if y + oy > 14 else y + oy + h + 14), color)

    def text(self, label, at, color=GREEN):
        if self.canvas is None:
            return
        # Hershey fonts are ASCII only (OCR text may hold dashes, umlauts...)
        label = str(label).replace("—", "-").replace("–", "-").encode("ascii", "replace").decode()
        cv2.putText(self.canvas, label, (int(at[0]), int(at[1])), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(self.canvas, label, (int(at[0]), int(at[1])), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)

    def poly(self, pts, color=GREEN):
        if self.canvas is None:
            return
        ox, oy = self.offset
        p = np.array([[int(x + ox), int(y + oy)] for x, y in pts], np.int32)
        cv2.polylines(self.canvas, [p], True, color, 2)

    def line(self, a, b, color=YELLOW):
        if self.canvas is None:
            return
        ox, oy = self.offset
        cv2.line(self.canvas, (int(a[0] + ox), int(a[1] + oy)), (int(b[0] + ox), int(b[1] + oy)), color, 2)

    def dot(self, p, color=RED):
        if self.canvas is None:
            return
        ox, oy = self.offset
        cv2.circle(self.canvas, (int(p[0] + ox), int(p[1] + oy)), 3, color, -1)


# ---- image ops (change the pipeline image) ---------------------------------------


def op_crop(ctx, p):
    region, (x, y, w, h) = sub(ctx.img, p.get("rect"))
    ctx.img = region.copy()
    ctx.offset = (ctx.offset[0] + x, ctx.offset[1] + y)
    return {"rect": [x, y, w, h]}


def op_resize(ctx, p):
    h, w = ctx.img.shape[:2]
    if p.get("scale"):
        size = (max(1, int(w * float(p["scale"]))), max(1, int(h * float(p["scale"]))))
    else:
        size = (int(p.get("width", w)), int(p.get("height", h)))
    ctx.img = cv2.resize(ctx.img, size, interpolation=cv2.INTER_AREA if size[0] < w else cv2.INTER_CUBIC)
    ctx.geometry_changed()
    return {"size": list(size)}


def op_gray(ctx, _p):
    ctx.img = gray(ctx.img)
    return {}


def op_threshold(ctx, p):
    g = gray(ctx.img)
    if p.get("otsu") or p.get("value") is None:
        t, out = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    else:
        t, out = cv2.threshold(g, float(p["value"]), 255, cv2.THRESH_BINARY)
    if p.get("invert"):
        out = 255 - out
    ctx.img = out
    return {"threshold": float(t), "white_fraction": float((out > 0).mean())}


def op_adaptive(ctx, p):
    block = int(p.get("block", 31)) | 1
    method = cv2.ADAPTIVE_THRESH_MEAN_C if p.get("method") == "mean" else cv2.ADAPTIVE_THRESH_GAUSSIAN_C
    kind = cv2.THRESH_BINARY_INV if p.get("invert") else cv2.THRESH_BINARY
    ctx.img = cv2.adaptiveThreshold(gray(ctx.img), 255, method, kind, max(3, block), float(p.get("c", 5)))
    return {}


def op_blur(ctx, p):
    k = int(p.get("ksize", 5)) | 1
    kind = p.get("kind", "gaussian")
    if kind == "median":
        ctx.img = cv2.medianBlur(ctx.img, k)
    elif kind == "box":
        ctx.img = cv2.blur(ctx.img, (k, k))
    else:
        ctx.img = cv2.GaussianBlur(ctx.img, (k, k), 0)
    return {}


def op_morph(ctx, p):
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (int(p.get("ksize", 3)), int(p.get("ksize", 3))))
    kinds = {"open": cv2.MORPH_OPEN, "close": cv2.MORPH_CLOSE, "dilate": cv2.MORPH_DILATE, "erode": cv2.MORPH_ERODE}
    if p.get("kind", "open") not in kinds:
        raise ValueError("morph kind: open | close | dilate | erode")
    ctx.img = cv2.morphologyEx(ctx.img, kinds[p.get("kind", "open")], k, iterations=int(p.get("iterations", 1)))
    return {}


def op_canny(ctx, p):
    ctx.img = cv2.Canny(gray(ctx.img), float(p.get("low", 50)), float(p.get("high", 150)))
    return {"edge_fraction": float((ctx.img > 0).mean())}


def op_warp(ctx, p):
    pts = np.array(p["points"], np.float32)
    if pts.shape != (4, 2):
        raise ValueError("points: 4 corners [[x, y], ...] (top-left, top-right, bottom-right, bottom-left)")
    w = int(p.get("width") or max(np.linalg.norm(pts[1] - pts[0]), np.linalg.norm(pts[2] - pts[3])))
    h = int(p.get("height") or max(np.linalg.norm(pts[3] - pts[0]), np.linalg.norm(pts[2] - pts[1])))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    m = cv2.getPerspectiveTransform(pts, dst)
    ctx.poly(pts, CYAN)
    ctx.img = cv2.warpPerspective(ctx.img, m, (w, h))
    ctx.geometry_changed()
    return {"size": [w, h], "matrix": m.tolist()}


def op_align(ctx, p):
    if not p.get("reference_data"):
        raise ValueError("align needs reference (a lab image name)")
    ref = decode(p["reference_data"])
    orb = cv2.ORB_create(int(p.get("features", 2000)))
    k1, d1 = orb.detectAndCompute(gray(ctx.img), None)
    k2, d2 = orb.detectAndCompute(gray(ref), None)
    if d1 is None or d2 is None:
        raise ValueError("no features found")
    matches = sorted(cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(d1, d2), key=lambda m: m.distance)
    matches = matches[:max(10, int(len(matches) * float(p.get("keep", 0.5))))]
    if len(matches) < 4:
        raise ValueError("too few matches (%d)" % len(matches))
    src = np.float32([k1[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
    dst = np.float32([k2[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
    m, mask = cv2.findHomography(src, dst, cv2.RANSAC, float(p.get("ransac_px", 5.0)))
    if m is None:
        raise ValueError("no homography")
    h, w = ref.shape[:2]
    ctx.img = cv2.warpPerspective(ctx.img, m, (w, h))
    ctx.geometry_changed()
    return {"matrix": m.tolist(), "matches": len(matches), "inliers": int(mask.sum()), "size": [w, h]}


# ---- measurements ----------------------------------------------------------------


def op_contours(ctx, p):
    region, (x, y, _w, _h) = sub(ctx.img, p.get("rect"))
    g = gray(region)
    uniq = np.unique(g)
    binary = g if len(uniq) <= 2 else binarize(g, p.get("threshold"), p.get("invert", False))
    found, _hier = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_area = float(p.get("min_area", 50))
    out = []
    for c in found:
        area = cv2.contourArea(c)
        if area < min_area:
            continue
        bx, by, bw, bh = cv2.boundingRect(c)
        mo = cv2.moments(c)
        cx = mo["m10"] / mo["m00"] if mo["m00"] else bx + bw / 2
        cy = mo["m01"] / mo["m00"] if mo["m00"] else by + bh / 2
        item = {"area": float(area), "bbox": [bx + x, by + y, bw, bh], "centroid": [cx + x, cy + y],
                "perimeter": float(cv2.arcLength(c, True))}
        if ctx.mm_per_px:
            s = ctx.mm_per_px
            item["mm"] = {"w": bw * s, "h": bh * s, "area": area * s * s}
        out.append(item)
    out.sort(key=lambda c: -c["area"])
    out = out[:int(p.get("max", 50))]
    for i, c in enumerate(out):
        ctx.rect(c["bbox"], GREEN, str(i))
        ctx.dot(c["centroid"])
    return {"count": len(out), "contours": out}


def scales_of(p):
    s = p.get("scales", [0.5, 1.5, 11])
    if len(s) == 3 and isinstance(s[2], int) and s[2] > 1 and s[2] != s[1]:
        return list(np.linspace(float(s[0]), float(s[1]), int(s[2])))
    return [float(v) for v in s]


def template_match(img, tmpl, p, rect=None):
    region, (x, y, _w, _h) = sub(img, rect)
    g = gray(region)
    t = gray(tmpl)
    best = None
    for s in scales_of(p):
        tw, th = int(t.shape[1] * s), int(t.shape[0] * s)
        if tw < 4 or th < 4 or tw > g.shape[1] or th > g.shape[0]:
            continue
        r = cv2.matchTemplate(g, cv2.resize(t, (tw, th)), cv2.TM_CCOEFF_NORMED)
        _mn, score, _ml, loc = cv2.minMaxLoc(r)
        if best is None or score > best["score"]:
            best = {"score": float(score), "bbox": [loc[0] + x, loc[1] + y, tw, th], "scale": float(s)}
    if best is None:
        return {"found": False, "score": 0.0}
    best["found"] = best["score"] >= float(p.get("threshold", 0.8))
    best["center"] = [best["bbox"][0] + best["bbox"][2] / 2, best["bbox"][1] + best["bbox"][3] / 2]
    return best


def op_template(ctx, p):
    if not p.get("template_data"):
        raise ValueError("template needs template (a lab image name)")
    res = template_match(ctx.img, decode(p["template_data"]), p, p.get("rect"))
    if "bbox" in res:
        ctx.rect(res["bbox"], GREEN if res["found"] else RED, "%.2f" % res["score"])
    return res


def color_stats(img):
    b = bgr(img)
    hsv = cv2.cvtColor(b, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    rgb = b.reshape(-1, 3)[:, ::-1].astype(np.float64)
    h = mean_hue(hsv[hsv[:, 1] > 40]) if (hsv[:, 1] > 40).any() else float(hsv[:, 0].mean())
    s, v = float(hsv[:, 1].mean()), float(hsv[:, 2].mean())
    return {"rgb": [float(c) for c in rgb.mean(axis=0)], "rgb_std": [float(c) for c in rgb.std(axis=0)],
            "hsv": [h, s, v], "brightness": float(gray(b).mean()), "color": color_name(h, s, v)}


def op_color(ctx, p):
    region, rect = sub(ctx.img, p.get("rect"))
    res = color_stats(region)
    ctx.rect(rect, CYAN, res["color"])
    return res


def led_state(region, p):
    """LED on/off from the brightest pixels (an LED is a small bright spot)"""
    b = bgr(region)
    hsv = cv2.cvtColor(b, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    v = hsv[:, 2].astype(np.float64)
    top = np.sort(v)[-max(1, int(len(v) * float(p.get("top", 0.2)))):]
    level = float(top.mean())
    bright = hsv[v >= np.percentile(v, 80)]
    lit = bright[bright[:, 1] > 60]
    if len(lit) > len(bright) * 0.3:
        h = mean_hue(lit)
        name = color_name(h, float(lit[:, 1].mean()), float(lit[:, 2].mean()))
    else:
        h = None
        name = "white" if level > 180 else "gray"
    on = level >= float(p.get("threshold", 160))
    want = p.get("color")
    if on and want and want != name:
        on = False
    return {"on": bool(on), "level": level, "hue": h, "color": name if on else "off"}


def op_led(ctx, p):
    region, rect = sub(ctx.img, p.get("rect"))
    res = led_state(region, p)
    ctx.rect(rect, GREEN if res["on"] else RED, ("ON " + res["color"]) if res["on"] else "off")
    return res


# a b c d e f g
SEGMENT_BOXES = {
    "a": (0.25, 0.0, 0.75, 0.16), "b": (0.78, 0.12, 1.0, 0.44), "c": (0.78, 0.56, 1.0, 0.88),
    "d": (0.25, 0.84, 0.75, 1.0), "e": (0.0, 0.56, 0.22, 0.88), "f": (0.0, 0.12, 0.22, 0.44),
    "g": (0.25, 0.42, 0.75, 0.58),
}
SEGMENTS = "abcdefg"
GLYPHS = {
    "abcdef": "0", "bc": "1", "abdeg": "2", "abcdg": "3", "bcfg": "4", "acdfg": "5", "acdefg": "6",
    "abc": "7", "abcf": "7", "abcdefg": "8", "abcdfg": "9", "abcfg": "9", "g": "-", "": " ",
    "abcefg": "A", "cdefg": "b", "adef": "C", "deg": "c", "bcdeg": "d", "adefg": "E", "aefg": "F",
    "bcefg": "H", "def": "L", "ceg": "n", "cdeg": "o", "abefg": "P", "eg": "r", "defg": "t",
    "bcdef": "U", "cde": "u", "d": "_", "ef": "1", "bcdfg": "y",
}


def read_digit(binary, skew=0.0, on_fraction=0.45):
    h, w = binary.shape[:2]
    lit = []
    fractions = {}
    for seg in SEGMENTS:
        x0, y0, x1, y1 = SEGMENT_BOXES[seg]
        # italic displays: shift the sample boxes right towards the top
        dx = skew * (0.5 - (y0 + y1) / 2) * h
        xa, xb = int(x0 * w + dx), int(x1 * w + dx)
        cell = binary[int(y0 * h):max(int(y0 * h) + 1, int(y1 * h)), max(0, xa):max(max(0, xa) + 1, min(w, xb))]
        f = float((cell > 0).mean()) if cell.size else 0.0
        fractions[seg] = f
        if f >= on_fraction:
            lit.append(seg)
    key = "".join(lit)
    return {"segments": key, "char": GLYPHS.get(key, "?"), "fractions": fractions}


def digit_boxes(p, rect):
    """digit boxes in image pixels: given, or `count` equal boxes across rect"""
    if p.get("digits"):
        return [[float(v) for v in d] for d in p["digits"]]
    count = int(p.get("count", 0))
    if count < 1 or rect is None:
        raise ValueError("seven_seg needs digits [[x, y, w, h], ...] or rect + count (equal boxes across rect)")
    x, y, w, h = [float(v) for v in rect]
    gap = float(p.get("gap", 0.15))
    step = w / count
    return [[x + i * step + step * gap / 2, y, step * (1 - gap), h] for i in range(count)]


def seven_seg(img, p, rect=None, ctx=None):
    boxes = digit_boxes(p, rect)
    if rect is None:
        x0 = min(b[0] for b in boxes)
        y0 = min(b[1] for b in boxes)
        rect = [x0, y0, max(b[0] + b[2] for b in boxes) - x0, max(b[1] + b[3] for b in boxes) - y0]
    region, r = sub(img, rect)
    g = gray(region)
    if p.get("threshold") is not None:
        binary = binarize(g, p["threshold"], p.get("invert", False))
    elif int(g.max()) - int(g.min()) < int(p.get("min_contrast", 40)):
        # flat region: blank display, every segment off
        binary = np.zeros_like(g)
    else:
        binary = binarize(g, None, p.get("invert", False))
    digits = []
    for b in boxes:
        cell, cr = sub(binary, [b[0] - r[0], b[1] - r[1], b[2], b[3]])
        d = read_digit(cell, float(p.get("skew", 0.0)), float(p.get("on_fraction", 0.45)))
        d["rect"] = [cr[0] + r[0], cr[1] + r[1], cr[2], cr[3]]
        digits.append(d)
        if ctx:
            ctx.rect(d["rect"], GREEN if d["char"] != "?" else RED, d["char"])
    text = "".join(d["char"] for d in digits)
    # decimal point after digit index `dp` (fixed-point displays)
    if p.get("dp") is not None and 0 <= int(p["dp"]) < len(text) - 1:
        text = text[:int(p["dp"]) + 1] + "." + text[int(p["dp"]) + 1:]
    stripped = text.strip()
    compact = stripped.replace(" ", "")
    value = float(compact) if re.fullmatch(r"-?\d+(\.\d+)?", compact) else None
    return {"text": stripped, "value": value, "digits": [{k: d[k] for k in ("char", "segments", "rect")} for d in digits]}


def op_seven_seg(ctx, p):
    return seven_seg(ctx.img, p, p.get("rect"), ctx)


_langs = []


def tesseract_langs():
    """installed tesseract languages (cached; osd is not a language)"""
    if not _langs:
        try:
            out = subprocess.run([TESSERACT, "--list-langs"], capture_output=True, timeout=OCR_TIMEOUT_S).stdout.decode()
        except FileNotFoundError:
            raise ValueError("tesseract is not installed (apt/pacman install tesseract + tesseract-data-eng)")
        _langs.extend(line.strip() for line in out.splitlines()[1:] if line.strip() and line.strip() != "osd")
    return _langs


def default_lang():
    langs = tesseract_langs()
    if not langs:
        raise ValueError("tesseract has no language data (install tesseract-data-eng / tesseract-ocr-eng)")
    return "eng" if "eng" in langs else langs[0]


def ocr(img, p, rect=None):
    region, r = sub(img, rect)
    g = gray(region)
    if g.shape[0] < 40:
        f = 40.0 / g.shape[0]
        g = cv2.resize(g, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    if p.get("raw"):
        prepared = g
    else:
        prepared = binarize(g)
        # tesseract wants dark text on a light background
        if (prepared > 0).mean() < 0.5:
            prepared = 255 - prepared
        prepared = cv2.copyMakeBorder(prepared, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)
    args = [TESSERACT, "stdin", "stdout", "--psm", str(int(p.get("psm", 7)))]
    whitelist = p.get("whitelist")
    if p.get("digits") and not whitelist:
        whitelist = "0123456789.-"
    if whitelist:
        args += ["-c", "tessedit_char_whitelist=" + str(whitelist)]
    args += ["-l", str(p.get("lang") or default_lang())]
    args.append("tsv")
    ok, png = cv2.imencode(".png", prepared)
    try:
        run = subprocess.run(args, input=png.tobytes(), capture_output=True, timeout=OCR_TIMEOUT_S)
    except FileNotFoundError:
        raise ValueError("tesseract is not installed (apt/pacman install tesseract)")
    if run.returncode != 0:
        raise ValueError("tesseract: " + run.stderr.decode(errors="replace").strip()[-200:])
    words, confs = [], []
    for line in run.stdout.decode(errors="replace").splitlines()[1:]:
        cols = line.split("\t")
        if len(cols) >= 12 and cols[11].strip():
            words.append(cols[11].strip())
            try:
                confs.append(float(cols[10]))
            except ValueError:
                pass
    text = " ".join(words)
    return {"text": text, "value": number(text), "confidence": float(np.mean(confs)) if confs else 0.0, "rect": list(r)}


def op_ocr(ctx, p):
    res = ocr(ctx.img, p, p.get("rect"))
    ctx.rect(res["rect"], CYAN, res["text"][:24])
    return res


ARUCO_DICTS = {name[5:]: getattr(cv2.aruco, name) for name in dir(cv2.aruco) if name.startswith("DICT_")}


def aruco_dict(name):
    key = str(name or "4X4_50").upper().replace("DICT_", "")
    if key not in ARUCO_DICTS:
        raise ValueError("unknown ArUco dictionary %s (e.g. 4X4_50, 5X5_100, 6X6_250, ARUCO_ORIGINAL)" % name)
    return cv2.aruco.getPredefinedDictionary(ARUCO_DICTS[key])


def op_aruco(ctx, p):
    detector = cv2.aruco.ArucoDetector(aruco_dict(p.get("dict")), cv2.aruco.DetectorParameters())
    corners, ids, _rej = detector.detectMarkers(gray(ctx.img))
    markers = []
    h, w = ctx.img.shape[:2]
    size_mm = p.get("marker_mm")
    for c, i in zip(corners, ids.flatten() if ids is not None else []):
        pts = c.reshape(4, 2)
        sides = [float(np.linalg.norm(pts[k] - pts[(k + 1) % 4])) for k in range(4)]
        m = {"id": int(i), "corners": pts.tolist(), "center": pts.mean(axis=0).tolist(), "side_px": float(np.mean(sides))}
        if size_mm:
            m["mm_per_px"] = float(size_mm) / m["side_px"]
            # pose with a guessed pinhole camera (focal = image width) unless one is given
            cam = np.array(p.get("camera_matrix") or [[w, 0, w / 2], [0, w, h / 2], [0, 0, 1]], np.float64)
            half = float(size_mm) / 2
            obj = np.array([[-half, half, 0], [half, half, 0], [half, -half, 0], [-half, -half, 0]], np.float64)
            ok, rvec, tvec = cv2.solvePnP(obj, pts.astype(np.float64), cam, np.zeros(5), flags=cv2.SOLVEPNP_IPPE_SQUARE)
            if ok:
                m["rvec"] = rvec.flatten().tolist()
                m["tvec_mm"] = tvec.flatten().tolist()
        markers.append(m)
        ctx.poly(pts, GREEN)
        ctx.text("id %d" % m["id"], (pts[0][0] + ctx.offset[0], pts[0][1] + ctx.offset[1] - 4))
    res = {"count": len(markers), "markers": markers}
    if size_mm and markers:
        ctx.mm_per_px = float(np.mean([m["mm_per_px"] for m in markers]))
        res["mm_per_px"] = ctx.mm_per_px
    return res


def op_scale(ctx, p):
    """set mm per pixel by hand (a ruler, a known part)"""
    if p.get("mm_per_px"):
        ctx.mm_per_px = float(p["mm_per_px"])
    elif p.get("points") and p.get("mm"):
        a, b = np.array(p["points"][0], float), np.array(p["points"][1], float)
        ctx.mm_per_px = float(p["mm"]) / float(np.linalg.norm(b - a))
    else:
        raise ValueError("scale: mm_per_px, or points [[x, y], [x, y]] + mm")
    return {"mm_per_px": ctx.mm_per_px}


def op_measure(ctx, p):
    pts = p.get("points")
    if not pts or len(pts) < 2:
        raise ValueError("measure needs points [[x, y], [x, y], ...] (a polyline)")
    arr = np.array(pts, float)
    segs = [float(np.linalg.norm(arr[i + 1] - arr[i])) for i in range(len(arr) - 1)]
    px = float(sum(segs))
    scale = float(p["mm_per_px"]) if p.get("mm_per_px") else ctx.mm_per_px
    for i in range(len(arr) - 1):
        ctx.line(arr[i], arr[i + 1])
    res = {"px": px, "segments_px": segs}
    label = "%.1f px" % px
    if scale:
        res["mm"] = px * scale
        res["mm_per_px"] = scale
        label = "%.2f mm" % res["mm"]
    ctx.text(label, (arr[-1][0] + ctx.offset[0] + 4, arr[-1][1] + ctx.offset[1]), YELLOW)
    return res


def motion(prev, cur, p):
    a = cv2.GaussianBlur(gray(prev), (5, 5), 0)
    b = cv2.GaussianBlur(gray(cur), (5, 5), 0)
    if a.shape != b.shape:
        a = cv2.resize(a, (b.shape[1], b.shape[0]))
    d = cv2.absdiff(a, b)
    mask = d > int(p.get("pixel_threshold", 25))
    res = {"score": float(d.mean() / 255.0), "changed": float(mask.mean())}
    if mask.any():
        ys, xs = np.nonzero(mask)
        res["bbox"] = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]
    return res


def op_diff(ctx, p):
    region, rect = sub(ctx.img, p.get("rect"))
    if p.get("reference_data"):
        ref, _r = sub(decode(p["reference_data"]), p.get("rect"))
    else:
        ref = ctx.prev.get("diff")
        ctx.prev["diff"] = region.copy()
        if ref is None:
            return {"score": 0.0, "changed": 0.0, "first": True}
    res = motion(ref, region, p)
    if "bbox" in res:
        res["bbox"][0] += rect[0]
        res["bbox"][1] += rect[1]
        ctx.rect(res["bbox"], RED, "%.3f" % res["changed"])
    return res


def op_stats(ctx, p):
    region, _r = sub(ctx.img, p.get("rect"))
    h, w = ctx.img.shape[:2]
    g = gray(region)
    return {"size": [w, h], "channels": 1 if ctx.img.ndim == 2 else ctx.img.shape[2], "mean": float(g.mean()),
            "std": float(g.std()), "min": int(g.min()), "max": int(g.max()),
            "sharpness": float(cv2.Laplacian(g, cv2.CV_64F).var())}


OPS = {
    "crop": (op_crop, "{rect: [x, y, w, h]} continue on a region (overlays stay on the full frame)"),
    "resize": (op_resize, "{scale} or {width, height}"),
    "gray": (op_gray, "grayscale"),
    "threshold": (op_threshold, "{value} fixed or {otsu: true} (default), invert"),
    "adaptive": (op_adaptive, "adaptive threshold {block: 31, c: 5, method: gaussian|mean, invert}"),
    "blur": (op_blur, "{ksize: 5, kind: gaussian|median|box}"),
    "morph": (op_morph, "{kind: open|close|dilate|erode, ksize: 3, iterations: 1}"),
    "canny": (op_canny, "edges {low: 50, high: 150}"),
    "warp": (op_warp, "perspective warp {points: 4 corners TL TR BR BL, width, height}"),
    "align": (op_align, "register onto a reference image {reference: lab image, features: 2000} (ORB + RANSAC homography) -> matrix, inliers"),
    "contours": (op_contours, "{rect, min_area: 50, max: 50, threshold, invert} -> [{area, bbox, centroid, perimeter, mm}]"),
    "template": (op_template, "{template: lab image, rect, scales: [0.5, 1.5, 11] (min, max, steps) or list, threshold: 0.8} -> found, score, bbox, scale"),
    "color": (op_color, "{rect} -> mean rgb / hsv, brightness, colour name"),
    "led": (op_led, "{rect, threshold: 160 (V of the brightest 20%), color: expected colour name} -> on, level, color"),
    "seven_seg": (op_seven_seg, "{digits: [[x, y, w, h], ...]} or {rect, count, gap: 0.15}; threshold, invert (dark segments), skew, dp, on_fraction: 0.45 -> text, value"),
    "ocr": (op_ocr, "tesseract {rect, digits: bool, whitelist, psm: 7, lang} -> text, value, confidence"),
    "aruco": (op_aruco, "{dict: 4X4_50, marker_mm} -> markers (id, corners, center, side_px, pose with marker_mm), sets mm_per_px"),
    "scale": (op_scale, "set mm per px {mm_per_px} or {points: [[x, y], [x, y]], mm}"),
    "measure": (op_measure, "{points: [[x, y], ...], mm_per_px} -> px, mm (scale from aruco / scale)"),
    "diff": (op_diff, "change vs {reference: lab image} or the previous frame of this key {rect, pixel_threshold: 25} -> score, changed fraction, bbox"),
    "stats": (op_stats, "{rect} -> size, mean, std, min, max, sharpness (focus)"),
}

# ---- service -------------------------------------------------------------------------

prev_frames = {}


def keyed(key):
    """per-stream state (previous frames for diff / motion), bounded"""
    if key not in prev_frames:
        if len(prev_frames) >= MAX_KEYS:
            prev_frames.pop(next(iter(prev_frames)))
        prev_frames[key] = {}
    return prev_frames[key]


def run_pipeline(args):
    t0 = time.perf_counter()
    img = decode(args["image"])
    ctx = Ctx(img, bool(args.get("annotate")))
    ctx.prev = keyed("run:" + str(args.get("key", "")))
    results = []
    for i, step in enumerate(args.get("ops") or []):
        name = step.get("op")
        if name not in OPS:
            raise ValueError("op %d: unknown op %r (see ops)" % (i, name))
        t = time.perf_counter()
        try:
            res = OPS[name][0](ctx, step)
        except Exception as err:
            raise ValueError("op %d (%s): %s" % (i, name, err))
        res = dict(res, op=name, ms=round((time.perf_counter() - t) * 1000, 2))
        results.append(res)
    out = {"results": results, "size": [img.shape[1], img.shape[0]]}
    if ctx.annotate:
        out["annotated"] = encode(ctx.canvas)
    if args.get("output"):
        out["output"] = encode(ctx.img)
    out["ms"] = round((time.perf_counter() - t0) * 1000, 2)
    return out


def eval_roi(img, roi, state, ctx):
    kind = roi.get("kind")
    p = roi.get("params") or {}
    rect = roi.get("rect")
    if kind == "led":
        region, r = sub(img, rect)
        res = led_state(region, p)
        res.update(value=1 if res["on"] else 0, text=res["color"])
        ctx.rect(r, GREEN if res["on"] else RED, "%s %s" % (roi["name"], res["color"]))
    elif kind == "seven_seg":
        res = seven_seg(img, p if p.get("digits") else dict(p, count=p.get("count", 1)), rect, ctx)
    elif kind == "value_ocr":
        res = ocr(img, dict({"digits": True}, **p), rect)
        ctx.rect(res["rect"], CYAN, "%s %s" % (roi["name"], res["text"][:20]))
    elif kind == "color":
        region, r = sub(img, rect)
        res = color_stats(region)
        res.update(value=res["hsv"][0], text=res["color"])
        ctx.rect(r, CYAN, "%s %s" % (roi["name"], res["color"]))
    elif kind == "motion":
        region, r = sub(img, rect)
        prev = state.get(roi["name"])
        state[roi["name"]] = region.copy()
        res = motion(prev, region, p) if prev is not None and prev.shape == region.shape else {"score": 0.0, "changed": 0.0, "first": True}
        res["value"] = res["changed"]
        moving = res["changed"] >= float(p.get("threshold", 0.02))
        res["text"] = "motion" if moving else "still"
        ctx.rect(r, RED if moving else GREEN, "%s %.3f" % (roi["name"], res["changed"]))
    elif kind == "template":
        if not p.get("template_data"):
            raise ValueError("template roi needs params.template (a lab image name)")
        res = template_match(img, decode(p["template_data"]), p, rect)
        res.update(value=res["score"], text="found" if res["found"] else "missing")
        if "bbox" in res:
            ctx.rect(res["bbox"], GREEN if res["found"] else RED, "%s %.2f" % (roi["name"], res["score"]))
    else:
        raise ValueError("unknown roi kind %r (led, value_ocr, seven_seg, color, motion, template)" % kind)
    return res


def watch_eval(args):
    t0 = time.perf_counter()
    img = decode(args["image"])
    ctx = Ctx(img, bool(args.get("annotate")))
    state = keyed("watch:" + str(args.get("key", "")))
    out = {}
    for roi in args.get("rois") or []:
        t = time.perf_counter()
        try:
            res = eval_roi(img, roi, state, ctx)
        except Exception as err:
            res = {"error": str(err), "value": None, "text": None}
            if roi.get("rect"):
                ctx.rect(clip_rect(roi["rect"], img.shape), RED, "%s: error" % roi.get("name"))
        res["ms"] = round((time.perf_counter() - t) * 1000, 2)
        out[roi.get("name")] = res
    reply = {"rois": out, "size": [img.shape[1], img.shape[0]]}
    if ctx.annotate:
        reply["annotated"] = encode(ctx.canvas, ".jpg" if args.get("jpeg") else ".png")
    reply["ms"] = round((time.perf_counter() - t0) * 1000, 2)
    return reply


def main():
    bridge = Bridge()

    @bridge.command("ops", "op catalog")
    def ops(_args):
        return {name: doc for name, (_fn, doc) in OPS.items()}

    @bridge.command("run", "{image, ops, annotate, output, key}")
    def run(args):
        return run_pipeline(args)

    @bridge.command("watch", "{key, image, rois, annotate}")
    def watch(args):
        return watch_eval(args)

    @bridge.command("forget", "{key} drop a stream's previous frames")
    def forget(args):
        prev_frames.pop("watch:" + str(args.get("key", "")), None)
        prev_frames.pop("run:" + str(args.get("key", "")), None)
        return {"ok": True}

    @bridge.command("versions", "opencv / numpy / tesseract versions")
    def versions(_args):
        try:
            tess = subprocess.run([TESSERACT, "--version"], capture_output=True, timeout=5).stdout.decode().split("\n")[0]
        except (FileNotFoundError, subprocess.TimeoutExpired):
            tess = None
        return {"opencv": cv2.__version__, "numpy": np.__version__, "tesseract": tess}

    bridge.run()


if __name__ == "__main__":
    main()
