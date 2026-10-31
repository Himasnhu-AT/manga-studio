"""Non-destructive image edits as a list of JSON ops (the app, the CLI and agents send the same list).

    ops = [
      {"op": "mask", "id": "m1", "point": [0.4, 0.6]},            # segment the thing under a point
      {"op": "mask", "id": "m1", "rect": [0.1, 0.1, 0.2, 0.2], "mode": "add"},
      {"op": "move", "mask": "m1", "dx": 0.1, "dy": 0, "scale": 1.2, "rotate": 15, "flip": "h"},
      {"op": "erase", "mask": "m1"},
      {"op": "crop", "box": [0.05, 0, 0.9, 1]},
      {"op": "rotate", "deg": 90},
      {"op": "flip", "axis": "h"},
      {"op": "adjust", "brightness": 1.1, "contrast": 1.05, "saturation": 0.9, "mask": "m1"},
    ]

Coordinates are fractions of the image as it is when the op runs (after earlier crops/rotations).
A `mask` field is a mask id defined by an earlier `mask` op, or an inline spec ({"png"|"point"|"rect"|"poly"}).
Named masks follow crop/rotate/flip so they stay on the same pixels.

Generative ops (`fix`, `extend`, `erase` with fill "model") need the model: studio/server.py runs the pixel
ops here, saves the result as a version, then queues an inpaint/img2img job from it.
"""

from __future__ import annotations

import base64
import io
from typing import Callable

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

from studio import segment as seg

PIXEL_OPS = {"mask", "move", "erase", "crop", "rotate", "flip", "adjust", "extend"}
MODEL_OPS = {"fix", "redraw"}


class EditError(ValueError):
    pass


# ---- masks --------------------------------------------------------------------------


def decode_png(data: str) -> Image.Image:
    """PNG data URL (or bare base64) -> L mask. Painted strokes on transparency use alpha; else luminance."""
    try:
        raw = base64.b64decode(data.split(",", 1)[1] if "," in data else data)
        m = Image.open(io.BytesIO(raw))
        m.load()
    except Exception as e:
        raise EditError("mask png must be a PNG data URL (white = selected)") from e
    if m.mode in ("RGBA", "LA", "PA") or (m.mode == "P" and "transparency" in m.info):
        m = m.convert("RGBA")
        a = np.asarray(m.getchannel("A"))
        lum = np.asarray(m.convert("L"))
        return Image.fromarray(np.where((a > 127) & ((lum > 0) | (lum.max() == 0)), 255, 0).astype(np.uint8))
    return m.convert("L")


def encode_png(mask: np.ndarray | Image.Image) -> str:
    im = mask if isinstance(mask, Image.Image) else Image.fromarray(np.where(mask, 255, 0).astype(np.uint8))
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _rect(box, w, h) -> np.ndarray:
    x, y, bw, bh = [float(v) for v in box]
    m = np.zeros((h, w), bool)
    x0, y0 = max(0, int(round(x * w))), max(0, int(round(y * h)))
    x1, y1 = min(w, int(round((x + bw) * w))), min(h, int(round((y + bh) * h)))
    m[y0:y1, x0:x1] = True
    return m


def _poly(pts, w, h) -> np.ndarray:
    if len(pts) < 3:
        raise EditError("poly needs at least 3 points")
    im = Image.new("L", (w, h), 0)
    ImageDraw.Draw(im).polygon([(float(px) * w, float(py) * h) for px, py in pts], fill=255)
    return np.asarray(im) > 127


class Ctx:
    def __init__(self, img: Image.Image, load_file: Callable[[str], Image.Image] | None = None, cache_key: str | None = None):
        self.img = img.convert("RGB")
        self.masks: dict[str, np.ndarray] = {}
        self.holes = np.zeros((self.img.height, self.img.width), bool)  # regions the model should repaint
        self.load_file = load_file
        self.cache_key = cache_key  # Vision labels cache: valid only until the first pixel change
        self.changed = False

    @property
    def size(self):
        return self.img.size

    def mask(self, spec, required=True) -> np.ndarray | None:
        w, h = self.size
        if spec is None:
            if required:
                raise EditError("this op needs a mask (a mask id or {png|point|rect|poly})")
            return None
        if isinstance(spec, str):
            if spec in self.masks:
                return self.masks[spec]
            if spec.startswith("data:"):
                return self._fit(decode_png(spec))
            raise EditError(f"unknown mask {spec!r} (defined: {', '.join(self.masks) or 'none'})")
        if isinstance(spec, list) and len(spec) == 4 and all(isinstance(v, (int, float)) for v in spec):
            return _rect(spec, w, h)
        if not isinstance(spec, dict):
            raise EditError(f"bad mask spec {spec!r}")
        if "png" in spec:
            p = spec["png"]
            if isinstance(p, str) and p.startswith("data:"):
                return self._fit(decode_png(p))
            if not self.load_file:
                raise EditError("mask files can't be loaded here")
            return self._fit(self.load_file(str(p)).convert("L"))
        if "rect" in spec:
            return _rect(spec["rect"], w, h)
        if "poly" in spec:
            return _poly(spec["poly"], w, h)
        if "point" in spec:
            key = None if self.changed else self.cache_key
            r = seg.segment(self.img, tuple(spec["point"]), spec.get("method", "auto"), float(spec.get("tolerance", 0.12)), key=key)
            return np.asarray(r["mask"]) > 127
        if "id" in spec:
            return self.mask(spec["id"])
        raise EditError(f"bad mask spec {spec!r}")

    def _fit(self, m: Image.Image) -> np.ndarray:
        if m.size != self.size:
            m = m.resize(self.size, Image.NEAREST)
        return np.asarray(m) > 127

    def geometry(self, fn: Callable[[Image.Image], Image.Image]):
        """Apply a geometric transform to the image and every tracked mask."""
        self.img = fn(self.img)
        for k, m in list(self.masks.items()):
            self.masks[k] = np.asarray(fn(Image.fromarray(np.where(m, 255, 0).astype(np.uint8)))) > 127
        self.holes = np.asarray(fn(Image.fromarray(np.where(self.holes, 255, 0).astype(np.uint8)))) > 127
        self.changed = True


# ---- fill ------------------------------------------------------------------------------


def fill(img: Image.Image, hole: np.ndarray) -> Image.Image:
    """Fast local fill of `hole` from its surroundings (OpenCV Telea inpaint; PIL diffusion if cv2 is missing)."""
    if not hole.any():
        return img
    w, h = img.size
    big = Image.fromarray(np.where(hole, 255, 0).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))
    try:
        import cv2

        arr = np.asarray(img.convert("RGB"))
        hm = np.asarray(big)
        frac = hole.mean()
        if frac > 0.01 and min(w, h) > 256:  # large holes: inpaint at quarter size (Telea is O(hole area))
            f = 4
            small = cv2.resize(arr, (w // f, h // f), interpolation=cv2.INTER_AREA)
            sm = (cv2.resize(hm, (w // f, h // f), interpolation=cv2.INTER_NEAREST) > 0).astype(np.uint8) * 255
            sm = cv2.dilate(sm, np.ones((3, 3), np.uint8))
            filled = cv2.inpaint(small, sm, 3, cv2.INPAINT_TELEA)
            up = cv2.resize(filled, (w, h), interpolation=cv2.INTER_CUBIC)
            soft = cv2.GaussianBlur(hm, (0, 0), 2).astype(np.float32)[..., None] / 255
            out = arr * (1 - soft) + up * soft
            return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
        return Image.fromarray(cv2.inpaint(arr, hm, 5, cv2.INPAINT_TELEA))
    except ImportError:
        return _diffuse(img, np.asarray(big) > 127)


def _diffuse(img: Image.Image, hole: np.ndarray) -> Image.Image:
    """Repeated blur that only writes into the hole: known pixels bleed inward."""
    out = img.convert("RGB")
    keep = Image.fromarray(np.where(hole, 0, 255).astype(np.uint8))
    a = np.asarray(out).astype(np.float32)
    a[hole] = a[~hole].mean(axis=0) if (~hole).any() else 128
    cur = Image.fromarray(a.astype(np.uint8))
    for r in (32, 16, 8, 4, 2, 1):
        for _ in range(3):
            cur = Image.composite(out, cur.filter(ImageFilter.GaussianBlur(r)), keep)
    return cur


# ---- ops ---------------------------------------------------------------------------------


def _bbox(m: np.ndarray):
    ys, xs = np.nonzero(m)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _moves(ctx: Ctx, ops: list[dict]):
    """A run of consecutive moves is one rearrangement: every piece is lifted from the same image, the holes
    are filled once, then the pieces are pasted in list order (later = on top)."""
    w, h = ctx.size
    base = ctx.img.convert("RGBA")
    pieces, hole = [], np.zeros((h, w), bool)
    for op in ops:
        m = ctx.mask(op.get("mask"))
        bb = _bbox(m)
        if bb is None:
            continue
        x0, y0, x1, y1 = bb
        alpha = Image.fromarray(np.where(m, 255, 0).astype(np.uint8))
        piece = base.copy()
        piece.putalpha(alpha)
        piece = piece.crop(bb)
        flip = op.get("flip")
        if flip in ("h", "x", "horizontal"):
            piece = ImageOps.mirror(piece)
        elif flip in ("v", "y", "vertical"):
            piece = ImageOps.flip(piece)
        elif flip:
            raise EditError("flip must be h or v")
        s = float(op.get("scale", 1) or 1)
        if not 0.05 <= s <= 10:
            raise EditError("scale must be between 0.05 and 10")
        if s != 1:
            piece = piece.resize((max(1, round(piece.width * s)), max(1, round(piece.height * s))), Image.LANCZOS)
        rot = float(op.get("rotate", 0) or 0)
        if rot:
            piece = piece.rotate(-rot, Image.BICUBIC, expand=True)  # positive = clockwise, like CSS
        cx = (x0 + x1) / 2 + float(op.get("dx", 0)) * w
        cy = (y0 + y1) / 2 + float(op.get("dy", 0)) * h
        pieces.append((piece, round(cx - piece.width / 2), round(cy - piece.height / 2)))
        if op.get("fill", "local") != "none":
            hole |= m
            if op.get("fill") == "model":
                ctx.holes |= m
    out = fill(ctx.img, hole).convert("RGBA")
    for piece, px, py in pieces:
        layer = Image.new("RGBA", out.size, (0, 0, 0, 0))
        layer.paste(piece, (px, py), piece)
        out = Image.alpha_composite(out, layer)
        # what was pasted is solid art now: the model must not repaint it
        pm = np.zeros((h, w), bool)
        la = np.asarray(layer.getchannel("A")) > 127
        pm |= la
        ctx.holes &= ~pm
    ctx.img = out.convert("RGB")
    ctx.changed = True


def _adjust(ctx: Ctx, op: dict):
    img = ctx.img
    out = img
    b, c, s = float(op.get("brightness", 1)), float(op.get("contrast", 1)), float(op.get("saturation", 1))
    for v in (b, c, s):
        if not 0 <= v <= 4:
            raise EditError("brightness, contrast and saturation are multipliers between 0 and 4 (1 = unchanged)")
    if b != 1:
        out = ImageEnhance.Brightness(out).enhance(b)
    if c != 1:
        out = ImageEnhance.Contrast(out).enhance(c)
    if s != 1:
        out = ImageEnhance.Color(out).enhance(s)
    m = ctx.mask(op.get("mask"), required=False)
    if m is not None:
        out = Image.composite(out, img, Image.fromarray(np.where(m, 255, 0).astype(np.uint8)))
    ctx.img = out
    ctx.changed = True


SIDES = ("up", "down", "left", "right")


def _extend(ctx: Ctx, op: dict):
    """Grow the canvas on one side by `amount` (fraction of that dimension). The new strip starts as a smeared
    copy of the edge and is marked as a hole, so the model paints real content there."""
    side = {"top": "up", "bottom": "down"}.get(op.get("side"), op.get("side"))
    if side not in SIDES:
        raise EditError("extend side must be up, down, left or right")
    amt = float(op.get("amount", 0.2))
    if not 0.02 <= amt <= 1:
        raise EditError("extend amount is a fraction between 0.02 and 1 (0.2 = 20%)")
    w, h = ctx.size
    horiz = side in ("left", "right")
    n = round((w if horiz else h) * amt)
    total = (w + n) if horiz else (h + n)
    total = max(16, round(total / 16) * 16)  # model sizes are multiples of 16
    n = total - (w if horiz else h)
    nw, nh = (w + n, h) if horiz else (w, h + n)
    ox, oy = (n if side == "left" else 0), (n if side == "up" else 0)
    canvas = Image.new("RGB", (nw, nh))
    # edge-replicate (numpy pad) then blur the new strip so the start of the fill is plausible
    pad = ((oy, nh - h - oy), (ox, nw - w - ox), (0, 0))
    canvas = Image.fromarray(np.pad(np.asarray(ctx.img), pad, mode="edge"))
    strip = np.zeros((nh, nw), bool)
    strip[: oy or 0, :] = side == "up"
    if side == "down":
        strip[h:, :] = True
    if side == "left":
        strip[:, :ox] = True
    if side == "right":
        strip[:, w:] = True
    blurred = canvas.filter(ImageFilter.GaussianBlur(max(4, n // 6)))
    canvas = Image.composite(blurred, canvas, Image.fromarray(np.where(strip, 255, 0).astype(np.uint8)))

    def grow(m_img: Image.Image) -> Image.Image:
        out = Image.new(m_img.mode, (nw, nh), 0)
        out.paste(m_img, (ox, oy))
        return out

    for k, m in list(ctx.masks.items()):
        ctx.masks[k] = np.asarray(grow(Image.fromarray(np.where(m, 255, 0).astype(np.uint8)))) > 127
    ctx.holes = (np.asarray(grow(Image.fromarray(np.where(ctx.holes, 255, 0).astype(np.uint8)))) > 127) | strip
    ctx.img = canvas
    ctx.changed = True


def apply_op(ctx: Ctx, op: dict):
    kind = op.get("op")
    if kind == "mask":
        mid = op.get("id") or "selection"
        m = ctx.mask({k: v for k, v in op.items() if k in ("png", "point", "rect", "poly", "method", "tolerance")})
        cur = ctx.masks.get(mid)
        mode = op.get("mode", "replace")
        if cur is None or mode == "replace":
            new = m
        elif mode == "add":
            new = cur | m
        elif mode == "subtract":
            new = cur & ~m
        elif mode == "intersect":
            new = cur & m
        else:
            raise EditError("mask mode must be replace, add, subtract or intersect")
        grow = int(op.get("grow", 0) or 0)  # px; negative shrinks
        if grow:
            f = ImageFilter.MaxFilter if grow > 0 else ImageFilter.MinFilter
            new = np.asarray(Image.fromarray(np.where(new, 255, 0).astype(np.uint8)).filter(f(abs(grow) * 2 + 1))) > 127
        ctx.masks[mid] = new
    elif kind == "erase":
        m = ctx.mask(op.get("mask"))
        f = op.get("fill", "local")
        if f not in ("local", "model", "white"):
            raise EditError("erase fill must be local, model or white")
        if f == "white":
            ctx.img = Image.composite(Image.new("RGB", ctx.size, (255, 255, 255)), ctx.img, Image.fromarray(np.where(m, 255, 0).astype(np.uint8)))
        else:
            ctx.img = fill(ctx.img, m)
        if f == "model":
            ctx.holes |= m
        ctx.changed = True
    elif kind == "crop":
        box = op.get("box")
        if not (isinstance(box, list) and len(box) == 4):
            raise EditError("crop needs box [x, y, w, h] (fractions)")
        w, h = ctx.size
        x, y, bw, bh = [float(v) for v in box]
        x0, y0 = max(0, round(x * w)), max(0, round(y * h))
        x1, y1 = min(w, round((x + bw) * w)), min(h, round((y + bh) * h))
        if x1 - x0 < 8 or y1 - y0 < 8:
            raise EditError("crop box is too small")
        ctx.geometry(lambda im: im.crop((x0, y0, x1, y1)))
    elif kind == "rotate":
        deg = int(op.get("deg", 90)) % 360
        if deg % 90:
            raise EditError("rotate deg must be a multiple of 90 (rotate a selection with move)")
        if deg:
            ctx.geometry(lambda im: im.rotate(-deg, expand=True))  # clockwise
    elif kind == "flip":
        axis = op.get("axis", "h")
        if axis not in ("h", "v"):
            raise EditError("flip axis must be h or v")
        if op.get("mask") is not None:  # flip a selection in place
            _moves(ctx, [{"mask": op["mask"], "flip": axis}])
        else:
            ctx.geometry(ImageOps.mirror if axis == "h" else ImageOps.flip)
    elif kind == "adjust":
        _adjust(ctx, op)
    elif kind == "extend":
        _extend(ctx, op)
    else:
        raise EditError(f"unknown op {kind!r} (have: {', '.join(sorted(PIXEL_OPS | MODEL_OPS))})")


def apply_ops(img: Image.Image, ops: list[dict], load_file=None, cache_key: str | None = None) -> Ctx:
    if not isinstance(ops, list):
        raise EditError("ops must be a list")
    ctx = Ctx(img, load_file, cache_key)
    i = 0
    while i < len(ops):
        op = ops[i]
        if not isinstance(op, dict):
            raise EditError(f"op {i} is not an object")
        if op.get("op") == "move":
            j = i
            while j < len(ops) and isinstance(ops[j], dict) and ops[j].get("op") == "move":
                j += 1
            _moves(ctx, ops[i:j])
            i = j
            continue
        apply_op(ctx, op)
        i += 1
    return ctx
