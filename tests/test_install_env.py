"""Env overrides the installed desktop app relies on: its code sits in a read-only, signed bundle, so
every write must be redirectable (STUDIO_STORIES, STUDIO_HOME, STUDIO_SETTINGS), and with none set
a checkout must behave exactly as before."""

import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from studio import appsvc, story as st

ROOT = Path(__file__).resolve().parent.parent
PROBE = """
import json
from studio import appsvc, server, story as st
print(json.dumps({"stories": str(st.STORIES), "home": str(st.HOME_DIR), "settings": str(appsvc.SETTINGS_FILE),
                  "app_dist": str(server.APP_DIST), "dashboard": str(server.DASHBOARD), "mcp": appsvc.mcp_command()}))
"""
OVERRIDES = ("STUDIO_STORIES", "STUDIO_SETTINGS", "STUDIO_HOME", "STUDIO_APP_DIST", "STUDIO_MCP_LAUNCHER", "UV_PROJECT_ENVIRONMENT", "PYTHONPYCACHEPREFIX")


def _probe(**env: str) -> dict:
    e = {k: v for k, v in os.environ.items() if k not in OVERRIDES}
    e.update(env, STUDIO_ENGINE="mock")
    out = subprocess.run([sys.executable, "-c", PROBE], env=e, cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return json.loads(out.strip().splitlines()[-1])


def test_checkout_defaults_unchanged():
    p = _probe()
    assert p["stories"] == str(ROOT / "stories")
    assert p["home"] == str(ROOT / ".studio")
    assert p["settings"] == str(ROOT / ".studio" / "settings.json")
    assert p["app_dist"] == str(ROOT / "app" / "dist")
    assert p["dashboard"] == str(ROOT / "dashboard" / "index.html")
    assert p["mcp"] == ["uv", "--directory", str(ROOT), "run", "studio", "mcp"]


def test_installed_overrides(tmp_path):
    home = tmp_path / "Application Support" / "Manga Studio"
    p = _probe(
        STUDIO_STORIES=str(tmp_path / "stories"),
        STUDIO_HOME=str(home),
        STUDIO_APP_DIST=str(tmp_path / "dist"),
        STUDIO_MCP_LAUNCHER=str(home / "bin" / "manga-studio-mcp"),
    )
    assert p["stories"] == str((tmp_path / "stories").resolve())
    assert p["home"] == str(home.resolve())
    assert p["settings"] == str(home.resolve() / "settings.json")  # follows STUDIO_HOME
    assert p["app_dist"] == str(tmp_path / "dist")
    assert p["mcp"] == [str(home / "bin" / "manga-studio-mcp")]
    # an explicit STUDIO_SETTINGS still wins over STUDIO_HOME
    assert _probe(STUDIO_HOME=str(home), STUDIO_SETTINGS=str(tmp_path / "s.json"))["settings"] == str(tmp_path / "s.json")


def test_mcp_registration_carries_env(monkeypatch):
    for k in OVERRIDES:
        monkeypatch.delenv(k, raising=False)
    plain = appsvc.mcp_add_command("claude")
    assert plain == ["claude", "mcp", "add", "--scope", "user", "manga-studio", "--", "uv", "--directory", str(st.ROOT), "run", "studio", "mcp"]

    launcher = "/Users/x/Library/Application Support/Manga Studio/bin/manga-studio-mcp"
    monkeypatch.setenv("STUDIO_MCP_LAUNCHER", launcher)
    monkeypatch.setenv("STUDIO_STORIES", "/Users/x/Manga Studio/stories")
    monkeypatch.setenv("UV_PROJECT_ENVIRONMENT", "/Users/x/Library/Application Support/Manga Studio/venv")
    claude = appsvc.mcp_add_command("claude")
    assert claude[:6] == ["claude", "mcp", "add", "--scope", "user", "manga-studio"]
    assert claude[claude.index("--") + 1 :] == [launcher]
    assert "-e" in claude and "STUDIO_STORIES=/Users/x/Manga Studio/stories" in claude
    codex = appsvc.mcp_add_command("codex")
    assert codex[:4] == ["codex", "mcp", "add", "manga-studio"] and "--env" in codex and codex[-1] == launcher

    monkeypatch.setattr(appsvc, "_agent", lambda b, **_: {"installed": True, "connected": False})
    monkeypatch.setattr(appsvc, "_ollama", lambda url: {"installed": False, "running": False, "models": []})
    mcp = appsvc.integrations()["mcp"]
    assert mcp["command"] == [launcher]
    assert mcp["json"]["mcpServers"]["manga-studio"]["env"]["STUDIO_STORIES"] == "/Users/x/Manga Studio/stories"
    # the shown command is shell-safe (paths with spaces) and is exactly what connect() runs
    assert shlex.split(mcp["add"]["claude"]) == claude


def test_sample_template_falls_back_to_bundled_copy(monkeypatch, tmp_path):
    from studio import server

    empty = tmp_path / "stories"
    empty.mkdir()
    monkeypatch.setattr(st, "STORIES", empty)
    assert st.sample_dir() == st.ROOT / "stories" / st.SAMPLE
    slug = server.create_project("From the sample", template="sample")
    d = empty / slug
    assert (d / "story.yaml").exists() and any((d / "refs").iterdir())
    shutil.rmtree(d)
