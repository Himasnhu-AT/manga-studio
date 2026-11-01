"""Hand-drawn layers on a panel: rough (blue pencil), inks, white-out, anything the artist draws in the Studio.

story.yaml lists them on the panel, bottom to top:
    drawing: [{id: rough, name: Rough, opacity: 0.45}, {id: inks, name: Inks}, {id: l3, name: Effects, visible: false}]
Pixels live in out/<pid>/drawing/<id>.png (RGBA, transparent where nothing is drawn), all the same size.
They sit over the panel's art (or white paper when the panel has no version yet), under lettering, and
everything that renders a panel (Studio, Reader, compose, export) draws them. "Merge" bakes them into a
new version so Refine and the model can use the drawing.
"""

from __future__ import annotations

import base64
import io
import re
from pathlib import Path

from PIL import Image

LAYER_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
MAX_SIDE = 4096


class DrawingError(ValueError):
    pass


def layer_path(story_dir: Path, pid: str, lid: str) -> Path:
    if not LAYER_RE.fullmatch(lid):
        raise DrawingError("layer id: lowercase letters, digits, - or _ (max 32)")
    return story_dir / "out" / pid / "drawing" / f"{lid}.png"


def layers(story_dir: Path, panel: dict) -> list[tuple[dict, Path]]:
    """(layer spec, png path) for each listed layer that has pixels, bottom to top."""
    out = []
    for spec in panel.get("drawing") or []:
        lid = str(spec.get("id", ""))
        if not LAYER_RE.fullmatch(lid):
            continue
        p = story_dir / "out" / panel["id"] / "drawing" / f"{lid}.png"
        if p.exists():
            out.append((spec, p))
    return out


def size(story_dir: Path, panel: dict) -> tuple[int, int] | None:
    """Pixel size of the drawing (its layers share one), or None when nothing is drawn."""
    for _, p in layers(story_dir, panel):
        with Image.open(p) as im:
            return im.size
    return None


def save_layer(story_dir: Path, pid: str, lid: str, data: str) -> Path:
    """A PNG data URL (or bare base64) from the Studio's canvas -> out/<pid>/drawing/<lid>.png."""
    path = layer_path(story_dir, pid, lid)
    try:
        raw = base64.b64decode(data.split(",", 1)[1] if "," in data else data)
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception as e:
        raise DrawingError("layer must be a PNG data URL") from e
    if max(im.size) > MAX_SIDE:
        raise DrawingError(f"layer is larger than {MAX_SIDE}px")
    path.parent.mkdir(parents=True, exist_ok=True)
    im.convert("RGBA").save(path)
    return path


def composite(story_dir: Path, panel: dict, base: Image.Image) -> Image.Image:
    """`base` (RGBA) with every visible layer drawn on top at its opacity, layers scaled to the base."""
    for spec, p in layers(story_dir, panel):
        if spec.get("visible", True) is False:
            continue
        lay = Image.open(p).convert("RGBA")
        if lay.size != base.size:
            lay = lay.resize(base.size, Image.LANCZOS)
        op = float(spec.get("opacity", 1.0))
        if op < 1:
            a = lay.getchannel("A").point(lambda v: int(v * max(0.0, op)))
            lay.putalpha(a)
        base.alpha_composite(lay)
    return base
