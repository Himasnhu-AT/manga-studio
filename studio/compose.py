"""Speech bubbles, sfx and panel layers, drawn on top of picked panels (text never goes through the model).

Bubble spec in story.yaml (all coordinates are fractions of the panel, 0..1):
    bubbles:
      - text: "Daaad! My cheeks are already squishy!"
        at: [0.72, 0.12]     # bubble centre
        w: 0.42              # max bubble width (fraction of panel width)
        tail: [0.62, 0.32]   # where the tail points (omit for none)
        style: speech        # speech | shout | thought | caption
        size: 1.0            # font scale
        vertical: false      # true: characters stacked top-to-bottom, columns right-to-left
        h: 0.32              # vertical only: max column height (fraction of panel height)
    sfx:                     # small marks drawn as plain text
      - {text: "#", at: [0.12, 0.08], size: 1.4, rotate: -10}

Layers (all optional): background colour, art (the picked version, framed by `crop`), fx (screentone /
speedlines / focuslines), lettering (bubbles + sfx). `bubble_geometry` is the single source of bubble
shape/size: the PIL renderer, the SVG exporter and auto-lettering all use it.
"""

from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from studio.story import Story, picked_version

FONT_DIR = Path(__file__).resolve().parent.parent / "fonts"
FONT_CANDIDATES = [
    FONT_DIR / "ComicNeue-Bold.ttf",
    Path("/System/Library/Fonts/Supplemental/Comic Sans MS Bold.ttf"),
    Path("/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
]
INK = (25, 25, 30)
PAPER = (255, 255, 255)


@lru_cache(maxsize=64)
def _font(px: int) -> ImageFont.FreeTypeFont:
    for f in FONT_CANDIDATES:
        if f.exists():
            return ImageFont.truetype(str(f), px)
    return ImageFont.load_default(px)


_measure = ImageDraw.Draw(Image.new("RGB", (8, 8)))


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        cur = ""
        for word in para.split():
            trial = f"{cur} {word}".strip()
            if draw.textlength(trial, font=font) <= max_w or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
    return lines


def _columns(text: str, per_col: int) -> list[str]:
    """Vertical text: split into columns of at most `per_col` characters, breaking at newlines too."""
    cols: list[str] = []
    for para in text.split("\n"):
        para = para.strip()
        while para:
            cols.append(para[:per_col])
            para = para[per_col:].lstrip()
        if not para and not cols:
            cols.append("")
    return cols or [""]


def bubble_geometry(b: dict, W: int, H: int) -> dict:
    """Everything needed to draw a bubble at panel size W x H, in pixels.

    Returns {style, cx, cy, rx, ry, box: [x0, y0, x1, y1] (outer bounds incl. shout spikes), font_px,
    vertical, lines (horizontal) or columns (vertical), line_h, text_w, text_h, tail: (x, y) | None}.
    """
    scale = W / 864
    style = b.get("style", "speech")
    font = _font(int(28 * scale * b.get("size", 1.0)))
    cx, cy = b["at"][0] * W, b["at"][1] * H
    g = {"style": style, "cx": cx, "cy": cy, "font_px": font.size, "vertical": bool(b.get("vertical")), "scale": scale}
    if g["vertical"]:
        adv = font.size * 1.08  # per-character advance down a column
        col_w = font.size * 1.3
        per_col = max(1, int(H * b.get("h", 0.32) / adv))
        cols = _columns(b["text"], per_col)
        tw, th = col_w * len(cols), adv * max(len(c) for c in cols)
        g.update(columns=cols, line_h=adv, col_w=col_w)
    else:
        max_w = int(W * b.get("w", 0.42) * 0.72)
        lines = _wrap(_measure, b["text"], font, max_w)
        lh = int(font.size * 1.18)
        tw = max(_measure.textlength(l, font=font) for l in lines)
        th = lh * len(lines)
        g.update(lines=lines, line_h=lh)
    g.update(text_w=tw, text_h=th)
    if style == "caption":
        pad = 14 * scale
        rx, ry = tw / 2 + pad, th / 2 + pad
        k = 1.0
    else:
        rx, ry = tw / 2 + 34 * scale, th / 2 + 28 * scale
        k = 1.18 if style == "shout" else 1.0
    g.update(rx=rx, ry=ry, box=[cx - rx * k, cy - ry * k, cx + rx * k, cy + ry * k])
    g["tail"] = (b["tail"][0] * W, b["tail"][1] * H) if b.get("tail") and style != "caption" else None
    return g


def tail_polygon(g: dict) -> list[tuple[float, float]]:
    cx, cy, rx, ry = g["cx"], g["cy"], g["rx"], g["ry"]
    tx, ty = g["tail"]
    ang = math.atan2(ty - cy, tx - cx)
    spread = 0.22
    base = [(cx + rx * 0.82 * math.cos(a), cy + ry * 0.82 * math.sin(a)) for a in (ang - spread, ang + spread)]
    return [base[0], (tx, ty), base[1]]


def thought_dots(g: dict) -> list[tuple[float, float, float]]:
    cx, cy = g["cx"], g["cy"]
    tx, ty = g["tail"]
    out = []
    for i, f in enumerate((0.55, 0.3)):
        px = cx + (tx - cx) * (0.75 + 0.2 * i)
        py = cy + (ty - cy) * (0.75 + 0.2 * i)
        out.append((px, py, 12 * g["scale"] * f * 2))
    return out


def shout_points(g: dict, n: int = 22) -> list[tuple[float, float]]:
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        k = 1.18 if i % 2 == 0 else 0.98
        pts.append((g["cx"] + g["rx"] * k * math.cos(a), g["cy"] + g["ry"] * k * math.sin(a)))
    return pts


def draw_bubble(img: Image.Image, b: dict) -> None:
    W, H = img.size
    g = bubble_geometry(b, W, H)
    scale = g["scale"]
    draw = ImageDraw.Draw(img)
    font = _font(g["font_px"])
    cx, cy, rx, ry, style = g["cx"], g["cy"], g["rx"], g["ry"], g["style"]
    lw = max(2, int(3 * scale))

    if style == "caption":
        draw.rectangle(g["box"], fill=PAPER, outline=INK, width=lw)
    else:
        if g["tail"]:
            if style == "thought":
                for px, py, r in thought_dots(g):
                    draw.ellipse([px - r, py - r, px + r, py + r], fill=PAPER, outline=INK, width=lw)
            else:
                poly = tail_polygon(g)
                draw.polygon(poly, fill=PAPER, outline=INK)
                draw.line(poly, fill=INK, width=max(2, int(3 * scale)))
        if style == "shout":
            draw.polygon(shout_points(g), fill=PAPER, outline=INK, width=lw)
        else:
            draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=PAPER, outline=INK, width=lw)

    if g["vertical"]:
        x = cx + g["text_w"] / 2 - g["col_w"] / 2  # first column on the right
        for col in g["columns"]:
            y = cy - g["text_h"] / 2
            for ch in col:
                if ch.strip():
                    draw.text((x, y + g["line_h"] / 2), ch, font=font, fill=INK, anchor="mm")
                y += g["line_h"]
            x -= g["col_w"]
    else:
        y = cy - g["text_h"] / 2
        for l in g["lines"]:
            w = draw.textlength(l, font=font)
            draw.text((cx - w / 2, y), l, font=font, fill=INK)
            y += g["line_h"]


def draw_sfx(img: Image.Image, s: dict) -> None:
    W, H = img.size
    font = _font(int(30 * (W / 864) * s.get("size", 1.0)))
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    color = s.get("color", (60, 60, 70, 255))
    if isinstance(color, str):
        color = _hex(color)
    d.text((s["at"][0] * W, s["at"][1] * H), s["text"], font=font, fill=color, anchor="mm")
    if s.get("rotate"):
        cx, cy = s["at"][0] * W, s["at"][1] * H
        layer = layer.rotate(s["rotate"], center=(cx, cy))
    img.alpha_composite(layer)


# ---- layers -------------------------------------------------------------


def _hex(c: str) -> tuple[int, int, int, int]:
    c = c.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), 255)


def apply_crop(art: Image.Image, crop: dict | None, bg: tuple) -> Image.Image:
    """Frame the art inside the panel: scale > 1 zooms in around (x, y); scale < 1 shows background."""
    if not crop:
        return art
    W, H = art.size
    s = float(crop.get("scale", 1.0)) or 1.0
    fx, fy = float(crop.get("x", 0.5)), float(crop.get("y", 0.5))
    if abs(s - 1.0) < 1e-6 and abs(fx - 0.5) < 1e-6 and abs(fy - 0.5) < 1e-6:
        return art
    nw, nh = max(1, int(W * s)), max(1, int(H * s))
    big = art.resize((nw, nh), Image.LANCZOS)
    # place so the focus point (fx, fy) of the scaled art lands at the panel centre, clamped to cover when s >= 1
    ox, oy = W / 2 - fx * nw, H / 2 - fy * nh
    if s >= 1:
        ox, oy = min(0, max(W - nw, ox)), min(0, max(H - nh, oy))
    out = Image.new("RGBA", (W, H), bg)
    out.paste(big, (int(round(ox)), int(round(oy))), big)
    return out


def _region(item: dict, W: int, H: int) -> tuple[int, int, int, int]:
    x, y, w, h = item.get("region") or [0, 0, 1, 1]
    return int(x * W), int(y * H), int((x + w) * W), int((y + h) * H)


def draw_fx(img: Image.Image, item: dict) -> None:
    W, H = img.size
    op = int(255 * float(item.get("opacity", 0.25)))
    dens = float(item.get("density", 0.5))
    x0, y0, x1, y1 = _region(item, W, H)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ink = (20, 20, 24, op)
    kind = item.get("type")
    if kind == "screentone":
        step = max(4, int((W / 864) * (22 - 16 * dens)))
        r = step * (0.18 + 0.22 * dens)
        ang = math.radians(float(item.get("angle", 45)))
        ca, sa = math.cos(ang), math.sin(ang)
        diag = int(math.hypot(x1 - x0, y1 - y0)) + step
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        for i in range(-diag // step, diag // step + 1):
            for j in range(-diag // step, diag // step + 1):
                u, v = i * step, j * step
                px, py = mx + u * ca - v * sa, my + u * sa + v * ca
                if x0 <= px <= x1 and y0 <= py <= y1:
                    d.ellipse([px - r, py - r, px + r, py + r], fill=ink)
    elif kind == "speedlines":
        ang = math.radians(float(item.get("angle", 0)))
        ca, sa = math.cos(ang), math.sin(ang)
        n = int(20 + 80 * dens)
        L = math.hypot(x1 - x0, y1 - y0)
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        import random as _r

        rnd = _r.Random(7)
        for _ in range(n):
            off = rnd.uniform(-L / 2, L / 2)
            length = rnd.uniform(0.3, 0.9) * L
            start = rnd.uniform(-L / 2, L / 2 - length)
            px, py = mx - sa * off, my + ca * off
            a = (px + ca * start, py + sa * start)
            b = (px + ca * (start + length), py + sa * (start + length))
            d.line([a, b], fill=ink, width=max(1, int(W / 864 * rnd.uniform(1, 3))))
    elif kind == "focuslines":
        cxf, cyf = item.get("center") or [0.5, 0.5]
        cx, cy = cxf * W, cyf * H
        n = int(60 + 140 * dens)
        R = math.hypot(W, H)
        inner = 0.28 * min(W, H)
        import random as _r

        rnd = _r.Random(11)
        for k in range(n):
            a = 2 * math.pi * k / n + rnd.uniform(-0.01, 0.01)
            r0 = inner * rnd.uniform(0.9, 1.5)
            w = math.radians(rnd.uniform(0.15, 0.5))
            p_in = (cx + r0 * math.cos(a), cy + r0 * math.sin(a))
            p1 = (cx + R * math.cos(a - w), cy + R * math.sin(a - w))
            p2 = (cx + R * math.cos(a + w), cy + R * math.sin(a + w))
            d.polygon([p_in, p1, p2], fill=ink)
        mask = Image.new("L", img.size, 0)
        ImageDraw.Draw(mask).rectangle([x0, y0, x1, y1], fill=255)
        layer.putalpha(Image.composite(layer.getchannel("A"), Image.new("L", img.size, 0), mask))
    img.alpha_composite(layer)


def render_panel(story: Story, pid: str, lettering: bool = True, crop: bool = True) -> Image.Image | None:
    """The picked version with every visible layer applied, at the version's own resolution (RGBA).

    `crop=False` leaves framing to the caller: page export frames the whole panel (art + lettering)
    inside its slot exactly like the app's canvas does (export.art_frame / auto_crop)."""
    panel = story.panel(pid)
    v = picked_version(story, pid)
    if not v:
        return None
    art = Image.open(story.dir / "out" / pid / v).convert("RGBA")
    layers = panel.get("layers") or {}
    use_crop = panel.get("crop") if crop else None
    if layers or use_crop:
        bgc = (layers.get("background") or {})
        bg = _hex(bgc["color"]) if bgc.get("visible", True) and bgc.get("color") else (255, 255, 255, 255)
        img = Image.new("RGBA", art.size, bg)
        if (layers.get("art") or {}).get("visible", True):
            img.alpha_composite(apply_crop(art, use_crop, (0, 0, 0, 0)))
        fx = layers.get("fx") or {}
        if fx.get("visible", True):
            for item in fx.get("items") or []:
                draw_fx(img, item)
    else:
        img = art  # v0.1 path: byte-identical output for panels without layers
    if lettering and (layers.get("lettering") or {}).get("visible", True):
        for s in panel.get("sfx", []) or []:
            draw_sfx(img, s)
        for b in panel.get("bubbles", []) or []:
            if b.get("at") and b.get("text"):
                draw_bubble(img, b)
    return img


def compose_panel(story: Story, pid: str) -> Path | None:
    img = render_panel(story, pid)
    if img is None:
        return None
    out = story.dir / "final" / f"{pid}.png"
    out.parent.mkdir(exist_ok=True)
    img.convert("RGB").save(out)
    return out


def compose_story(story: Story) -> dict:
    """Compose every strip panel (skips panels with `strip: false`, e.g. reference sheets)."""
    done, missing = [], []
    for p in story.panels:
        if p.get("strip", True) is False:
            continue
        out = compose_panel(story, p["id"])
        (done if out else missing).append(p["id"])
    strip = None
    if done:
        imgs = [Image.open(story.dir / "final" / f"{pid}.png") for pid in done]
        W = max(i.width for i in imgs)
        gap = int(W * 0.05)
        H = sum(int(i.height * W / i.width) for i in imgs) + gap * (len(imgs) + 1)
        canvas = Image.new("RGB", (W, H), PAPER)
        y = gap
        for i in imgs:
            i = i.resize((W, int(i.height * W / i.width)))
            canvas.paste(i, (0, y))
            y += i.height + gap
        strip = story.dir / "final" / "strip.png"
        canvas.save(strip)
    return {"composed": done, "missing": missing, "strip": str(strip) if strip else None}
