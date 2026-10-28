"""Speech bubbles + vertical strip, drawn on top of picked panels (text never goes through the model).

Bubble spec in story.yaml (all coordinates are fractions of the panel, 0..1):
    bubbles:
      - text: "Daaad! My cheeks are already squishy!"
        at: [0.72, 0.12]     # bubble centre
        w: 0.42              # max bubble width (fraction of panel width)
        tail: [0.62, 0.32]   # where the tail points (omit for none)
        style: speech        # speech | shout | thought | caption
        size: 1.0            # font scale
    sfx:                     # small marks drawn as plain text
      - {text: "#", at: [0.12, 0.08], size: 1.4, rotate: -10}
"""

from __future__ import annotations

import math
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


def _font(px: int) -> ImageFont.FreeTypeFont:
    for f in FONT_CANDIDATES:
        if f.exists():
            return ImageFont.truetype(str(f), px)
    return ImageFont.load_default(px)


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


def _tail(draw, cx, cy, rx, ry, tip, scale):
    tx, ty = tip
    ang = math.atan2(ty - cy, tx - cx)
    spread = 0.22
    base = []
    for a in (ang - spread, ang + spread):
        base.append((cx + rx * 0.82 * math.cos(a), cy + ry * 0.82 * math.sin(a)))
    poly = [base[0], (tx, ty), base[1]]
    draw.polygon(poly, fill=PAPER, outline=INK)
    draw.line([base[0], (tx, ty), base[1]], fill=INK, width=max(2, int(3 * scale)))
    return poly


def draw_bubble(img: Image.Image, b: dict) -> None:
    W, H = img.size
    scale = W / 864
    draw = ImageDraw.Draw(img)
    style = b.get("style", "speech")
    font = _font(int(28 * scale * b.get("size", 1.0)))
    max_w = int(W * b.get("w", 0.42) * 0.72)
    lines = _wrap(draw, b["text"], font, max_w)
    lh = int(font.size * 1.18)
    tw = max(draw.textlength(l, font=font) for l in lines)
    th = lh * len(lines)
    cx, cy = b["at"][0] * W, b["at"][1] * H
    lw = max(2, int(3 * scale))

    if style == "caption":
        pad = 14 * scale
        box = [cx - tw / 2 - pad, cy - th / 2 - pad, cx + tw / 2 + pad, cy + th / 2 + pad]
        draw.rectangle(box, fill=PAPER, outline=INK, width=lw)
    else:
        rx, ry = tw / 2 + 34 * scale, th / 2 + 28 * scale
        if b.get("tail"):
            tip = (b["tail"][0] * W, b["tail"][1] * H)
            if style == "thought":
                for i, f in enumerate((0.55, 0.3)):
                    px = cx + (tip[0] - cx) * (0.75 + 0.2 * i)
                    py = cy + (tip[1] - cy) * (0.75 + 0.2 * i)
                    r = 12 * scale * f * 2
                    draw.ellipse([px - r, py - r, px + r, py + r], fill=PAPER, outline=INK, width=lw)
            else:
                _tail(draw, cx, cy, rx, ry, tip, scale)
        if style == "shout":
            pts = []
            n = 22
            for i in range(n):
                a = 2 * math.pi * i / n
                k = 1.18 if i % 2 == 0 else 0.98
                pts.append((cx + rx * k * math.cos(a), cy + ry * k * math.sin(a)))
            draw.polygon(pts, fill=PAPER, outline=INK, width=lw)
        else:
            draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=PAPER, outline=INK, width=lw)

    y = cy - th / 2
    for l in lines:
        w = draw.textlength(l, font=font)
        draw.text((cx - w / 2, y), l, font=font, fill=INK)
        y += lh


def draw_sfx(img: Image.Image, s: dict) -> None:
    W, H = img.size
    font = _font(int(30 * (W / 864) * s.get("size", 1.0)))
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.text((s["at"][0] * W, s["at"][1] * H), s["text"], font=font, fill=s.get("color", (60, 60, 70, 255)), anchor="mm")
    if s.get("rotate"):
        cx, cy = s["at"][0] * W, s["at"][1] * H
        layer = layer.rotate(s["rotate"], center=(cx, cy))
    img.alpha_composite(layer)


def compose_panel(story: Story, pid: str) -> Path | None:
    panel = story.panel(pid)
    v = picked_version(story, pid)
    if not v:
        return None
    img = Image.open(story.dir / "out" / pid / v).convert("RGBA")
    for s in panel.get("sfx", []) or []:
        draw_sfx(img, s)
    for b in panel.get("bubbles", []) or []:
        draw_bubble(img, b)
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
