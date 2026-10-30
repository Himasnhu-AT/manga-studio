"""Collision-free auto-lettering: put bubbles where the art is quiet, away from faces and each other.

Salience = edge energy + local variance of the picked image on a coarse grid. Each bubble's real size
comes from `compose.bubble_geometry` (same font, same wrap), so what we place is what gets drawn.
`protect` boxes ([x, y, w, h] fractions, usually faces) are hard-ish obstacles; the tail points at the
nearest one, since that's most likely the speaker.
"""

from __future__ import annotations

import math

import numpy as np
from PIL import Image

from studio import project
from studio.compose import bubble_geometry
from studio.story import Story, picked_version

GRID = 64  # salience grid columns


def _size(story: Story, pid: str) -> tuple[int, int, Image.Image | None]:
    v = picked_version(story, pid)
    if v:
        img = Image.open(story.dir / "out" / pid / v)
        return img.width, img.height, img
    s = story.settings(story.panel(pid))
    return int(s["width"]), int(s["height"]), None


def salience(img: Image.Image | None, cols: int = GRID) -> np.ndarray:
    """rows x cols map in 0..1 (1 = busy). A missing image is uniformly quiet."""
    if img is None:
        return np.zeros((int(cols * 4 / 3), cols))
    rows = max(8, int(cols * img.height / img.width))
    g = np.asarray(img.convert("L").resize((cols * 4, rows * 4), Image.BILINEAR), dtype=np.float32) / 255.0
    gx = np.abs(np.diff(g, axis=1, prepend=g[:, :1]))
    gy = np.abs(np.diff(g, axis=0, prepend=g[:1, :]))
    edge = (gx + gy).reshape(rows, 4, cols, 4).mean(axis=(1, 3))
    var = g.reshape(rows, 4, cols, 4).std(axis=(1, 3))
    # dark areas are also bad for white bubbles less than busy ones; a little weight keeps them off hair/clothes
    dark = 1 - g.reshape(rows, 4, cols, 4).mean(axis=(1, 3))
    m = edge * 3 + var * 2 + dark * 0.15
    return m / (m.max() or 1)


def _box_frac(g: dict, W: int, H: int) -> list[float]:
    x0, y0, x1, y1 = g["box"]
    return [x0 / W, y0 / H, x1 / W, y1 / H]


def _inter(a, b) -> float:
    """Intersection area of two [x0, y0, x1, y1] boxes."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return max(0.0, w) * max(0.0, h)


def _xyxy(box) -> list[float]:
    x, y, w, h = box
    return [x, y, x + w, y + h]


def _mean_under(sal: np.ndarray, box) -> float:
    rows, cols = sal.shape
    x0, y0 = int(max(0, box[0]) * cols), int(max(0, box[1]) * rows)
    x1, y1 = int(math.ceil(min(1, box[2]) * cols)), int(math.ceil(min(1, box[3]) * rows))
    cell = sal[y0:max(y1, y0 + 1), x0:max(x1, x0 + 1)]
    return float(cell.mean()) if cell.size else 1.0


def _tail(b_center, bbox, protect: list[list[float]]):
    """Tip just outside the nearest protect box (the speaker's face); else down toward the panel centre."""
    cx, cy = b_center
    if protect:
        def dist(p):
            return math.hypot((p[0] + p[2]) / 2 - cx, (p[1] + p[3]) / 2 - cy)

        p = min(protect, key=dist)
        tx, ty = (p[0] + p[2]) / 2, p[1] + (p[3] - p[1]) * 0.35
        # walk from the bubble toward the face; stop right before entering the face box
        tip = (tx, ty)
        for t in np.linspace(0, 1, 60):
            x, y = cx + (tx - cx) * t, cy + (ty - cy) * t
            if p[0] <= x <= p[2] and p[1] <= y <= p[3]:
                break
            tip = (x, y)
    else:
        tip = (cx + (0.5 - cx) * 0.3, bbox[3] + 0.08)
    x, y = min(0.98, max(0.02, tip[0])), min(0.98, max(0.02, tip[1]))
    # a tip inside the bubble draws nothing useful: push it just past the bottom edge instead
    if bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3]:
        y = min(0.98, bbox[3] + 0.05)
    return [round(float(x), 3), round(float(y), 3)]


def plan_positions(bubbles: list[dict], W: int, H: int, sal: np.ndarray, protect: list, direction: str = "rtl", overwrite: bool = False) -> list[dict]:
    """Pure placement (no I/O). Returns new bubble dicts; untouched bubbles are returned as-is."""
    prot = [_xyxy(p) for p in protect]
    placed: list[list[float]] = []
    todo = []
    out = [dict(b) for b in bubbles]
    for i, b in enumerate(out):
        if b.get("at") and not overwrite:
            placed.append(_box_frac(bubble_geometry(b, W, H), W, H))
        else:
            todo.append(i)
    n = len(todo)
    for k, i in enumerate(todo):
        b = out[i]
        g0 = bubble_geometry({**b, "at": [0.5, 0.5]}, W, H)
        bw, bh = (g0["box"][2] - g0["box"][0]) / W, (g0["box"][3] - g0["box"][1]) / H
        # reading order: first bubble top-right for rtl (top-left for ltr), later ones step across and down
        frac = (k + 0.5) / max(n, 1)
        tx = 1 - frac if direction == "rtl" else frac
        ty = 0.12 + 0.5 * k / max(n, 1)
        best, best_cost = None, float("inf")
        m = 0.015
        for cy in np.arange(m + bh / 2, 1 - m - bh / 2 + 1e-9, 0.02):
            for cx in np.arange(m + bw / 2, 1 - m - bw / 2 + 1e-9, 0.02):
                box = [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2]
                area = bw * bh
                cost = _mean_under(sal, box) * 2.0
                cost += sum(_inter(box, p) for p in prot) / area * 8
                cost += sum(_inter(box, p) for p in placed) / area * 12
                cost += 0.35 * abs(cx - tx) + 0.45 * abs(cy - ty)
                if cost < best_cost:
                    best, best_cost = (cx, cy, box), cost
        if best is None:  # bubble bigger than the panel: centre it at the top
            best = (0.5, min(0.5, bh / 2), [0.5 - bw / 2, 0, 0.5 + bw / 2, bh])
        cx, cy, box = best
        b["at"] = [round(float(cx), 3), round(float(cy), 3)]
        if b.get("style", "speech") != "caption" and (overwrite or not b.get("tail")):
            b["tail"] = _tail((cx, cy), box, prot)
        placed.append(box)
    return out


def _same_bubble(a, b) -> bool:
    if a.get("id") or b.get("id"):
        return a.get("id") == b.get("id")
    return a.get("text") == b.get("text")


def auto_letter(story: Story, pid: str, overwrite: bool = False) -> int:
    """Place bubbles that have no `at` (all of them with overwrite=True). Returns how many were placed.

    Planning reads a snapshot and can take seconds, while the user may be dragging bubbles in the
    Studio. So the write only touches the planned targets, matched by id (or text) in the fresh
    file, and skips any that were placed or removed in the meantime."""
    panel = story.panel(pid)
    bubbles = panel.get("bubbles") or []
    targets = [i for i, b in enumerate(bubbles) if overwrite or not b.get("at")]
    if not targets:
        return 0
    W, H, img = _size(story, pid)
    new = plan_positions(bubbles, W, H, salience(img), panel.get("protect") or [], story.format.get("direction", "rtl"), overwrite)
    written = 0
    with project.edit(story.slug) as data:
        cur = project.panel(data, pid).get("bubbles") or []
        for i in targets:
            planned, nb = bubbles[i], new[i]
            # same index first (the common case), else the first bubble that is the same one
            match = cur[i] if i < len(cur) and _same_bubble(cur[i], planned) else next((c for c in cur if _same_bubble(c, planned)), None)
            if match is None or (not overwrite and match.get("at")):
                continue  # deleted, or the user placed it while we were planning
            if overwrite and match.get("at") != planned.get("at"):
                continue  # the user moved it while we were planning: their position wins
            match["at"] = project.from_plain(nb["at"])
            if nb.get("tail") is not None:
                match["tail"] = project.from_plain(nb["tail"])
            written += 1
    return written


def overlap_issues(story: Story, pid: str) -> list[str]:
    """Geometric QA: bubbles covering protect boxes, each other, or running off the panel."""
    panel = story.panel(pid)
    W, H, _ = _size(story, pid)
    issues: list[str] = []
    boxes = []
    for i, b in enumerate(panel.get("bubbles") or []):
        name = b.get("id") or f"bubble {i + 1}"
        if not b.get("at"):
            issues.append(f"{name} has no position")
            continue
        box = _box_frac(bubble_geometry(b, W, H), W, H)
        boxes.append((name, box))
        if box[0] < -0.02 or box[1] < -0.02 or box[2] > 1.02 or box[3] > 1.02:
            issues.append(f"{name} runs off the panel")
    for j, pr in enumerate(panel.get("protect") or []):
        p = _xyxy(pr)
        pa = max(1e-6, (p[2] - p[0]) * (p[3] - p[1]))
        for name, box in boxes:
            if _inter(box, p) / pa > 0.05:
                issues.append(f"{name} covers protected area {j + 1} (face)")
    for a in range(len(boxes)):
        for b in range(a + 1, len(boxes)):
            (na, ba), (nb, bb) = boxes[a], boxes[b]
            small = min((ba[2] - ba[0]) * (ba[3] - ba[1]), (bb[2] - bb[0]) * (bb[3] - bb[1]))
            if small > 0 and _inter(ba, bb) / small > 0.08:
                issues.append(f"{na} overlaps {nb}")
    return issues
