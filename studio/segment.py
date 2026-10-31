"""Click-to-select masks for the image editor.

`segment(img, point)` returns the mask of the thing under a click:
  * "vision": Apple's Vision framework (VNGenerateForegroundInstanceMaskRequest, macOS 14+) through pyobjc.
    Runs locally on the Neural Engine, no model download. Finds foreground instances (people, animals, objects).
  * "color": flood fill of similar colours from the click (tolerance 0..1). Works everywhere; used when Vision
    is unavailable, fails, or the click lands on background (no instance there).

Masks are PIL "L" images the size of the input, 255 = selected.
"""

from __future__ import annotations

import io
from functools import lru_cache

import numpy as np
from PIL import Image


@lru_cache(maxsize=1)
def vision_available() -> bool:
    try:
        import Quartz  # noqa: F401
        import Vision

        return hasattr(Vision, "VNGenerateForegroundInstanceMaskRequest")
    except Exception:
        return False


def _vision_labels(img: Image.Image) -> np.ndarray:
    """Instance label map (0 = background, 1..n) at the image's size."""
    import Quartz
    import Vision
    from Foundation import NSData

    buf = io.BytesIO()
    img.convert("RGB").save(buf, "PNG")
    data = buf.getvalue()
    src = Quartz.CGImageSourceCreateWithData(NSData.dataWithBytes_length_(data, len(data)), None)
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    req = Vision.VNGenerateForegroundInstanceMaskRequest.alloc().init()
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, {})
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        raise RuntimeError(f"Vision failed: {err}")
    results = req.results() or []
    if not results:
        return np.zeros((img.height, img.width), np.uint8)
    pb = results[0].instanceMask()
    Quartz.CVPixelBufferLockBaseAddress(pb, 1)
    try:
        w, h = Quartz.CVPixelBufferGetWidth(pb), Quartz.CVPixelBufferGetHeight(pb)
        bpr = Quartz.CVPixelBufferGetBytesPerRow(pb)
        raw = Quartz.CVPixelBufferGetBaseAddress(pb).as_buffer(bpr * h)
        labels = np.frombuffer(raw, np.uint8).reshape(h, bpr)[:, :w].copy()
    finally:
        Quartz.CVPixelBufferUnlockBaseAddress(pb, 1)
    return np.asarray(Image.fromarray(labels).resize(img.size, Image.NEAREST))


_label_cache: dict[str, np.ndarray] = {}


def vision_labels(img: Image.Image, key: str | None = None) -> np.ndarray:
    """Cached by `key` (e.g. file path + mtime) so repeated clicks on one image run Vision once."""
    if key and key in _label_cache:
        return _label_cache[key]
    labels = _vision_labels(img)
    if key:
        if len(_label_cache) > 16:
            _label_cache.clear()
        _label_cache[key] = labels
    return labels


def color_mask(img: Image.Image, point: tuple[float, float], tolerance: float = 0.12) -> np.ndarray:
    """Connected region of similar colour around the click (bool array)."""
    a = np.asarray(img.convert("RGB"), dtype=np.int32)
    h, w = a.shape[:2]
    x = min(w - 1, max(0, int(point[0] * w)))
    y = min(h - 1, max(0, int(point[1] * h)))
    seed = a[y, x]
    thr = max(1.0, float(tolerance) * 441.7)  # 441.7 = max RGB distance
    similar = np.sqrt(((a - seed) ** 2).sum(axis=2)) <= thr
    try:
        import cv2

        n, lab = cv2.connectedComponents(similar.astype(np.uint8), connectivity=4)
        return lab == lab[y, x]
    except ImportError:  # pure numpy BFS (slower, same result)
        out = np.zeros_like(similar)
        stack = [(y, x)]
        while stack:
            cy, cx = stack.pop()
            if out[cy, cx] or not similar[cy, cx]:
                continue
            out[cy, cx] = True
            if cy > 0:
                stack.append((cy - 1, cx))
            if cy < h - 1:
                stack.append((cy + 1, cx))
            if cx > 0:
                stack.append((cy, cx - 1))
            if cx < w - 1:
                stack.append((cy, cx + 1))
        return out


def _bbox(m: np.ndarray, w: int, h: int) -> list[float] | None:
    ys, xs = np.nonzero(m)
    if not len(xs):
        return None
    return [round(xs.min() / w, 4), round(ys.min() / h, 4), round((xs.max() + 1 - xs.min()) / w, 4), round((ys.max() + 1 - ys.min()) / h, 4)]


def segment(img: Image.Image, point: tuple[float, float], method: str = "auto", tolerance: float = 0.12, key: str | None = None) -> dict:
    """Mask of the thing at `point` (fractions). method: auto | vision | color.
    Returns {mask: PIL L, method, instance (index or None), instances: [{index, bbox, area}]}."""
    w, h = img.size
    x = min(w - 1, max(0, int(point[0] * w)))
    y = min(h - 1, max(0, int(point[1] * h)))
    instances: list[dict] = []
    if method in ("auto", "vision") and vision_available():
        try:
            labels = vision_labels(img, key)
            for i in range(1, int(labels.max()) + 1):
                m = labels == i
                if m.any():
                    instances.append({"index": i, "bbox": _bbox(m, w, h), "area": round(float(m.mean()), 4)})
            hit = int(labels[y, x])
            if hit:
                return {"mask": Image.fromarray(np.where(labels == hit, 255, 0).astype(np.uint8)), "method": "vision", "instance": hit, "instances": instances}
        except Exception:
            if method == "vision":
                raise
    elif method == "vision":
        raise RuntimeError("Apple Vision isn't available here (needs macOS 14+ and pyobjc)")
    m = color_mask(img, point, tolerance)
    return {"mask": Image.fromarray(np.where(m, 255, 0).astype(np.uint8)), "method": "color", "instance": None, "instances": instances}
