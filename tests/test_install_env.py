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
    assert p["mcp"] == ["manga-studio-mcp"]  # registrations never carry a path


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
    assert p["mcp"] == ["manga-studio-mcp"]
    # an explicit STUDIO_SETTINGS still wins over STUDIO_HOME
    assert _probe(STUDIO_HOME=str(home), STUDIO_SETTINGS=str(tmp_path / "s.json"))["settings"] == str(tmp_path / "s.json")


def test_mcp_registration_is_one_plain_command(monkeypatch, tmp_path):
    for k in OVERRIDES:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("STUDIO_MCP_BIN_DIR", str(tmp_path / "bin"))
    # no paths in the registration, ever: the launcher on PATH carries them
    assert appsvc.mcp_add_command("claude") == ["claude", "mcp", "add", "--scope", "user", "manga-studio", "--", "manga-studio-mcp"]
    assert appsvc.mcp_add_command("codex") == ["codex", "mcp", "add", "manga-studio", "--", "manga-studio-mcp"]

    # a checkout: the launcher runs studio mcp in place
    launcher = appsvc.install_launcher()
    assert launcher == tmp_path / "bin" / "manga-studio-mcp" and os.access(launcher, os.X_OK)
    assert f"exec uv --directory {shlex.quote(str(st.ROOT))} run studio mcp" in launcher.read_text()

    # the installed app: the launcher hands off to the app's own launcher (paths with spaces quoted)
    app_launcher = "/Users/x/Library/Application Support/Manga Studio/bin/manga-studio-mcp"
    monkeypatch.setenv("STUDIO_MCP_LAUNCHER", app_launcher)
    monkeypatch.setenv("STUDIO_STORIES", "/Users/x/Manga Studio/stories")
    appsvc.install_launcher()
    assert f"exec {shlex.quote(app_launcher)} \"$@\"" in launcher.read_text()

    monkeypatch.setattr(appsvc, "_agent", lambda b, **_: {"installed": True, "connected": False})
    monkeypatch.setattr(appsvc, "_ollama", lambda url: {"installed": False, "running": False, "models": []})
    mcp = appsvc.integrations()["mcp"]
    assert mcp["command"] == ["manga-studio-mcp"]
    assert mcp["env"]["STUDIO_STORIES"] == "/Users/x/Manga Studio/stories"  # shown, not registered
    assert shlex.split(mcp["add"]["claude"]) == appsvc.mcp_add_command("claude")


def test_connect_replaces_an_old_path_registration(monkeypatch, tmp_path):
    monkeypatch.setenv("STUDIO_MCP_BIN_DIR", str(tmp_path / "bin"))
    ran = []
    monkeypatch.setattr(appsvc, "_agent", lambda b, **_: {"installed": True, "connected": True})
    monkeypatch.setattr(appsvc, "_registered_command", lambda b: "uv --directory /Users/x/manga-studio run studio mcp")
    monkeypatch.setattr(appsvc, "_run", lambda cmd, timeout=8: (ran.append(cmd), (True, ""))[1])
    r = appsvc.connect("claude")
    assert r["ok"] and ran == [["claude", "mcp", "remove", "--scope", "user", "manga-studio"], appsvc.mcp_add_command("claude")]
    ran.clear()
    monkeypatch.setattr(appsvc, "_registered_command", lambda b: "manga-studio-mcp")
    assert appsvc.connect("claude")["output"] == "already connected" and ran == []


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


def test_status_reports_stories_folder_and_mismatch_is_caught(tmp_path):
    """Port 7860 can be held by another studio (a checkout's dev server vs. the installed app).
    /api/status says which stories folder it serves, so the app, MCP and CLI can refuse the wrong one."""
    from fastapi.testclient import TestClient

    from studio import server, story as st

    status = TestClient(server.app).get("/api/status").json()
    assert status["stories"] == str(st.STORIES)
    assert st.backend_mismatch(status) is None
    assert "saves stories in" in st.backend_mismatch({**status, "stories": str(tmp_path)})
    assert "doesn't say where" in st.backend_mismatch({"rev": 1})  # an older backend


def test_mcp_refuses_a_backend_with_another_stories_folder(monkeypatch, tmp_path):
    import httpx

    from studio import mcp_server

    class Resp:
        def json(self):
            return {"rev": 1, "stories": str(tmp_path)}

    monkeypatch.setattr(mcp_server, "_checked", False)
    monkeypatch.setattr(httpx, "get", lambda *a, **k: Resp())
    called = []
    monkeypatch.setattr(httpx, "request", lambda *a, **k: called.append(a))
    import pytest

    with pytest.raises(RuntimeError, match="Wrong backend"):
        mcp_server._api("GET", "/api/stories")
    assert not called  # nothing was sent to the wrong backend
