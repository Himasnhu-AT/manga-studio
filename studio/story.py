"""Story files: story.yaml (written by Claude) + state.json (written by the dashboard).

Layout of one story:
    stories/<slug>/story.yaml      blocks, panels, bubbles
    stories/<slug>/refs/           reference images you drop in (any name)
    stories/<slug>/out/<panel>/    generated versions: 001-s42.png + 001-s42.json
    stories/<slug>/state.json      picks, stars, notes from the dashboard
    stories/<slug>/final/          composed panels with bubbles + strip.png
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
STORIES = Path(os.environ.get("STUDIO_STORIES", ROOT / "stories")).resolve()

_state_lock = threading.Lock()


class StoryError(ValueError):
    pass


@dataclass
class Story:
    slug: str
    dir: Path
    data: dict

    @property
    def panels(self) -> list[dict]:
        return self.data.get("panels", [])

    @property
    def cast(self) -> dict:
        return self.data.get("cast") or {}

    @property
    def format(self) -> dict:
        f = {"mode": "page", "direction": "rtl", "page": {"width": 1654, "height": 2339}, "gutter": 0.018, "margin": 0.06}
        f.update(self.data.get("format") or {})
        return f

    def cast_block(self, cid: str) -> str:
        """Verbatim block for a cast member: blocks[cid] wins, else compiled from the structured fields."""
        blocks = self.data.get("blocks", {}) or {}
        if cid in blocks:
            return blocks[cid]
        return compile_cast(self.cast.get(cid) or {"name": cid})

    def panel(self, pid: str) -> dict:
        for p in self.panels:
            if p["id"] == pid:
                return p
        raise StoryError(f"panel {pid!r} not in story {self.slug!r} (have: {', '.join(p['id'] for p in self.panels)})")

    # ---- settings -------------------------------------------------------
    def settings(self, panel: dict | None = None) -> dict:
        s = {
            "model": "qwen-image-2.1-turbo",
            "quantize": 4,
            "width": 864,
            "height": 1152,
            "steps": None,  # model default (8 for turbo, 40 for base)
            "strength": 1.0,
            "output_resolution": 1024,
        }
        s.update(self.data.get("defaults", {}) or {})
        if panel:
            for k in ("width", "height", "steps", "strength", "seed", "output_resolution"):
                if k in panel:
                    s[k] = panel[k]
        return s

    # ---- references -----------------------------------------------------
    def resolve_ref(self, ref: str | dict) -> dict:
        """A ref is a panel id (uses that panel's picked version) or a file under refs/."""
        name = ref if isinstance(ref, str) else ref["ref"]
        label = None if isinstance(ref, str) else ref.get("label")
        ids = {p["id"] for p in self.panels}
        if name in ids:
            src = self.panel(name)
            version = picked_version(self, name)
            if not version:
                raise StoryError(f"ref {name!r} has no picked version yet - generate it and pick one first")
            return {
                "name": name,
                "path": str(self.dir / "out" / name / version),
                "version": version,
                "label": label or src.get("ref_label") or src.get("title") or name,
            }
        p = self.dir / "refs" / name
        if not p.exists():
            raise StoryError(f"ref {name!r} is neither a panel id nor a file in {self.dir / 'refs'}")
        refs_meta = (self.data.get("refs") or {}).get(name, {})
        return {"name": name, "path": str(p), "version": None, "label": label or refs_meta.get("label") or name}

    # ---- prompt ---------------------------------------------------------
    def panel_refs(self, panel: dict) -> list:
        """Explicit refs, then each `cast:` member's sheet (or first ref file) if not already there."""
        refs = list(panel.get("refs", []) or [])
        names = {r if isinstance(r, str) else r["ref"] for r in refs}
        for cid in panel.get("cast", []) or []:
            c = self.cast.get(cid)
            if not c:
                raise StoryError(f"panel {panel['id']!r} casts unknown character {cid!r} (have: {', '.join(self.cast) or 'none'})")
            extra = c.get("sheet") or next(iter(c.get("refs") or []), None)
            if extra and extra not in names and extra != panel["id"]:  # a sheet that casts its own characters
                refs.append(extra)
                names.add(extra)
        return refs

    def build_prompt(self, panel: dict, refs: list[dict]) -> str:
        blocks = self.data.get("blocks", {}) or {}
        parts: list[str] = []
        if refs:
            lines = [f"Image {i}: {r['label']}." for i, r in enumerate(refs, 1)]
            parts.append("Reference images. " + " ".join(lines))
        use = list(panel.get("use", []) or [])
        for cid in panel.get("cast", []) or []:
            if cid not in use:
                use.append(cid)
        for key in use:
            if key in blocks:
                text = blocks[key]
            elif key in self.cast:
                text = self.cast_block(key)
            else:
                raise StoryError(f"panel {panel['id']!r} uses unknown block {key!r} (have: {', '.join(list(blocks) + list(self.cast))})")
            parts.append(f"{key.upper()}: {text.strip()}")
        if panel.get("action"):
            parts.append(f"ACTION: {panel['action'].strip()}")
        avoid = panel.get("avoid", self.data.get("avoid"))
        if avoid:
            parts.append(f"Avoid: {avoid.strip()}")
        return "\n\n".join(parts)

    def plan(self, pid: str, seed: int | None = None) -> dict:
        """Everything needed to run one generation, fully resolved (no I/O besides ref lookups)."""
        panel = self.panel(pid)
        refs = [self.resolve_ref(r) for r in self.panel_refs(panel)]
        if len(refs) > 10:
            raise StoryError("Qwen-Image-2.1 takes at most 10 reference images")
        s = self.settings(panel)
        return {
            "story": self.slug,
            "panel": pid,
            "prompt": self.build_prompt(panel, refs),
            "refs": refs,
            "seed": seed if seed is not None else s.get("seed", int(time.time()) % 100000),
            "model": s["model"],
            "quantize": s["quantize"],
            "width": s["width"],
            "height": s["height"],
            "steps": s["steps"],
            "strength": s["strength"],
            "output_resolution": s["output_resolution"],
        }


def compile_cast(c: dict) -> str:
    """Structured cast entry -> one verbatim block. Same fields, same order, every time."""
    head = c.get("name", "")
    if c.get("role"):
        head += f", {c['role']}"
    parts = [head + (f": {c['face']}." if c.get("face") else ".")]
    if c.get("hair"):
        parts.append(f"Hair: {c['hair']}.")
    if c.get("outfit"):
        parts.append(f"Outfit: {c['outfit']}.")
    if c.get("palette"):
        parts.append(f"Palette: {c['palette']}.")
    return " ".join(parts)


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def list_stories() -> list[str]:
    if not STORIES.exists():
        return []
    return sorted(p.name for p in STORIES.iterdir() if (p / "story.yaml").exists())


def load(slug: str) -> Story:
    d = STORIES / slug
    f = d / "story.yaml"
    if not f.exists():
        raise StoryError(f"no story {slug!r} (have: {', '.join(list_stories()) or 'none'})")
    try:
        data = yaml.safe_load(f.read_text()) or {}
    except yaml.YAMLError as e:
        raise StoryError(f"{f}: {e}") from e
    ids = [p.get("id") for p in data.get("panels", [])]
    if None in ids or len(ids) != len(set(ids)):
        raise StoryError(f"{f}: every panel needs a unique id")
    return Story(slug, d, data)


# ---- versions + state ---------------------------------------------------


def versions(story: Story, pid: str) -> list[dict]:
    d = story.dir / "out" / pid
    if not d.exists():
        return []
    out = []
    for png in sorted(d.glob("*.png")):
        meta_f = png.with_suffix(".json")
        meta = json.loads(meta_f.read_text()) if meta_f.exists() else {}
        out.append({"file": png.name, **meta})
    return out


_reserved: set[Path] = set()  # names handed out but not written yet (a generation in progress)
_reserve_lock = threading.Lock()


def next_version_name(story: Story, pid: str, seed: int) -> Path:
    """Next free NNN-s<seed>.png. Reserved until written, so a job that is still generating and an image
    edit saved meanwhile never get the same number."""
    d = story.dir / "out" / pid
    d.mkdir(parents=True, exist_ok=True)
    with _reserve_lock:
        taken = [p.name for p in d.glob("*.png")] + [p.name for p in _reserved if p.parent == d]
        n = 1 + max((int(name.split("-")[0]) for name in taken if name[:3].isdigit()), default=0)
        out = d / f"{n:03d}-s{seed}.png"
        _reserved.difference_update({p for p in _reserved if p.exists()})
        _reserved.add(out)
        return out


def state_path(story: Story) -> Path:
    return story.dir / "state.json"


def read_state(story: Story) -> dict:
    p = state_path(story)
    base = {"picks": {}, "stars": {}, "notes": []}
    if p.exists():
        base.update(json.loads(p.read_text()))
    return base


def update_state(story: Story, fn) -> dict:
    with _state_lock:
        st = read_state(story)
        fn(st)
        tmp = state_path(story).with_suffix(".tmp")
        tmp.write_text(json.dumps(st, indent=2))
        tmp.replace(state_path(story))
        return st


def picked_version(story: Story, pid: str) -> str | None:
    """Explicit pick, else the newest version."""
    pick = read_state(story)["picks"].get(pid)
    if pick and (story.dir / "out" / pid / pick).exists():
        return pick
    vs = versions(story, pid)
    return vs[-1]["file"] if vs else None
