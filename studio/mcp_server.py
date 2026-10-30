"""MCP bridge: lets Claude Code, Codex or any MCP client drive manga-studio.

    claude mcp add manga-studio -- uv --directory <repo> run studio mcp

A stdio server that proxies to the studio backend's HTTP API (STUDIO_URL, default
http://127.0.0.1:7860). The backend owns the model, the job queue and the files; this process is thin.
"""

from __future__ import annotations

import io
import os
import time
from typing import Any

import httpx
from mcp.server.mcpserver import Image, MCPServer

URL = os.environ.get("STUDIO_URL", "http://127.0.0.1:7860").rstrip("/")

INSTRUCTIONS = """manga-studio makes consistent manga/webtoon pages with Qwen-Image-2.1 running locally. You write
prompts (story.yaml panels) and run generations; the user looks at results in the Manga Studio app and
leaves picks, stars and notes there.

The loop, every turn:
1. get_feedback(story): what the user asked for, which versions they picked/starred.
2. Edit: update_panel / update_story / set_cast (actions, refs, blocks, bubbles).
3. prompt_preview to sanity-check, then generate(..., wait=True).
4. view_image the outputs yourself and compare against the refs. Regenerate if identity, outfit or
   colors drifted, before telling the user it's ready.
5. resolve_note the notes you handled, with a one-line reply.

Consistency rules (why panels are shaped this way):
- Star topology: every story panel's refs are the same anchors (`sheet`, a room/location plate), never
  the previous panel. Chaining compounds drift.
- Verbatim blocks: character/style/setting text lives once in blocks or cast; panels list them in `use`
  or `cast`. Don't paraphrase a character inside `action`; change the block/cast entry instead.
- Exact color words ("pastel periwinkle-blue", never "blue"). Name the outfit every time.
- No text in images: dialogue goes in `bubbles` (drawn as vectors on top), never in `action`.
- `avoid` instead of negative prompts (turbo ignores negative prompts).
- Small tweak on an existing image: copilot(mode="img2img", strength=0.6). Big pose change: regenerate.
- Picks are the user's call. Only pick_version when asked, or for reference panels (sheet, plates)
  while the user is away, and say which one you chose.

Automated pipeline: pipeline_new(title, text, provider="agent") then loop pipeline_task -> do the stage
-> pipeline_submit until pipeline_status shows every stage done. Layout, artwork and lettering run by
themselves; you are asked for analysis, script and the QA look at each panel."""

server = MCPServer("manga-studio", instructions=INSTRUCTIONS)


class StudioOffline(RuntimeError):
    pass


def _api(method: str, path: str, **kw) -> Any:
    try:
        r = httpx.request(method, URL + path, timeout=httpx.Timeout(60, connect=3), **kw)
    except httpx.ConnectError as e:
        raise StudioOffline(f"The manga-studio backend isn't running at {URL}. Open the Manga Studio app, or start it with `uv run studio serve`.") from e
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", r.text)
        except ValueError:
            detail = r.text
        raise RuntimeError(f"studio error {r.status_code}: {detail}")
    if not r.content:
        return None
    try:
        return r.json()
    except ValueError:
        return r.content


def _compact_panel(p: dict) -> dict:
    keep = ("id", "title", "strip", "refs", "use", "cast", "action", "seed", "strength", "bubbles", "sfx", "protect", "source_span", "camera")
    out = {k: p[k] for k in keep if k in p}
    out["versions"] = [v["file"] for v in p.get("versions", [])]
    out["pick"] = p.get("pick")
    out["picked_by_user"] = bool(p.get("explicit_pick"))
    if p.get("plan_error"):
        out["problem"] = p["plan_error"]
    return out


# ---- projects ------------------------------------------------------------------


@server.tool()
def list_projects() -> list[dict]:
    """List every story/project (slug, title, panel count). Use the slug in every other tool."""
    return _api("GET", "/api/stories")


@server.tool()
def get_project(story: str) -> dict:
    """Everything about one story: format (page/webtoon, rtl/ltr), cast, blocks, avoid, pages, and each panel
    (refs, use, cast, action, bubbles, versions, which version is used), plus open notes from the user.
    Read this before editing so your changes keep the existing blocks and wording."""
    d = _api("GET", f"/api/stories/{story}")
    notes = [dict(n, index=i) for i, n in enumerate(d.get("state", {}).get("notes", [])) if not n.get("done")]
    return {
        "slug": d["slug"],
        "title": d.get("title"),
        "notes": d.get("notes_md"),
        "format": d.get("format"),
        "settings": d.get("settings"),
        "cast": d.get("cast"),
        "blocks": d.get("blocks"),
        "avoid": d.get("avoid"),
        "refs_files": d.get("refs"),
        "pages": d.get("pages"),
        "panels": [_compact_panel(p) for p in d.get("panels", [])],
        "open_notes": notes,
        "pipeline": d.get("pipeline"),
    }


@server.tool()
def create_project(title: str, mode: str = "page", direction: str = "rtl", template: str = "blank") -> dict:
    """Create an empty project. mode: page (manga pages) | webtoon (vertical scroll). direction: rtl | ltr.
    template: blank | sample (copy of the cheek-squish sample). To start from prose, use pipeline_new instead."""
    return _api("POST", "/api/projects", json={"title": title, "mode": mode, "direction": direction, "template": template})


@server.tool()
def update_story(story: str, changes: dict) -> dict:
    """Change story-level keys: title, notes, format, blocks (merged by key), avoid.
    Change a character's look or the style ONCE here (or with set_cast), never per panel."""
    return _api("PATCH", f"/api/stories/{story}", json=changes)


@server.tool()
def update_panel(story: str, panel: str, changes: dict) -> dict:
    """Edit one panel. Keys: title, action, refs (panel ids or refs/ files, max 10, anchors first),
    use (block names), cast (cast ids), seed, strength, bubbles, sfx, layers, crop, protect, strip.
    A key set to null is removed. Bubbles: [{id, text, at: [x, y], w, tail: [x, y], style:
    speech|shout|thought|caption, vertical: bool}] with coordinates as fractions of the panel; leave out
    `at` and call auto_letter to have them placed. Actions describe one frozen moment."""
    return _api("PATCH", f"/api/stories/{story}/panels/{panel}", json=changes)


@server.tool()
def add_panel(story: str, title: str = "", after: str | None = None, panel_id: str | None = None) -> dict:
    """Add a new panel (optionally after another panel id). Then fill it with update_panel."""
    body = {"title": title or None, "after": after, "id": panel_id}
    return _api("POST", f"/api/stories/{story}/panels", json={k: v for k, v in body.items() if v})


@server.tool()
def set_cast(story: str, cast_id: str, entry: dict) -> dict:
    """Create or replace a cast member. entry: {name, role, face, hair, outfit, palette, notes, refs: [files],
    sheet: <panel id of their reference sheet>, seed}. Use exact color words and name the outfit fully;
    panels that list this id in `cast` get this text verbatim."""
    return _api("PUT", f"/api/stories/{story}/cast/{cast_id}", json=entry)


@server.tool()
def prompt_preview(story: str, panel: str) -> dict:
    """The exact prompt and reference images a panel will send (dry run). Check it before generating."""
    d = _api("GET", f"/api/stories/{story}")
    p = next((x for x in d["panels"] if x["id"] == panel), None)
    if p is None:
        raise RuntimeError(f"no panel {panel!r} in {story}")
    return {
        "prompt": p.get("prompt"),
        "refs": [{"image": i + 1, "label": r["label"], "path": r["path"]} for i, r in enumerate(p.get("resolved_refs", []))],
        "problem": p.get("plan_error"),
    }


# ---- generation --------------------------------------------------------------------


def _wait_jobs(ids: list[int], timeout: float) -> list[dict]:
    t0 = time.time()
    out = {}
    while len(out) < len(ids):
        for jid in ids:
            if jid in out:
                continue
            j = _api("GET", f"/api/jobs/{jid}")
            if j["status"] in ("done", "error", "cancelled"):
                out[jid] = j
        if len(out) < len(ids):
            if time.time() - t0 > timeout:
                break
            time.sleep(2)
    res = []
    for jid in ids:
        j = out.get(jid)
        if not j:
            res.append({"job": jid, "status": "still running (call generate again with wait or check later)"})
        elif j["status"] == "done":
            res.append({"job": jid, "panel": j["panel"], "status": "done", "file": j["file"], "seconds": round(j["finished"] - j["started"])})
        else:
            res.append({"job": jid, "panel": j["panel"], "status": j["status"], "error": j.get("error")})
    return res


@server.tool()
def generate(story: str, panels: list[str], count: int = 1, seeds: list[int] | None = None, wait: bool = True, timeout_s: int = 1200) -> dict:
    """Queue generations (count versions per panel, or explicit seeds). Each image takes ~1-2 min on this Mac;
    the first job also loads the model. With wait=True, blocks and returns the new version files.
    Afterwards, view_image each result and compare against the refs before reporting."""
    ids = []
    for pid in panels:
        body: dict = {"story": story, "panel": pid, "count": count}
        if seeds:
            body["seeds"] = seeds
        ids += _api("POST", "/api/generate", json=body)["jobs"]
    if not wait:
        return {"jobs": ids}
    return {"results": _wait_jobs(ids, timeout_s)}


@server.tool()
def copilot(story: str, panel: str, mode: str = "img2img", prompt: str = "", strength: float = 0.6, count: int = 1, wait: bool = True) -> dict:
    """Targeted regeneration with the panel's cast reference sheets injected. mode: txt2img (fresh),
    img2img (edit the version in use; strength 0.6 keeps it close, 1.0 changes a lot). `prompt` is an extra
    instruction for this run only (e.g. "make her pout, cheeks puffed")."""
    body = {"mode": mode, "prompt": prompt or None, "strength": strength, "count": count}
    r = _api("POST", f"/api/stories/{story}/panels/{panel}/copilot", json={k: v for k, v in body.items() if v is not None})
    if not wait:
        return r
    return {"results": _wait_jobs(r["jobs"], 1200)}


@server.tool()
def view_image(story: str, panel: str, file: str | None = None, final: bool = False) -> Image:
    """Look at an image: a panel version (default: the version in use), or final=True for the composed
    panel with bubbles. Always look at new outputs before telling the user they're ready."""
    from PIL import Image as PILImage

    if final:
        rel = f"final/{panel}.png"
    else:
        if not file:
            d = _api("GET", f"/api/stories/{story}")
            p = next((x for x in d["panels"] if x["id"] == panel), None)
            if not p or not p.get("pick"):
                raise RuntimeError(f"{panel} has no image yet")
            file = p["pick"]
        rel = f"out/{panel}/{file}"
    try:
        r = httpx.get(f"{URL}/files/{story}/{rel}", timeout=30)
    except httpx.ConnectError as e:
        raise StudioOffline(f"The manga-studio backend isn't running at {URL}.") from e
    if r.status_code != 200:
        raise RuntimeError(f"no such image: {rel}")
    im = PILImage.open(io.BytesIO(r.content)).convert("RGB")
    im.thumbnail((1024, 1024))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return Image(data=buf.getvalue(), format="jpeg")


@server.tool()
def jobs(active_only: bool = True) -> list[dict]:
    """The generation queue (running and queued jobs, or recent history)."""
    return _api("GET", "/api/jobs", params={"active": "true"} if active_only else {})


# ---- feedback ------------------------------------------------------------------------


@server.tool()
def get_feedback(story: str, include_done: bool = False) -> dict:
    """The user's notes (with their index for resolve_note), picks and stars from the app. Read this every turn."""
    d = _api("GET", f"/api/stories/{story}")
    stt = d.get("state", {})
    notes = [dict(n, index=i) for i, n in enumerate(stt.get("notes", [])) if include_done or not n.get("done")]
    return {"notes": notes, "picks": stt.get("picks", {}), "stars": list(stt.get("stars", {}))}


@server.tool()
def resolve_note(story: str, index: int, reply: str) -> dict:
    """Close a user note with a one-line reply of what you changed (shown under the note in the app)."""
    return _api("POST", f"/api/stories/{story}/notes/done", json={"index": index, "reply": reply})


@server.tool()
def pick_version(story: str, panel: str, file: str | None) -> dict:
    """Choose which version a panel uses (as a reference and on the page). null clears the pick.
    Picks are the user's call: only do this when asked, or for reference panels while the user is away."""
    return _api("POST", f"/api/stories/{story}/pick", json={"panel": panel, "file": file})


@server.tool()
def auto_letter(story: str, panels: list[str] | None = None, overwrite: bool = False) -> dict:
    """Place speech bubbles automatically in quiet areas of the art, away from faces (`protect` boxes) and each
    other. Only bubbles without a position unless overwrite=True."""
    return _api("POST", f"/api/stories/{story}/letter", json={"panels": panels, "overwrite": overwrite})


@server.tool()
def export(story: str, formats: list[str] | None = None, preset: str = "digital") -> dict:
    """Export pages: formats from png, svg, pdf. preset: digital | print-b5 | print-a5 (print adds bleed)."""
    return _api("POST", f"/api/stories/{story}/export", json={"formats": formats or ["png", "pdf"], "preset": preset})


# ---- pipeline ------------------------------------------------------------------------


@server.tool()
def pipeline_new(title: str, text: str, mode: str = "page", direction: str = "rtl", provider: str = "agent") -> dict:
    """Start a project from prose (a chapter or short story). provider: agent (you do analysis, script and QA
    through pipeline_task/pipeline_submit), ollama (a local model does them) or heuristic (rule-based draft).
    Runs immediately; follow with pipeline_status / pipeline_task."""
    return _api("POST", "/api/pipeline/new", json={"title": title, "text": text, "mode": mode, "direction": direction, "provider": provider})


@server.tool()
def pipeline_status(story: str) -> dict:
    """Stage statuses (idle, running, awaiting_agent, done, error, flagged), details, QA results and coverage."""
    s = _api("GET", f"/api/stories/{story}/pipeline")
    cov = _api("GET", f"/api/stories/{story}/coverage")
    return {
        "provider": s["provider"],
        "running": s["running"],
        "stages": [{k: x.get(k) for k in ("id", "status", "detail", "progress")} for x in s["stages"]],
        "waiting_for_you": s["task"]["stage"] if s.get("task") else None,
        "qa": s.get("qa"),
        "coverage": {"covered_ratio": cov["covered_ratio"], "gaps": cov["gaps"][:10]},
    }


@server.tool()
def pipeline_run(story: str, from_stage: str | None = None, to_stage: str | None = None, provider: str | None = None) -> dict:
    """Run (or resume) the pipeline. Stages: analysis, script, layout, artwork, lettering, qa. Without
    from_stage it resumes at the first unfinished stage; pass from_stage to redo a stage and everything after."""
    body = {"from": from_stage, "to": to_stage, "provider": provider}
    s = _api("POST", f"/api/stories/{story}/pipeline/run", json={k: v for k, v in body.items() if v})
    return {"running": s["running"], "stages": [{k: x.get(k) for k in ("id", "status", "detail")} for x in s["stages"]]}


@server.tool()
def pipeline_task(story: str) -> dict | None:
    """The stage waiting for you: {stage, instructions, input, schema}. Follow the instructions exactly, then
    pipeline_submit a result matching the schema. For qa, view each panel image (paths are in input.panels;
    view_image works too) before judging. Returns null when nothing is waiting."""
    return _api("GET", f"/api/stories/{story}/pipeline/task")


@server.tool()
def pipeline_submit(story: str, stage: str, result: dict) -> dict:
    """Submit your result for the waiting stage. It's validated against the task's schema (an error tells you
    what to fix); on success the pipeline continues by itself."""
    s = _api("POST", f"/api/stories/{story}/pipeline/submit", json={"stage": stage, "result": result})
    return {"running": s["running"], "stages": [{k: x.get(k) for k in ("id", "status", "detail")} for x in s["stages"]]}


def main() -> None:
    server.run("stdio")


if __name__ == "__main__":
    main()
