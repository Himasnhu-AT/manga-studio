"""App-level services for the desktop UI: settings, system check, model cache/download, agent integrations.

Settings live in HOME_DIR/settings.json: ROOT/.studio/ in a checkout (gitignored, so they travel with the
checkout), ~/Library/Application Support/Manga Studio/ in the installed app (STUDIO_HOME / STUDIO_SETTINGS).
"""

from __future__ import annotations

import copy
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from studio.story import HOME_DIR, ROOT, STORIES

SETTINGS_FILE = Path(os.environ.get("STUDIO_SETTINGS", HOME_DIR / "settings.json"))

DEFAULTS = {
    "onboarded": False,
    "agent": "none",
    "llm": {
        "provider": "heuristic",
        "ollama_url": "http://127.0.0.1:11434",
        "text_model": "qwen3:8b",
        "vision_model": "qwen2.5vl:7b",
    },
    "image": {"model": "qwen-image-2.1-turbo", "quantize": 4},
}

_settings_lock = threading.Lock()


def _merge(base: dict, patch: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (patch or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load_settings() -> dict:
    stored = {}
    if SETTINGS_FILE.exists():
        try:
            stored = json.loads(SETTINGS_FILE.read_text())
        except ValueError:
            stored = {}
    return _merge(DEFAULTS, stored)


def save_settings(patch: dict) -> dict:
    with _settings_lock:
        cur = _merge(load_settings(), patch)
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cur, indent=2))
        tmp.replace(SETTINGS_FILE)
        return cur


# ---- system -------------------------------------------------------------


def system_info(engine: str) -> dict:
    ram = 0
    try:
        ram = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=3).stdout.strip() or 0)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    disk = STORIES if STORIES.exists() else HOME_DIR if HOME_DIR.exists() else Path.home()
    free = shutil.disk_usage(str(disk)).free
    machine = platform.machine()
    return {
        "platform": sys.platform,
        "arch": machine,
        "apple_silicon": sys.platform == "darwin" and machine == "arm64",
        "ram_gb": round(ram / 1024**3, 1),
        "disk_free_gb": round(free / 1024**3, 1),
        "python": platform.python_version(),
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "engine": engine,
    }


# ---- models -------------------------------------------------------------

MODELS = {
    "qwen-image-2.1-turbo": {"repo": "Qwen/Qwen-Image-2.1-Turbo", "approx_gb": 32},
    "qwen-image-2.1": {"repo": "Qwen/Qwen-Image-2.1", "approx_gb": 32},
}
_downloads: dict[str, dict] = {}  # id -> {downloading, total_bytes, error}


def _hf_cache() -> Path:
    from huggingface_hub import constants

    return Path(constants.HF_HUB_CACHE)


def _repo_dir(repo: str) -> Path:
    return _hf_cache() / ("models--" + repo.replace("/", "--"))


def _blob_bytes(repo: str) -> tuple[int, bool]:
    """(bytes on disk incl. partial downloads, any *.incomplete blobs left)."""
    d = _repo_dir(repo) / "blobs"
    if not d.exists():
        return 0, False
    total, incomplete = 0, False
    for f in d.iterdir():
        try:
            total += f.stat().st_size
        except OSError:
            continue
        if f.name.endswith(".incomplete"):
            incomplete = True
    return total, incomplete


def _cached(repo: str) -> bool:
    snaps = _repo_dir(repo) / "snapshots"
    if not snaps.exists():
        return False
    _, incomplete = _blob_bytes(repo)
    # A complete snapshot has a model_index.json (diffusers layout) and no partial blobs.
    return not incomplete and any((s / "model_index.json").exists() for s in snaps.iterdir())


def models() -> list[dict]:
    out = []
    for mid, m in MODELS.items():
        done, _ = _blob_bytes(m["repo"])
        dl = _downloads.get(mid, {})
        out.append(
            {
                "id": mid,
                "repo": m["repo"],
                "approx_gb": m["approx_gb"],
                "cached": _cached(m["repo"]) and not dl.get("downloading"),
                "cached_bytes": done,
                "downloading": bool(dl.get("downloading")),
                "progress": {"done_bytes": done, "total_bytes": dl.get("total_bytes") or m["approx_gb"] * 1024**3} if dl else None,
                "error": dl.get("error"),
            }
        )
    return out


def _download(mid: str) -> None:
    from huggingface_hub import HfApi, snapshot_download

    repo = MODELS[mid]["repo"]
    st = _downloads[mid]
    try:
        try:
            info = HfApi().model_info(repo, files_metadata=True)
            st["total_bytes"] = sum((s.size or 0) for s in info.siblings or [])
        except Exception:  # offline or rate-limited: keep the estimate, the download itself will tell
            pass
        snapshot_download(repo)
        st["error"] = None
    except Exception as e:
        st["error"] = f"{type(e).__name__}: {e}"
    finally:
        st["downloading"] = False


def start_download(mid: str) -> dict:
    if mid not in MODELS:
        raise KeyError(mid)
    if _downloads.get(mid, {}).get("downloading"):
        return {"ok": True, "already": True}
    _downloads[mid] = {"downloading": True, "total_bytes": None, "error": None, "started": time.time()}
    threading.Thread(target=_download, args=(mid,), daemon=True).start()
    return {"ok": True}


# ---- integrations -------------------------------------------------------

MCP_NAME = "manga-studio"


# Env the MCP bridge needs to see the same data as this backend. Only the names that are set are
# passed on, so in a checkout (none set) the registration is exactly `uv --directory <repo> run studio mcp`.
MCP_ENV_KEYS = ("STUDIO_STORIES", "STUDIO_SETTINGS", "STUDIO_HOME", "UV_PROJECT_ENVIRONMENT", "PYTHONPYCACHEPREFIX")


LAUNCHER_NAME = "manga-studio-mcp"


def launcher_path() -> Path:
    """Where the global `manga-studio-mcp` command lives (on PATH for anyone who installed uv)."""
    return Path(os.environ.get("STUDIO_MCP_BIN_DIR") or Path.home() / ".local" / "bin") / LAUNCHER_NAME


def _launcher_target() -> list[str]:
    # The installed app writes its own launcher outside its (read-only, signed) bundle and tells us
    # where; it sets the data env and runs the bundled `studio mcp`. A checkout runs it in place.
    app_launcher = os.environ.get("STUDIO_MCP_LAUNCHER")
    if app_launcher:
        return [app_launcher]
    return ["uv", "--directory", str(ROOT), "run", "studio", "mcp"]


def install_launcher() -> Path:
    """Write ~/.local/bin/manga-studio-mcp, so agents register one plain command on every Mac
    (`claude mcp add --scope user manga-studio -- manga-studio-mcp`) instead of a path into this
    checkout or the app bundle. Rewritten on connect, so it follows the app or checkout in use."""
    path = launcher_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    script = (
        "#!/bin/sh\n"
        "# Manga Studio MCP bridge. Written by the app when you press Connect; safe to delete.\n"
        'PATH="$PATH:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin"\n'
        "export PATH\n"
        f'exec {shlex.join(_launcher_target())} "$@"\n'
    )
    tmp = path.with_suffix(".tmp")
    tmp.write_text(script)
    tmp.chmod(0o755)
    tmp.replace(path)
    return path


def mcp_command() -> list[str]:
    return [LAUNCHER_NAME]


def mcp_env() -> dict[str, str]:
    """Env the bridge runs with (shown in the app). The launcher sets it, so registrations don't."""
    return {k: os.environ[k] for k in MCP_ENV_KEYS if os.environ.get(k)}


def mcp_add_command(agent: str) -> list[str]:
    """The exact `claude mcp add` / `codex mcp add` that connect() runs (and the app shows)."""
    if agent == "claude":
        return ["claude", "mcp", "add", "--scope", "user", MCP_NAME, "--", *mcp_command()]
    if agent == "codex":
        return ["codex", "mcp", "add", MCP_NAME, "--", *mcp_command()]
    raise KeyError(agent)


def _registered_command(binary: str) -> str | None:
    """The command an agent has registered for manga-studio, from its config file (None if unknown)."""
    home = Path.home()
    try:
        if binary == "claude":
            cfg = json.loads((home / ".claude.json").read_text())
            entry = (cfg.get("mcpServers") or {}).get(MCP_NAME)
            return " ".join([entry.get("command", ""), *entry.get("args", [])]).strip() if entry else None
        if binary == "codex":
            text = (home / ".codex" / "config.toml").read_text()
            for head in (f"[mcp_servers.{MCP_NAME}]", f'[mcp_servers."{MCP_NAME}"]'):
                if head in text:
                    return text.split(head, 1)[1].split("\n[", 1)[0]
    except (OSError, ValueError, AttributeError):
        return None
    return None


def _run(cmd: list[str], timeout: float = 8) -> tuple[bool, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, (r.stdout + r.stderr).strip()
    except FileNotFoundError:
        return False, f"{cmd[0]} not found"
    except subprocess.TimeoutExpired:
        return False, f"{' '.join(cmd[:3])} timed out"


_agent_cache: dict[str, tuple[float, dict]] = {}
_AGENT_TTL = 60.0


def _registered_in_config(binary: str) -> bool:
    """Fast path: the agents keep MCP registrations in their config files. `<cli> mcp list`
    health-checks every server and takes seconds, so only fall back to it when the file says no."""
    home = Path.home()
    try:
        if binary == "claude":
            cfg = json.loads((home / ".claude.json").read_text())
            if MCP_NAME in (cfg.get("mcpServers") or {}):
                return True
            return any(MCP_NAME in (proj.get("mcpServers") or {}) for proj in (cfg.get("projects") or {}).values())
        if binary == "codex":
            return f"[mcp_servers.{MCP_NAME}]" in (home / ".codex" / "config.toml").read_text() or f'[mcp_servers."{MCP_NAME}"]' in (home / ".codex" / "config.toml").read_text()
    except (OSError, ValueError, AttributeError):
        return False
    return False


def _agent(binary: str, fresh: bool = False) -> dict:
    if not shutil.which(binary):
        return {"installed": False, "connected": False}
    if _registered_in_config(binary):
        return {"installed": True, "connected": True}
    hit = _agent_cache.get(binary)
    if hit and not fresh and time.time() - hit[0] < _AGENT_TTL:
        return hit[1]
    ok, out = _run([binary, "mcp", "list"])
    res = {"installed": True, "connected": MCP_NAME in out}
    _agent_cache[binary] = (time.time(), res)
    return res


def _ollama(url: str) -> dict:
    installed = shutil.which("ollama") is not None
    try:
        r = httpx.get(url.rstrip("/") + "/api/tags", timeout=1.5)
        names = [m.get("name") for m in r.json().get("models", [])]
        return {"installed": installed, "running": True, "models": names}
    except (httpx.HTTPError, ValueError):
        return {"installed": installed, "running": False, "models": []}


def integrations() -> dict:
    s = load_settings()
    cmd, env = mcp_command(), mcp_env()
    with ThreadPoolExecutor(2) as ex:  # the two CLIs are slow; ask them at the same time
        claude, codex = ex.map(_agent, ["claude", "codex"])
    return {
        "claude": claude,
        "codex": codex,
        "ollama": _ollama(s["llm"]["ollama_url"]),
        "mcp": {
            "command": cmd,
            "env": env,
            "add": {a: shlex.join(mcp_add_command(a)) for a in ("claude", "codex")},
            "json": {"mcpServers": {MCP_NAME: {"command": cmd[0], "args": cmd[1:], **({"env": env} if env else {})}}},
        },
    }


def connect(agent: str) -> dict:
    if agent not in ("claude", "codex"):
        raise KeyError(agent)
    cmd = mcp_add_command(agent)
    shown = shlex.join(cmd)
    state = _agent(agent, fresh=True)
    if not state["installed"]:
        return {"ok": False, "command": shown, "output": f"{agent} CLI not found on PATH"}
    install_launcher()
    if state["connected"]:
        old = _registered_command(agent)
        if old is not None and LAUNCHER_NAME in old:
            return {"ok": True, "command": shown, "output": "already connected"}
        # An older registration (a path into a checkout or an old app): replace it with the launcher.
        _run(_remove_cmd(agent), timeout=20)
    ok, out = _run(cmd, timeout=20)
    _agent_cache.pop(agent, None)
    return {"ok": ok, "command": shown, "output": out}


def _remove_cmd(agent: str) -> list[str]:
    return ["claude", "mcp", "remove", "--scope", "user", MCP_NAME] if agent == "claude" else ["codex", "mcp", "remove", MCP_NAME]
