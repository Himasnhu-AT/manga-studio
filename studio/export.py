"""Export: page PNGs, layered SVGs (raster art + vector lettering), print-ready PDF, webtoon strips.

Page mode lays panels into `pages[].panels[].box` (fractions of the live area, i.e. the page minus
margins) and clips to `poly` when present. Print presets add bleed around the trim; the live area is
measured from the trim edge. SVG keeps lettering as real vector shapes and text, so dialogue stays
editable after export. Output goes to stories/<slug>/final/export/.
"""

from __future__ import annotations

import base64
import io
from html import escape
from pathlib import Path

from PIL import Image, ImageDraw

from studio.compose import INK, bubble_geometry, render_panel, shout_points, tail_polygon, thought_dots
from studio.story import Story

MM_PER_IN = 25.4
PRESETS = {
    # name: (trim width mm or None for px, trim height, dpi, default bleed mm, px size for digital)
    "digital": {"px": (1654, 2339), "dpi": 200, "bleed_mm": 0.0},
    "print-b5": {"mm": (182, 257), "dpi": 350, "bleed_mm": 3.0},
    "print-a5": {"mm": (148, 210), "dpi": 350, "bleed_mm": 3.0},
}
WEBTOON_W = 800
SLICE_H = 1280


def _px(mm: float, dpi: int) -> int:
    return int(round(mm / MM_PER_IN * dpi))


def page_geometry(story: Story, preset: str, bleed_mm: float | None, margin_mm: float | None) -> dict:
    p = PRESETS[preset]
    dpi = p["dpi"]
    bleed = p["bleed_mm"] if bleed_mm is None else bleed_mm
    if "px" in p:
        fmt_page = story.format.get("page") or {}
        tw, th = int(fmt_page.get("width", p["px"][0])), int(fmt_page.get("height", p["px"][1]))
    else:
        tw, th = _px(p["mm"][0], dpi), _px(p["mm"][1], dpi)
    b = _px(bleed, dpi)
    margin = _px(margin_mm, dpi) if margin_mm is not None else int(tw * float(story.format.get("margin", 0.06)))
    live = (b + margin, b + margin, tw - 2 * margin, th - 2 * margin)  # x, y, w, h in px
    return {"W": tw + 2 * b, "H": th + 2 * b, "dpi": dpi, "bleed": b, "live": live}


def _template(n: int, g: float, rtl: bool) -> list[list[float]]:
    """Panel boxes for n panels on one page, in reading order. Rows of 1-2 panels, varied heights."""
    def row(y: float, h: float, cols: int) -> list[list[float]]:
        if cols == 1:
            return [[0, y, 1, h]]
        w = (1 - g) / 2
        cells = [[0, y, w, h], [w + g, y, w, h]]
        return cells[::-1] if rtl else cells

    def stack(spec: list[tuple[float, int]]) -> list[list[float]]:
        total = sum(w for w, _ in spec)
        avail = 1 - g * (len(spec) - 1)
        y, out = 0.0, []
        for weight, cols in spec:
            h = avail * weight / total
            out += row(y, h, cols)
            y += h + g
        return [[round(v, 4) for v in b] for b in out]

    specs = {1: [(1, 1)], 2: [(1, 1), (1, 1)], 3: [(1.1, 1), (1, 2)], 4: [(0.9, 1), (1.1, 2), (1, 1)], 5: [(1, 2), (1.1, 1), (1, 2)], 6: [(1, 2), (1, 2), (1, 2)]}
    return stack(specs[max(1, min(6, n))])


def auto_pages(story: Story, per_page: int = 4) -> list[dict]:
    """Strip panels flowed into pages of `per_page` using simple manga page templates (rtl aware)."""
    gut = float(story.format.get("gutter", 0.018))
    rtl = story.format.get("direction", "rtl") == "rtl"
    per_page = max(1, min(6, per_page))
    pids = [p["id"] for p in story.panels if p.get("strip", True) is not False]
    pages = []
    for i in range(0, len(pids), per_page):
        chunk = pids[i : i + per_page]
        boxes = _template(len(chunk), gut * 1.4, rtl)  # page gutter is relative to width; rows are taller
        pages.append({"id": f"pg{len(pages) + 1}", "panels": [{"panel": pid, "box": box} for pid, box in zip(chunk, boxes)]})
    return pages


# ---- page devices: borders, bleed, page background, character cut-outs ---------------

BORDERS = {"normal": 1.0, "bold": 2.2, "thin": 0.5, "none": 0.0}
SUBJECTS = ("pop", "cutout")
PAPERS = {"white": (255, 255, 255), "black": (12, 12, 14)}
BLEED_EPS = 0.004  # a box edge this close to the live edge counts as touching it
POP_REACH = 0.2  # a popped-out character leaves its frame by at most this much of the slot size


def subject_rel(story: Story, pid: str) -> str | None:
    """Story-relative path of the cut-out mask for the panel's picked version, if one was made."""
    from studio.story import picked_version

    v = picked_version(story, pid)
    if not v:
        return None
    rel = f"out/{pid}/masks/subject-{Path(v).stem}.png"
    return rel if (story.dir / rel).exists() else None


def _subject_alpha(story: Story, pid: str) -> Image.Image | None:
    rel = subject_rel(story, pid)
    if not rel:
        return None
    m = Image.open(story.dir / rel)
    return m.getchannel("A") if "A" in m.getbands() else m.convert("L")


def _slot_px(slot: dict, live, canvas: tuple[int, int] | None = None) -> tuple[int, int, int, int]:
    """Slot rectangle in page px. With `bleed`, edges touching the live area run to the canvas edge."""
    lx, ly, lw, lh = live
    x, y, w, h = slot["box"]
    x0, y0, x1, y1 = lx + x * lw, ly + y * lh, lx + (x + w) * lw, ly + (y + h) * lh
    if slot.get("bleed") and canvas:
        if x <= BLEED_EPS:
            x0 = 0
        if y <= BLEED_EPS:
            y0 = 0
        if x + w >= 1 - BLEED_EPS:
            x1 = canvas[0]
        if y + h >= 1 - BLEED_EPS:
            y1 = canvas[1]
    return int(x0), int(y0), max(1, int(x1 - x0)), max(1, int(y1 - y0))


def _line_px(geo: dict, slot: dict) -> int:
    k = BORDERS.get(slot.get("border") or "normal", 1.0)
    return 0 if k == 0 else max(1, int(geo["W"] * 0.0022 * k))


def _lettering_layer(panel: dict, size: tuple[int, int]) -> Image.Image | None:
    """Bubbles and sfx alone on a transparent canvas the size of the art."""
    from studio.compose import draw_bubble, draw_sfx

    if (panel.get("layers") or {}).get("lettering", {}).get("visible", True) is False:
        return None
    if not (panel.get("bubbles") or panel.get("sfx")):
        return None
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    for s in panel.get("sfx") or []:
        draw_sfx(img, s)
    for b in panel.get("bubbles") or []:
        if b.get("at") and b.get("text"):
            draw_bubble(img, b)
    return img


def _paste_framed(canvas: Image.Image, layer: Image.Image, panel: dict, slot_rect, clip: Image.Image | None, alpha: Image.Image | None = None, fit: str = "cover") -> None:
    """Scale `layer` (art-sized) into the slot's art frame and paste it. `clip` is an L mask the size of the
    canvas (None = no clipping), `alpha` an extra L mask at art size (the cut-out character)."""
    x, y, w, h = slot_rect
    left, top, fw, fh = slot_frame_px(panel, layer.size, w, h, fit)
    size = (max(1, round(fw)), max(1, round(fh)))
    big = layer.convert("RGBA").resize(size, Image.LANCZOS)
    a = big.getchannel("A")
    if alpha is not None:
        from PIL import ImageChops

        a = ImageChops.multiply(a, alpha.resize(size, Image.LANCZOS))
    full = Image.new("L", canvas.size, 0)
    full.paste(a, (x + round(left), y + round(top)))
    if clip is not None:
        from PIL import ImageChops

        full = ImageChops.multiply(full, clip)
    rgb = Image.new("RGB", canvas.size, (255, 255, 255))
    rgb.paste(big.convert("RGB"), (x + round(left), y + round(top)))
    canvas.paste(rgb, (0, 0), full)


def _page_background(story: Story, page: dict, canvas: Image.Image) -> None:
    bg = page.get("background") or {}
    pid = bg.get("panel")
    if not pid:
        return
    try:
        art = render_panel(story, pid, lettering=False, crop=False)
    except Exception:
        return
    if art is None:
        return
    W, H = canvas.size
    left, top, fw, fh = art_frame(art.width / art.height, W / H, bg.get("crop"))
    big = art.convert("RGB").resize((max(1, round(fw * W / 100)), max(1, round(fh * H / 100))), Image.LANCZOS)
    layer = canvas.copy()
    layer.paste(big, (round(left * W / 100), round(top * H / 100)))
    canvas.paste(Image.blend(canvas, layer, max(0.0, min(1.0, float(bg.get("opacity", 0.35))))))


def art_frame(img_aspect: float, slot_aspect: float, crop: dict | None = None, fit: str = "cover") -> tuple[float, float, float, float]:
    """Where the panel sits inside its slot, as (left, top, width, height) percentages of the slot.
    Port of app/src/lib/layout.ts `artFrame`: cover fit (or contain, for a cut-out character), zoom by
    crop.scale (>= 1), then the focal point works like CSS object-position (0 = left/top, 1 = right/bottom)."""
    s = max(1.0, float((crop or {}).get("scale", 1) or 1))
    w = h = 100.0 * s
    if (img_aspect > slot_aspect) == (fit == "cover"):
        w = (img_aspect / slot_aspect) * 100 * s
    else:
        h = (slot_aspect / img_aspect) * 100 * s
    fx = float((crop or {}).get("x", 0.5))
    fy = float((crop or {}).get("y", 0.5))
    return (100 - w) * fx, (100 - h) * fy, w, h


def auto_crop(panel: dict, img_aspect: float, slot_aspect: float) -> dict | None:
    """Default framing for a panel without `crop`: keep its lettering in view (port of layout.ts
    `autoCrop`). Bubbles sit near the top, and a centred cover crop of a wide slot would cut them."""
    if panel.get("crop"):
        return dict(panel["crop"])
    items = [b["at"] for b in panel.get("bubbles") or [] if b.get("at")] + [x["at"] for x in panel.get("sfx") or [] if x.get("at")]
    if not items or img_aspect >= slot_aspect:  # only vertical overflow needs help
        return None
    visible = img_aspect / slot_aspect  # fraction of the image height that fits
    top = max(0.0, min(a[1] for a in items) - 0.09)
    y = min(1.0, max(0.0, top / max(0.0001, 1 - visible)))
    return {"x": 0.5, "y": min(y, 0.5), "scale": 1}


def slot_frame_px(panel: dict, img_size: tuple[int, int], w: int, h: int, fit: str = "cover") -> tuple[float, float, float, float]:
    """The panel's frame inside a w x h slot in pixels (left, top, width, height); it may overflow the slot."""
    ia, sa = img_size[0] / img_size[1], w / h
    crop = panel.get("crop") if fit == "contain" else auto_crop(panel, ia, sa)
    left, top, fw, fh = art_frame(ia, sa, crop, fit)
    return left * w / 100, top * h / 100, fw * w / 100, fh * h / 100


def _fit(img: Image.Image, panel: dict, w: int, h: int) -> Image.Image:
    """The rendered panel (art + lettering) framed into its slot exactly as the app's canvas frames it."""
    left, top, fw, fh = slot_frame_px(panel, img.size, w, h)
    big = img.resize((max(1, round(fw)), max(1, round(fh))), Image.LANCZOS)
    out = Image.new("RGB", (w, h), (255, 255, 255))
    out.paste(big, (round(left), round(top)))
    return out


def _poly_px(slot: dict, x: int, y: int, w: int, h: int) -> list[tuple[float, float]] | None:
    poly = slot.get("poly")
    if not poly:
        return None
    return [(x + px * w, y + py * h) for px, py in poly]


def render_page(story: Story, page: dict, geo: dict) -> Image.Image:
    """One page. Per slot, bottom to top: art (clipped to the frame), border, the cut-out character
    (`subject: pop` breaks out over the border, `cutout` floats with no frame), then lettering.
    Later slots draw over earlier ones, so an inset panel sits on top of the panel it overlaps."""
    paper = PAPERS.get(page.get("paper") or "white", PAPERS["white"])
    canvas = Image.new("RGB", (geo["W"], geo["H"]), paper)
    _page_background(story, page, canvas)
    for slot in page.get("panels") or []:
        pid = slot.get("panel")
        x, y, w, h = _slot_px(slot, geo["live"], (geo["W"], geo["H"]))
        poly = _poly_px(slot, x, y, w, h)
        clip = Image.new("L", canvas.size, 0)
        if poly:
            ImageDraw.Draw(clip).polygon(poly, fill=255)
        else:
            clip.paste(255, (x, y, x + w, y + h))
        panel = story.panel(pid) if pid and any(p["id"] == pid for p in story.panels) else None
        art = render_panel(story, pid, lettering=False, crop=False) if panel else None
        mode = slot.get("subject") if slot.get("subject") in SUBJECTS else None
        alpha = _subject_alpha(story, pid) if (art is not None and mode) else None
        if mode and alpha is None:
            mode = None  # no mask yet: draw a normal panel
        if art is not None and mode != "cutout":
            _paste_framed(canvas, art, panel, (x, y, w, h), clip)
        line = _line_px(geo, slot) if mode != "cutout" else 0
        if line:
            d = ImageDraw.Draw(canvas)
            if poly:
                d.line(poly + [poly[0]], fill=INK, width=line, joint="curve")
            else:
                d.rectangle([x, y, x + w - 1, y + h - 1], outline=INK, width=line)
        fit = "contain" if mode == "cutout" else "cover"
        if mode:
            reach = None
            if mode == "pop":
                dx, dy = int(w * POP_REACH), int(h * POP_REACH)
                reach = Image.new("L", canvas.size, 0)
                reach.paste(255, (x - dx, y - dy, x + w + dx, y + h + dy))
            _paste_framed(canvas, art, panel, (x, y, w, h), reach, alpha, fit)
        if panel is not None:
            lt = _lettering_layer(panel, art.size) if art is not None else None
            if lt is not None:
                _paste_framed(canvas, lt, panel, (x, y, w, h), clip if mode != "cutout" else None, fit=fit)
    return canvas


def render_webtoon(story: Story) -> Image.Image:
    imgs = [render_panel(story, p["id"], crop=False) for p in story.panels if p.get("strip", True) is not False]
    imgs = [i.convert("RGB") for i in imgs if i is not None]
    W = WEBTOON_W
    gap = int(W * 0.08)
    scaled = [i.resize((W, int(i.height * W / i.width)), Image.LANCZOS) for i in imgs]
    H = sum(i.height for i in scaled) + gap * (len(scaled) + 1)
    canvas = Image.new("RGB", (W, max(H, 1)), (255, 255, 255))
    y = gap
    for i in scaled:
        canvas.paste(i, (0, y))
        y += i.height + gap
    return canvas


# ---- SVG ----------------------------------------------------------------


def _data_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _pts(pts) -> str:
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)


def lettering_svg(panel: dict, W: int, H: int) -> str:
    """Bubbles + sfx as vector SVG in panel pixel coordinates (same geometry as the PIL renderer)."""
    if (panel.get("layers") or {}).get("lettering", {}).get("visible", True) is False:
        return ""
    out = []
    font = "font-family=\"'Comic Neue', 'Comic Sans MS', sans-serif\" font-weight=\"700\""
    for s in panel.get("sfx") or []:
        size = int(30 * (W / 864) * s.get("size", 1.0))
        x, y = s["at"][0] * W, s["at"][1] * H
        rot = f' transform="rotate({-float(s.get("rotate", 0)):.1f} {x:.1f} {y:.1f})"' if s.get("rotate") else ""
        color = s.get("color") if isinstance(s.get("color"), str) else "#3c3c46"
        out.append(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" {font} fill="{color}" text-anchor="middle" dominant-baseline="central"{rot}>{escape(s["text"])}</text>')
    for b in panel.get("bubbles") or []:
        if not b.get("at") or not b.get("text"):
            continue
        g = bubble_geometry(b, W, H)
        lw = max(2, int(3 * g["scale"]))
        st = f'fill="#fff" stroke="#19191e" stroke-width="{lw}" stroke-linejoin="round"'
        parts = []
        if g["style"] == "caption":
            x0, y0, x1, y1 = g["box"]
            parts.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{x1 - x0:.1f}" height="{y1 - y0:.1f}" {st}/>')
        else:
            if g["tail"]:
                if g["style"] == "thought":
                    parts += [f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{r:.1f}" {st}/>' for px, py, r in thought_dots(g)]
                else:
                    parts.append(f'<polygon points="{_pts(tail_polygon(g))}" {st}/>')
            if g["style"] == "shout":
                parts.append(f'<polygon points="{_pts(shout_points(g))}" {st}/>')
            else:
                parts.append(f'<ellipse cx="{g["cx"]:.1f}" cy="{g["cy"]:.1f}" rx="{g["rx"]:.1f}" ry="{g["ry"]:.1f}" {st}/>')
        if g["vertical"]:
            x = g["cx"] + g["text_w"] / 2 - g["col_w"] / 2
            for col in g["columns"]:
                y0 = g["cy"] - g["text_h"] / 2
                parts.append(
                    f'<text x="{x:.1f}" y="{y0:.1f}" font-size="{g["font_px"]}" {font} fill="#19191e" writing-mode="vertical-rl" '
                    f'text-orientation="upright" letter-spacing="{g["line_h"] - g["font_px"]:.1f}">{escape(col)}</text>'
                )
                x -= g["col_w"]
        else:
            y = g["cy"] - g["text_h"] / 2
            for l in g["lines"]:
                parts.append(f'<text x="{g["cx"]:.1f}" y="{y + g["line_h"] / 2:.1f}" font-size="{g["font_px"]}" {font} fill="#19191e" text-anchor="middle" dominant-baseline="central">{escape(l)}</text>')
                y += g["line_h"]
        out.append(f'<g class="bubble"{f" id={chr(34)}{escape(str(b["id"]))}{chr(34)}" if b.get("id") else ""}>' + "".join(parts) + "</g>")
    return "".join(out)


def page_svg(story: Story, page: dict, geo: dict) -> str:
    W, H = geo["W"], geo["H"]
    paper = PAPERS.get(page.get("paper") or "white", PAPERS["white"])
    body = [f'<rect width="{W}" height="{H}" fill="rgb{paper}"/>']
    defs = []
    bg = page.get("background") or {}
    if bg.get("panel") and any(p["id"] == bg["panel"] for p in story.panels):
        art = render_panel(story, bg["panel"], lettering=False, crop=False)
        if art is not None:
            l, t, fw, fh = art_frame(art.width / art.height, W / H, bg.get("crop"))
            op = max(0.0, min(1.0, float(bg.get("opacity", 0.35))))
            body.append(f'<image class="page-background" x="{l * W / 100:.1f}" y="{t * H / 100:.1f}" width="{fw * W / 100:.1f}" height="{fh * H / 100:.1f}" opacity="{op:.2f}" preserveAspectRatio="none" href="{_data_uri(art)}"/>')
    for k, slot in enumerate(page.get("panels") or []):
        pid = slot.get("panel")
        x, y, w, h = _slot_px(slot, geo["live"], (W, H))
        poly = _poly_px(slot, x, y, w, h)
        cid = f"clip-{page['id']}-{k}"
        shape = f'<polygon points="{_pts(poly)}"/>' if poly else f'<rect x="{x}" y="{y}" width="{w}" height="{h}"/>'
        defs.append(f'<clipPath id="{cid}">{shape}</clipPath>')
        panel = story.panel(pid) if pid and any(p["id"] == pid for p in story.panels) else None
        art = render_panel(story, pid, lettering=False, crop=False) if panel else None
        mode = slot.get("subject") if slot.get("subject") in SUBJECTS else None
        alpha = _subject_alpha(story, pid) if (art is not None and mode) else None
        if mode and alpha is None:
            mode = None
        frame = None
        if art is not None:
            pw, ph = art.size
            fl, ft, fw, fh = slot_frame_px(panel, art.size, w, h, "contain" if mode == "cutout" else "cover")
            frame = f'x="{x + fl:.2f}" y="{y + ft:.2f}" width="{fw:.2f}" height="{fh:.2f}" viewBox="0 0 {pw} {ph}" preserveAspectRatio="none"'
        if frame and mode != "cutout":
            body.append(f'<g clip-path="url(#{cid})" data-panel="{escape(pid)}"><svg {frame}><g class="art"><image width="{pw}" height="{ph}" href="{_data_uri(art)}"/></g></svg></g>')
        line = _line_px(geo, slot) if mode != "cutout" else 0
        if line:
            body.append(shape.replace("/>", f' fill="none" stroke="#19191e" stroke-width="{line}" stroke-linejoin="round"/>'))
        if frame and mode:
            mid = f"subject-{page['id']}-{k}"
            m = Image.merge("RGB", (alpha, alpha, alpha))  # luminance mask: white = the character
            defs.append(f'<mask id="{mid}" maskUnits="userSpaceOnUse" x="0" y="0" width="{pw}" height="{ph}"><image width="{pw}" height="{ph}" href="{_data_uri(m)}"/></mask>')
            reach = ""
            if mode == "pop":
                rid, dx, dy = f"reach-{page['id']}-{k}", w * POP_REACH, h * POP_REACH
                defs.append(f'<clipPath id="{rid}"><rect x="{x - dx:.1f}" y="{y - dy:.1f}" width="{w + 2 * dx:.1f}" height="{h + 2 * dy:.1f}"/></clipPath>')
                reach = f' clip-path="url(#{rid})"'
            body.append(f'<g{reach}><svg {frame} class="subject {mode}" data-panel="{escape(pid)}"><image width="{pw}" height="{ph}" mask="url(#{mid})" href="{_data_uri(art)}"/></svg></g>')
        if frame:
            clip_attr = f' clip-path="url(#{cid})"' if mode != "cutout" else ""
            body.append(f'<g{clip_attr}><svg {frame}><g class="lettering">{lettering_svg(panel, pw, ph)}</g></svg></g>')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
        f"<defs>{''.join(defs)}</defs>{''.join(body)}</svg>"
    )


def webtoon_svg(story: Story) -> str:
    panels = [p for p in story.panels if p.get("strip", True) is not False]
    W = WEBTOON_W
    gap = int(W * 0.08)
    y = gap
    body = []
    for p in panels:
        art = render_panel(story, p["id"], lettering=False, crop=False)
        if art is None:
            continue
        h = int(art.height * W / art.width)
        body.append(
            f'<svg x="0" y="{y}" width="{W}" height="{h}" viewBox="0 0 {art.width} {art.height}" data-panel="{escape(p["id"])}">'
            f'<g class="art"><image width="{art.width}" height="{art.height}" href="{_data_uri(art)}"/></g>'
            f'<g class="lettering">{lettering_svg(p, art.width, art.height)}</g></svg>'
        )
        y += h + gap
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{y}" viewBox="0 0 {W} {y}"><rect width="{W}" height="{y}" fill="#fff"/>{"".join(body)}</svg>'


# ---- entry --------------------------------------------------------------


def export(story: Story, formats: list[str], preset: str = "digital", bleed_mm: float | None = None, margin_mm: float | None = None) -> list[str]:
    """Write the requested formats; returns paths relative to the story dir."""
    if preset not in PRESETS:
        raise ValueError(f"unknown preset {preset!r} (have: {', '.join(PRESETS)})")
    bad = set(formats) - {"png", "svg", "pdf"}
    if bad:
        raise ValueError(f"unknown format(s): {', '.join(sorted(bad))}")
    out_dir = story.dir / "final" / "export"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*"):
        if old.is_file():
            old.unlink()
    files: list[Path] = []
    slug = story.slug

    if story.format.get("mode") == "webtoon":
        strip = render_webtoon(story)
        if "png" in formats:
            f = out_dir / f"{slug}-webtoon.png"
            strip.save(f)
            files.append(f)
            for i, top in enumerate(range(0, strip.height, SLICE_H), 1):
                f = out_dir / f"{slug}-{i:03d}.png"
                strip.crop((0, top, strip.width, min(strip.height, top + SLICE_H))).save(f)
                files.append(f)
        if "svg" in formats:
            f = out_dir / f"{slug}-webtoon.svg"
            f.write_text(webtoon_svg(story))
            files.append(f)
        if "pdf" in formats:
            slices = [strip.crop((0, t, strip.width, min(strip.height, t + SLICE_H))) for t in range(0, strip.height, SLICE_H)]
            f = out_dir / f"{slug}.pdf"
            slices[0].save(f, save_all=True, append_images=slices[1:], resolution=72.0)
            files.append(f)
    else:
        geo = page_geometry(story, preset, bleed_mm, margin_mm)
        pages = story.data.get("pages") or auto_pages(story)
        rendered = []
        for n, page in enumerate(pages, 1):
            img = render_page(story, page, geo)
            rendered.append(img)
            if "png" in formats:
                f = out_dir / f"{slug}-p{n:02d}.png"
                img.save(f, dpi=(geo["dpi"], geo["dpi"]))
                files.append(f)
            if "svg" in formats:
                f = out_dir / f"{slug}-p{n:02d}.svg"
                f.write_text(page_svg(story, page, geo))
                files.append(f)
        if "pdf" in formats and rendered:
            f = out_dir / f"{slug}-{preset}.pdf"
            rendered[0].save(f, save_all=True, append_images=rendered[1:], resolution=float(geo["dpi"]))
            files.append(f)
    return [str(f.relative_to(story.dir)) for f in files]
