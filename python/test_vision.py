"""Vision bridge regression on synthetic images (run by jest: src/vision/__tests__).

Prints "ok <name>" per passing check, "skip <name>: reason" for checks whose
tools are missing (tesseract); exits non-zero on the first failure.
"""

import base64
import json
import os
import shutil
import subprocess
import sys

import cv2
import numpy as np

import vision_bridge as vb

HERE = os.path.dirname(os.path.abspath(__file__))

# segment polygons for a digit at (x, y) of size w x h (thickness t)
SEG_RECTS = {
    "a": lambda x, y, w, h, t: (x + t, y, w - 2 * t, t),
    "b": lambda x, y, w, h, t: (x + w - t, y + t, t, h // 2 - t),
    "c": lambda x, y, w, h, t: (x + w - t, y + h // 2, t, h // 2 - t),
    "d": lambda x, y, w, h, t: (x + t, y + h - t, w - 2 * t, t),
    "e": lambda x, y, w, h, t: (x, y + h // 2, t, h // 2 - t),
    "f": lambda x, y, w, h, t: (x, y + t, t, h // 2 - t),
    "g": lambda x, y, w, h, t: (x + t, y + h // 2 - t // 2, w - 2 * t, t),
}
CHAR_SEGS = {"0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg", "5": "acdfg", "6": "acdefg",
             "7": "abc", "8": "abcdefg", "9": "abcdfg", "E": "adefg", "r": "eg", "-": "g", " ": ""}


def b64(img, fmt=".png"):
    return base64.b64encode(cv2.imencode(fmt, img)[1].tobytes()).decode()


def check(name, cond, detail=""):
    if not cond:
        print("FAIL %s %s" % (name, detail))
        sys.exit(1)
    print("ok " + name)


def display(text, led_on=False, led_color=(0, 255, 0), size=(480, 200)):
    """an instrument front: 7-segment digits (red on black) and a status LED"""
    img = np.full((size[1], size[0], 3), 30, np.uint8)
    cv2.rectangle(img, (20, 20), (340, 140), (10, 10, 10), -1)
    boxes = []
    for i, ch in enumerate(text):
        x, y, w, h = 40 + i * 75, 35, 55, 90
        boxes.append([x, y, w, h])
        for seg in CHAR_SEGS[ch]:
            sx, sy, sw, sh = SEG_RECTS[seg](x, y, w, h, 10)
            cv2.rectangle(img, (sx, sy), (sx + sw - 1, sy + sh - 1), (40, 40, 255), -1)
    color = led_color if led_on else (40, 50, 40)
    cv2.circle(img, (410, 80), 14, color, -1)
    return img, boxes


def ctx_for(img):
    return vb.Ctx(img, True)


def test_seven_seg():
    img, boxes = display("1234")
    res = vb.op_seven_seg(ctx_for(img), {"digits": boxes})
    check("seven_seg digits", res["text"] == "1234" and res["value"] == 1234.0, res)
    img, boxes = display("Err ")
    res = vb.op_seven_seg(ctx_for(img), {"digits": boxes})
    check("seven_seg Err", res["text"] == "Err", res)
    img, boxes = display("-907")
    res = vb.op_seven_seg(ctx_for(img), {"rect": [boxes[0][0] - 10, 35, 4 * 75, 90], "count": 4, "gap": 0.27})
    check("seven_seg rect+count", res["text"] == "-907", res)
    res = vb.op_seven_seg(ctx_for(img), {"digits": boxes, "dp": 1})
    check("seven_seg dp", res["text"] == "-9.07" and abs(res["value"] + 9.07) < 1e-9, res)


def test_led():
    on, _b = display("8888", led_on=True)
    off, _b = display("8888", led_on=False)
    rect = [390, 60, 40, 40]
    a = vb.op_led(ctx_for(on), {"rect": rect})
    b = vb.op_led(ctx_for(off), {"rect": rect})
    check("led on green", a["on"] and a["color"] == "green", a)
    check("led off", not b["on"], b)
    red, _b = display("8888", led_on=True, led_color=(0, 0, 255))
    c = vb.op_led(ctx_for(red), {"rect": rect})
    d = vb.op_led(ctx_for(red), {"rect": rect, "color": "green"})
    check("led red / wrong colour", c["color"] == "red" and not d["on"], (c, d))


def test_color_contours():
    img = np.zeros((200, 300, 3), np.uint8)
    cv2.rectangle(img, (20, 30), (79, 89), (255, 0, 0), -1)
    cv2.circle(img, (200, 100), 30, (0, 255, 255), -1)
    col = vb.op_color(ctx_for(img), {"rect": [25, 35, 40, 40]})
    check("color blue", col["color"] == "blue" and col["rgb"][2] > 250, col)
    res = vb.op_contours(ctx_for(img), {"threshold": 10})
    check("contours", res["count"] == 2 and res["contours"][0]["bbox"] == [20, 30, 60, 60], res)
    sq = [c for c in res["contours"] if c["bbox"][0] == 20][0]
    check("contour centroid", abs(sq["centroid"][0] - 49.5) < 1 and abs(sq["centroid"][1] - 59.5) < 1, sq)


def textured(seed, size=(400, 300)):
    rng = np.random.default_rng(seed)
    img = np.full((size[1], size[0], 3), 200, np.uint8)
    for _ in range(60):
        x, y = int(rng.integers(0, size[0])), int(rng.integers(0, size[1]))
        color = tuple(int(c) for c in rng.integers(0, 255, 3))
        if rng.random() < 0.5:
            cv2.circle(img, (x, y), int(rng.integers(5, 25)), color, -1)
        else:
            cv2.rectangle(img, (x, y), (x + int(rng.integers(5, 40)), y + int(rng.integers(5, 40))), color, -1)
    return img


def test_template():
    scene = textured(1)
    tmpl = scene[100:160, 150:230].copy()
    big = cv2.resize(scene, None, fx=1.25, fy=1.25)
    res = vb.op_template(ctx_for(big), {"template_data": b64(tmpl), "scales": [0.8, 1.6, 17]})
    ok = res["found"] and abs(res["scale"] - 1.25) < 0.06 and abs(res["bbox"][0] - 187) <= 3 and abs(res["bbox"][1] - 125) <= 3
    check("template multi-scale", ok, res)
    missing = vb.op_template(ctx_for(textured(2)), {"template_data": b64(tmpl), "scales": [1.0]})
    check("template absent", not missing["found"], missing)


def test_warp_roundtrip():
    src = textured(3)
    h, w = src.shape[:2]
    corners = np.float32([[40, 30], [370, 10], [390, 280], [20, 260]])
    m = cv2.getPerspectiveTransform(np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]]), corners)
    photo = cv2.warpPerspective(src, m, (w + 20, h + 20), borderValue=(0, 0, 0))
    ctx = ctx_for(photo)
    vb.op_warp(ctx, {"points": corners.tolist(), "width": w, "height": h})
    err = float(np.abs(ctx.img.astype(int)[5:-5, 5:-5] - src.astype(int)[5:-5, 5:-5]).mean())
    check("warp roundtrip", ctx.img.shape == src.shape and err < 12, err)


def test_align():
    ref = textured(4)
    h, w = ref.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), 8, 0.9)
    moved = cv2.warpAffine(ref, m, (w, h), borderValue=(200, 200, 200))
    ctx = ctx_for(moved)
    res = vb.op_align(ctx, {"reference_data": b64(ref)})
    err = float(np.abs(ctx.img.astype(int)[40:-40, 40:-40] - ref.astype(int)[40:-40, 40:-40]).mean())
    check("align ORB homography", res["inliers"] >= 20 and err < 15, (res["inliers"], err))


def test_aruco_measure():
    marker = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50), 7, 100)
    img = np.full((300, 400), 255, np.uint8)
    img[50:150, 60:160] = marker
    img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    ctx = ctx_for(img)
    res = vb.op_aruco(ctx, {"dict": "4X4_50", "marker_mm": 50})
    check("aruco detect", res["count"] == 1 and res["markers"][0]["id"] == 7, res)
    check("aruco scale", abs(res["mm_per_px"] - 0.5) < 0.02, res["mm_per_px"])
    check("aruco pose", "tvec_mm" in res["markers"][0] and res["markers"][0]["tvec_mm"][2] > 0, res["markers"][0])
    m = vb.op_measure(ctx, {"points": [[0, 0], [300, 400]]})
    check("measure mm", abs(m["px"] - 500) < 1e-6 and abs(m["mm"] - 250) < 10, m)


def test_diff():
    a = textured(5)
    b = a.copy()
    cv2.rectangle(b, (100, 100), (140, 140), (0, 0, 0), -1)
    ctx = ctx_for(a)
    first = vb.op_diff(ctx, {})
    ctx.img = b
    second = vb.op_diff(ctx, {})
    check("diff previous frame", first.get("first") and second["changed"] > 0.005, (first, second))
    bb = second["bbox"]
    check("diff bbox", 95 <= bb[0] <= 105 and 95 <= bb[1] <= 105, bb)


def test_ocr():
    if not shutil.which(vb.TESSERACT):
        print("skip ocr: tesseract missing")
        return
    img = np.full((80, 320, 3), 255, np.uint8)
    cv2.putText(img, "12.34", (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.8, (0, 0, 0), 4, cv2.LINE_AA)
    res = vb.op_ocr(ctx_for(img), {"digits": True})
    check("ocr digits", res["value"] == 12.34, res)
    img = np.full((80, 360, 3), 20, np.uint8)
    cv2.putText(img, "ERROR", (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.8, (255, 255, 255), 4, cv2.LINE_AA)
    res = vb.op_ocr(ctx_for(img), {})
    check("ocr text (light on dark)", res["text"] == "ERROR", res)


def test_watch_eval():
    on, boxes = display("0042", led_on=True)
    off, _b = display("0043", led_on=False)
    rois = [
        {"name": "led", "rect": [390, 60, 40, 40], "kind": "led"},
        {"name": "num", "rect": [30, 35, 300, 90], "kind": "seven_seg", "params": {"digits": boxes}},
        {"name": "mov", "rect": [0, 0, 480, 200], "kind": "motion"},
        {"name": "bad", "rect": [0, 0, 10, 10], "kind": "nope"},
    ]
    r1 = vb.watch_eval({"key": "t", "image": b64(on), "rois": rois, "annotate": True})
    r2 = vb.watch_eval({"key": "t", "image": b64(off), "rois": rois, "annotate": False})
    check("watch led", r1["rois"]["led"]["value"] == 1 and r2["rois"]["led"]["value"] == 0, (r1["rois"]["led"], r2["rois"]["led"]))
    check("watch seven_seg", r1["rois"]["num"]["value"] == 42 and r2["rois"]["num"]["text"] == "0043", r2["rois"]["num"])
    check("watch motion", r1["rois"]["mov"].get("first") and r2["rois"]["mov"]["value"] > 0, r2["rois"]["mov"])
    check("watch roi error isolated", "error" in r1["rois"]["bad"] and r1["annotated"] and "annotated" not in r2, r1["rois"]["bad"])


def test_protocol():
    """the bridge as the lab runs it: JSON lines on stdio"""
    img, boxes = display("5678", led_on=True)
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "vision_bridge.py")], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, cwd=HERE)
    req = {"id": 1, "command": "run", "args": {"image": b64(img, ".jpg"), "annotate": True,
                                                "ops": [{"op": "seven_seg", "digits": boxes}, {"op": "led", "rect": [390, 60, 40, 40]}]}}
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.write(json.dumps({"id": 2, "command": "ops"}) + "\n")
    proc.stdin.flush()
    replies = {}
    while len(replies) < 2:
        msg = json.loads(proc.stdout.readline())
        if msg.get("type") == "result":
            replies[msg["id"]] = msg
    proc.stdin.close()
    proc.wait(timeout=10)
    res = replies[1]["result"]
    check("protocol run", res["results"][0]["text"] == "5678" and res["results"][1]["on"] and res["annotated"], replies[1].get("error"))
    check("protocol ops", "seven_seg" in replies[2]["result"] and "aruco" in replies[2]["result"])


if __name__ == "__main__":
    test_seven_seg()
    test_led()
    test_color_contours()
    test_template()
    test_warp_roundtrip()
    test_align()
    test_aruco_measure()
    test_diff()
    test_ocr()
    test_watch_eval()
    test_protocol()
    print("all ok")
