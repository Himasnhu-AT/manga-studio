"""Test isolation: every studio module reads STUDIO_STORIES / STUDIO_SETTINGS at import, so point them at a
scratch copy before anything imports `studio`. The real stories/ and .studio/ are never touched."""

import os
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Generated versions (stories/*/out) aren't in git, so a fresh worktree has none. Point
# STUDIO_TEST_STORIES at a checkout that has them (read-only: it is copied, never written).
SRC = Path(os.environ.get("STUDIO_TEST_STORIES", ROOT / "stories"))
_TMP = Path(tempfile.mkdtemp(prefix="studio-test-"))
shutil.copytree(SRC, _TMP / "stories", ignore=shutil.ignore_patterns("final", "*.mp4", ".DS_Store"))
os.environ["STUDIO_STORIES"] = str(_TMP / "stories")


def _placeholder_versions(story_dir: Path) -> None:
    """A fresh clone (CI) has no generated images: give every panel one plain placeholder version,
    the same shape the mock engine writes, so tests that need a picked image still run."""
    import json

    import yaml
    from PIL import Image

    data = yaml.safe_load((story_dir / "story.yaml").read_text())
    d = data.get("defaults") or {}
    w, h = int(d.get("width", 864)), int(d.get("height", 1152))
    for i, panel in enumerate(data.get("panels") or []):
        out = story_dir / "out" / panel["id"]
        if any(out.glob("*.png")):
            continue
        out.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (panel.get("width", w), panel.get("height", h)), (200 + i % 40, 196, 188)).save(out / "001-s1.png")
        meta = {"story": story_dir.name, "panel": panel["id"], "prompt": "", "refs": [], "seed": 1, "engine": "placeholder"}
        (out / "001-s1.json").write_text(json.dumps(meta))


_placeholder_versions(_TMP / "stories" / "cheek-squish")
os.environ["STUDIO_SETTINGS"] = str(_TMP / "settings.json")
os.environ["STUDIO_ENGINE"] = "mock"


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TMP, ignore_errors=True)
