"""App-level services for the desktop UI: settings, system check, model cache/download, agent integrations.

Settings live in ROOT/.studio/settings.json (gitignored) so they travel with the checkout, not the user.
"""

from __future__ import annotations

import copy
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from studio.story import ROOT

SETTINGS_FILE = Path(os.environ.get("STUDIO_SETTINGS", ROOT / ".studio" / "settings.json"))

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
    free = shutil.disk_usage(str(ROOT)).free
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


def mcp_command() -> list[str]:
    return ["uv", "--directory", str(ROOT), "run", "studio", "mcp"]


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
    cmd = mcp_command()
    with ThreadPoolExecutor(2) as ex:  # the two CLIs are slow; ask them at the same time
        claude, codex = ex.map(_agent, ["claude", "codex"])
    return {
        "claude": claude,
        "codex": codex,
        "ollama": _ollama(s["llm"]["ollama_url"]),
        "mcp": {"command": cmd, "json": {"mcpServers": {MCP_NAME: {"command": cmd[0], "args": cmd[1:]}}}},
    }


def connect(agent: str) -> dict:
    if agent not in ("claude", "codex"):
        raise KeyError(agent)
    if agent == "claude":
        cmd = ["claude", "mcp", "add", "--scope", "user", MCP_NAME, "--", *mcp_command()]
    else:
        cmd = ["codex", "mcp", "add", MCP_NAME, "--", *mcp_command()]
    shown = " ".join(cmd)
    state = _agent(agent, fresh=True)
    if not state["installed"]:
        return {"ok": False, "command": shown, "output": f"{agent} CLI not found on PATH"}
    if state["connected"]:
        return {"ok": True, "command": shown, "output": "already connected"}
    ok, out = _run(cmd, timeout=20)
    _agent_cache.pop(agent, None)
    return {"ok": ok, "command": shown, "output": out}
