"""Dashboard + generation server. One worker thread owns the model; jobs run one at a time.

Run:  uv run studio serve        (STUDIO_ENGINE=mock for placeholder images)
"""

from __future__ import annotations

import asyncio
import itertools
import json
import queue
import random
import threading
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from studio import story as st
from studio.engine import make_engine

DASHBOARD = Path(__file__).resolve().parent.parent / "dashboard" / "index.html"

app = FastAPI(title="manga-studio")
engine = make_engine()
jobs: dict[int, dict] = {}
_ids = itertools.count(1)
_q: "queue.Queue[int]" = queue.Queue()
_rev = 0  # bumps on any change; the dashboard re-fetches when it moves
_rev_lock = threading.Lock()


def bump():
    global _rev
    with _rev_lock:
        _rev += 1


# ---- worker -------------------------------------------------------------


def _worker():
    while True:
        jid = _q.get()
        job = jobs.get(jid)
        if not job or job["status"] != "queued":
            continue
        job.update(status="running", started=time.time(), step=0)
        bump()
        try:
            story = st.load(job["story"])
            out = st.next_version_name(story, job["panel"], job["plan"]["seed"])

            def progress(s, n):
                job.update(step=s, steps=n)
                bump()

            engine.generate(job["plan"], out, progress)
            meta = {
                **job["plan"],
                "engine": engine.name,
                "seconds": round(time.time() - job["started"], 1),
                "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                "job": jid,
            }
            out.with_suffix(".json").write_text(json.dumps(meta, indent=2))
            job.update(status="done", file=out.name)
        except Exception as e:  # keep the worker alive; surface the error in the dashboard/CLI
            job.update(status="error", error=f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-2000:])
        finally:
            job["finished"] = time.time()
            bump()


threading.Thread(target=_worker, daemon=True).start()


def _watch_files():
    """Bump when story.yaml / state.json / outputs change on disk (e.g. Claude edits the YAML)."""
    seen: dict[str, float] = {}
    while True:
        cur = {}
        for p in st.STORIES.glob("*/story.yaml"):
            cur[str(p)] = p.stat().st_mtime
        for p in st.STORIES.glob("*/state.json"):
            cur[str(p)] = p.stat().st_mtime
        for p in st.STORIES.glob("*/refs"):
            cur[str(p)] = p.stat().st_mtime
        if cur != seen:
            seen = cur
            bump()
        time.sleep(1)


threading.Thread(target=_watch_files, daemon=True).start()


# ---- api ----------------------------------------------------------------


def _mtime(p: Path) -> int | None:
    return int(p.stat().st_mtime * 1000) if p.exists() else None


def _story(slug: str) -> st.Story:
    try:
        return st.load(slug)
    except st.StoryError as e:
        raise HTTPException(404, str(e))


@app.get("/")
def index():
    return FileResponse(DASHBOARD)


@app.get("/api/status")
def status():
    return {"rev": _rev, **engine.status(), "queued": sum(j["status"] == "queued" for j in jobs.values())}


@app.get("/api/stories")
def stories():
    out = []
    for slug in st.list_stories():
        try:
            s = st.load(slug)
            out.append({"slug": slug, "title": s.data.get("title", slug), "panels": len(s.panels)})
        except st.StoryError as e:
            out.append({"slug": slug, "title": slug, "error": str(e)})
    return out


@app.get("/api/stories/{slug}")
def story_detail(slug: str):
    s = _story(slug)
    state = st.read_state(s)
    panels = []
    for p in s.panels:
        try:
            plan = s.plan(p["id"], seed=0)
            prompt, refs, err = plan["prompt"], plan["refs"], None
        except st.StoryError as e:
            prompt, refs, err = None, [], str(e)
        panels.append(
            {
                **{k: v for k, v in p.items()},
                "prompt": prompt,
                "resolved_refs": refs,
                "plan_error": err,
                "versions": st.versions(s, p["id"]),
                "pick": st.picked_version(s, p["id"]),
                "explicit_pick": state["picks"].get(p["id"]),
                "final": _mtime(s.dir / "final" / f"{p['id']}.png"),
            }
        )
    return {
        "slug": slug,
        "title": s.data.get("title", slug),
        "notes_md": s.data.get("notes"),
        "settings": s.settings(),
        "refs": sorted(p.name for p in (s.dir / "refs").glob("*") if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}),
        "panels": panels,
        "state": state,
        "strip": (s.dir / "final" / "strip.png").exists(),
    }


class GenReq(BaseModel):
    story: str
    panel: str
    seeds: list[int] | None = None
    count: int = 1


@app.post("/api/generate")
def generate(req: GenReq):
    s = _story(req.story)
    seeds = req.seeds or [random.randint(1, 99999) for _ in range(max(1, req.count))]
    if req.seeds is None and req.count == 1 and "seed" in s.panel(req.panel):
        seeds = [s.panel(req.panel)["seed"]]
    created = []
    for seed in seeds:
        try:
            plan = s.plan(req.panel, seed=seed)
        except st.StoryError as e:
            raise HTTPException(400, str(e))
        jid = next(_ids)
        jobs[jid] = {"id": jid, "story": req.story, "panel": req.panel, "status": "queued", "plan": plan, "queued_at": time.time()}
        _q.put(jid)
        created.append(jid)
    bump()
    return {"jobs": created, "seeds": seeds}


@app.get("/api/jobs")
def list_jobs(story: str | None = None, active: bool = False):
    out = []
    for j in sorted(jobs.values(), key=lambda j: j["id"], reverse=True):
        if story and j["story"] != story:
            continue
        if active and j["status"] not in ("queued", "running"):
            continue
        out.append({k: v for k, v in j.items() if k not in ("plan", "trace")} | {"seed": j["plan"]["seed"]})
    return out[:200]


@app.get("/api/jobs/{jid}")
def job(jid: int):
    if jid not in jobs:
        raise HTTPException(404, "no such job")
    return jobs[jid]


@app.delete("/api/jobs/{jid}")
def cancel(jid: int):
    j = jobs.get(jid)
    if not j:
        raise HTTPException(404, "no such job")
    if j["status"] != "queued":
        raise HTTPException(409, f"job is {j['status']}; only queued jobs can be cancelled")
    j["status"] = "cancelled"
    bump()
    return {"ok": True}


@app.get("/files/{slug}/{path:path}")
def files(slug: str, path: str):
    base = (st.STORIES / slug).resolve()
    p = (base / path).resolve()
    if not p.is_relative_to(base) or not p.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(p, headers={"Cache-Control": "no-cache"})


@app.get("/api/events")
async def events():
    async def gen():
        last = -1
        while True:
            if _rev != last:
                last = _rev
                yield f"data: {last}\n\n"
            await asyncio.sleep(0.4)

    return StreamingResponse(gen(), media_type="text/event-stream")
