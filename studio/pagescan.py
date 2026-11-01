"""Find the panels on a scanned or exported manga page.

Gutters are the light paper that connects to the page edge. Everything the gutter flood can't reach is
inside a panel (its border, art and white interior), so each large connected region left over is a panel.
Works for bordered panels on white paper, which is how most hand-drawn pages are made. Known limits, left
for the artist to fix in the review step: panels that touch with no gutter, or a bubble bridging two panels,
come out as one box; a bleed panel whose white art reaches the page edge can be missed.
"""

from __future__ import annotations

from collections import deque

import numpy as np
from PIL import Image

WORK_SIDE = 1000  # detect on a downscaled copy; boxes come back as fractions
LIGHT = 215  # gray level counted as paper
MIN_AREA = 0.012  # a panel covers at least this much of the page
MIN_SIDE = 0.06  # and is at least this wide and tall


def _flood_from_edges(light: np.ndarray) -> np.ndarray:
    """Light pixels 4-connected to the image border."""
    h, w = light.shape
    try:
        import cv2

        n, lab = cv2.connectedComponents(light.astype(np.uint8), connectivity=4)
        edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])).tolist()) - {0}
        return np.isin(lab, list(edge)) & light
    except ImportError:
        seen = np.zeros_like(light)
        q = deque()
        for x in range(w):
            for y in (0, h - 1):
                if light[y, x] and not seen[y, x]:
                    seen[y, x] = True
                    q.append((y, x))
        for y in range(h):
            for x in (0, w - 1):
                if light[y, x] and not seen[y, x]:
                    seen[y, x] = True
                    q.append((y, x))
        while q:
            y, x = q.popleft()
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < h and 0 <= nx < w and light[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        return seen


def _components(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    """(x0, y0, x1, y1, area) of each 8-connected True region."""
    try:
        import cv2

        n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
        return [(int(x), int(y), int(x + w), int(y + h), int(a)) for x, y, w, h, a in stats[1:]]
    except ImportError:
        h, w = mask.shape
        seen = np.zeros_like(mask)
        out = []
        for sy, sx in zip(*np.nonzero(mask)):
            if seen[sy, sx]:
                continue
            q = deque([(sy, sx)])
            seen[sy, sx] = True
            x0 = x1 = sx
            y0 = y1 = sy
            area = 0
            while q:
                y, x = q.popleft()
                area += 1
                x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            q.append((ny, nx))
            out.append((int(x0), int(y0), int(x1 + 1), int(y1 + 1), area))
        return out


def reading_order(boxes: list[list[float]], rtl: bool) -> list[list[float]]:
    """Top-to-bottom rows, then right-to-left (manga) or left-to-right within a row (layout.ts orderSlots)."""
    import functools

    def cmp(a, b):
        overlap = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
        if overlap > min(a[3], b[3]) * 0.4:
            ca, cb = a[0] + a[2] / 2, b[0] + b[2] / 2
            d = cb - ca if rtl else ca - cb
            return -1 if d < 0 else (1 if d > 0 else 0)
        return -1 if a[1] < b[1] else (1 if a[1] > b[1] else 0)

    return sorted(boxes, key=functools.cmp_to_key(cmp))


def detect_panels(img: Image.Image, rtl: bool = True) -> list[dict]:
    """Panels on a page image: [{box: [x, y, w, h] fractions of the image, unclear: bool}] in reading order.
    `unclear` marks a box that is probably two panels merged (much bigger than its neighbours, or not
    rectangular), so the review step can point at it."""
    g = img.convert("L")
    f = WORK_SIDE / max(g.size)
    if f < 1:
        g = g.resize((max(1, round(g.width * f)), max(1, round(g.height * f))), Image.BILINEAR)
    a = np.asarray(g)
    h, w = a.shape
    paper = _flood_from_edges(a >= LIGHT)
    found = []
    for x0, y0, x1, y1, area in _components(~paper):
        bw, bh = (x1 - x0) / w, (y1 - y0) / h
        if bw * bh < MIN_AREA or bw < MIN_SIDE or bh < MIN_SIDE:
            continue  # page numbers, notes in the margin, specks
        fill = area / max(1, (x1 - x0) * (y1 - y0))  # a bordered rectangle fills its box
        found.append({"box": [round(x0 / w, 4), round(y0 / h, 4), round(bw, 4), round(bh, 4)], "fill": fill})
    if not found:
        return []
    areas = sorted(b["box"][2] * b["box"][3] for b in found)
    median = areas[len(areas) // 2]
    out = []
    for b in found:
        big = len(found) > 2 and b["box"][2] * b["box"][3] > 2.6 * median
        out.append({"box": b["box"], "unclear": bool(big or b["fill"] < 0.8)})
    order = reading_order([o["box"] for o in out], rtl)
    return sorted(out, key=lambda o: order.index(o["box"]))
