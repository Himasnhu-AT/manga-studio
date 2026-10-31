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
os.environ["STUDIO_SETTINGS"] = str(_TMP / "settings.json")
os.environ["STUDIO_ENGINE"] = "mock"


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_TMP, ignore_errors=True)
