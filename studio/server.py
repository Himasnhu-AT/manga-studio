"""Dashboard + generation server. One worker thread owns the model; jobs run one at a time.

Run:  uv run studio serve        (STUDIO_ENGINE=mock for placeholder images)
"""

from __future__ import annotations

import asyncio
import base64
import io
import itertools
import os
import re
import shutil
import json
import queue
import random
import threading
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from studio import appsvc, compose, drawing, export as exporter, imageedit, lettering, project as pj, story as st
from studio.engine import make_engine

DASHBOARD = st.ROOT / "dashboard" / "index.html"
APP_DIST = Path(os.environ.get("STUDIO_APP_DIST", st.ROOT / "app" / "dist"))

app = FastAPI(title="manga-studio")
# The Tauri webview (tauri://localhost) and the Vite dev server call the API cross-origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:1420", "http://127.0.0.1:1420", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"],
    allow_methods=["*"],
    allow_headers=["*"],
)
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
            if job.get("post"):
                job["post"](out)  # e.g. inpaint: blend the masked region back over the source
            meta = {
                **job["plan"],
                **job.get("meta", {}),
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
# Integration checks shell out to the agent CLIs (seconds each); warm the cache so onboarding is instant.
threading.Thread(target=lambda: appsvc.integrations(), daemon=True).start()


# ---- api ----------------------------------------------------------------


def _mtime(p: Path) -> int | None:
    return int(p.stat().st_mtime * 1000) if p.exists() else None


def _story_dir(slug: str) -> Path:
    """The folder for a story slug, or a 404. Rejects anything that isn't a direct child of
    stories/ (`..`, `.`, `a/b`, hidden folders), so a slug can never reach files outside it."""
    d = (st.STORIES / slug).resolve()
    if not slug or slug.startswith(".") or d.parent != st.STORIES:
        raise HTTPException(404, "not found")
    return d


def _story(slug: str) -> st.Story:
    _story_dir(slug)
    try:
        return st.load(slug)
    except st.StoryError as e:
        raise HTTPException(404, str(e))


@app.get("/")
def index():
    """The React app when it has been built (app/dist), else the v0.1 dashboard."""
    built = APP_DIST / "index.html"
    return FileResponse(built if built.exists() else DASHBOARD, headers={"Cache-Control": "no-cache"})


@app.get("/legacy")
def legacy():
    return FileResponse(DASHBOARD)


@app.get("/assets/{path:path}")
def app_assets(path: str):
    base = (APP_DIST / "assets").resolve()
    p = (base / path).resolve()
    if not p.is_relative_to(base) or not p.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(p)


@app.get("/api/status")
def status():
    return {"rev": _rev, **engine.status(), "queued": sum(j["status"] == "queued" for j in list(jobs.values()))}


@app.get("/api/stories")
def stories():
    out = []
    for slug in st.list_stories():
        try:
            s = st.load(slug)
            cover = None
            for p in s.panels:
                if p.get("strip", True) is False:
                    continue
                v = st.picked_version(s, p["id"])
                if v:
                    cover = f"out/{p['id']}/{v}"
                    break
            out.append(
                {
                    "slug": slug,
                    "title": s.data.get("title", slug),
                    "panels": sum(p.get("strip", True) is not False for p in s.panels),  # story panels, not ref sheets
                    "cover": cover,
                    "mode": s.format["mode"],
                    "updated": _mtime(s.dir / "story.yaml"),
                }
            )
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
                "subject": _subject_url(s, p["id"]),
                "drawing_files": {lp.stem: _mtime(lp) for _, lp in drawing.layers(s.dir, p)},
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
        "format": s.format,
        "cast": s.cast,
        "blocks": s.data.get("blocks") or {},
        "avoid": s.data.get("avoid"),
        "pages": s.data.get("pages") or [],
        "has_source": (s.dir / "source.md").exists(),
        "pipeline": _pipeline_summary(s),
    }


def _subject_url(s: st.Story, pid: str) -> str | None:
    """Cut-out mask of the picked version, with its mtime so a redo busts the browser cache."""
    rel = exporter.subject_rel(s, pid)
    return f"{rel}?v={_mtime(s.dir / rel)}" if rel else None


def _pipeline_summary(s: st.Story) -> dict | None:
    f = s.dir / "pipeline" / "state.json"
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text())
    except ValueError:
        return None
    return {"stages": [{"id": x.get("id"), "status": x.get("status", "idle")} for x in data.get("stages", [])]}


class GenReq(BaseModel):
    story: str
    panel: str
    seeds: list[int] | None = None
    count: int = 1


def enqueue(slug: str, pid: str, seeds: list[int] | None = None, count: int = 1, plan_mutator=None, meta: dict | None = None, post=None) -> tuple[list[int], list[int]]:
    """Queue generations for one panel. `plan_mutator(plan) -> plan` can rewrite refs/prompt/strength
    (Copilot, pipeline). `meta` is stored on the job and copied into the version's .json.
    Raises st.StoryError for a bad plan. Used by the HTTP API, Copilot and the pipeline."""
    s = st.load(slug)
    seeds = seeds or [random.randint(1, 99999) for _ in range(max(1, count))]
    created = []
    for seed in seeds:
        plan = s.plan(pid, seed=seed)
        if plan_mutator:
            plan = plan_mutator(plan)
        jid = next(_ids)
        jobs[jid] = {"id": jid, "story": slug, "panel": pid, "status": "queued", "plan": plan, "queued_at": time.time(), "meta": meta or {}}
        if post:
            jobs[jid]["post"] = post  # called with the output path after generation (worker thread)
        _q.put(jid)
        created.append(jid)
    bump()
    return created, seeds


@app.post("/api/generate")
def generate(req: GenReq):
    s = _story(req.story)
    seeds = req.seeds
    if seeds is None and req.count == 1 and "seed" in s.panel(req.panel):
        seeds = [s.panel(req.panel)["seed"]]
    try:
        created, seeds = enqueue(req.story, req.panel, seeds=seeds, count=req.count)
    except st.StoryError as e:
        raise HTTPException(400, str(e))
    return {"jobs": created, "seeds": seeds}


@app.get("/api/jobs")
def list_jobs(story: str | None = None, active: bool = False):
    out = []
    for j in sorted(list(jobs.values()), key=lambda j: j["id"], reverse=True):
        j = dict(j)
        if story and j["story"] != story:
            continue
        if active and j["status"] not in ("queued", "running"):
            continue
        out.append({k: v for k, v in j.items() if k not in ("plan", "trace", "post")} | {"seed": j["plan"]["seed"]})
    return out[:200]


@app.get("/api/jobs/{jid}")
def job(jid: int):
    j = jobs.get(jid)
    if j is None:
        raise HTTPException(404, "no such job")
    return {k: v for k, v in dict(j).items() if k != "post"}


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


class PickReq(BaseModel):
    panel: str
    file: str | None  # None clears the pick (falls back to newest)


@app.post("/api/stories/{slug}/pick")
def pick(slug: str, req: PickReq):
    s = _story(slug)
    s.panel(req.panel)
    if req.file is not None:
        names = [v["file"] for v in st.versions(s, req.panel)]
        if req.file not in names:
            raise HTTPException(400, f"{req.file!r} is not a version of {req.panel} (have: {', '.join(names) or 'none'})")

    def f(state):
        if req.file:
            state["picks"][req.panel] = req.file
        else:
            state["picks"].pop(req.panel, None)

    st.update_state(s, f)
    bump()
    return {"ok": True}


class StarReq(BaseModel):
    panel: str
    file: str
    value: bool


@app.post("/api/stories/{slug}/star")
def star(slug: str, req: StarReq):
    s = _story(slug)

    def f(state):
        key = f"{req.panel}/{req.file}"
        if req.value:
            state["stars"][key] = True
        else:
            state["stars"].pop(key, None)

    st.update_state(s, f)
    bump()
    return {"ok": True}


class NoteReq(BaseModel):
    panel: str | None = None
    file: str | None = None
    text: str


@app.post("/api/stories/{slug}/notes")
def add_note(slug: str, req: NoteReq):
    s = _story(slug)
    st.update_state(
        s,
        lambda state: state["notes"].append(
            {"panel": req.panel, "file": req.file, "text": req.text, "at": time.strftime("%Y-%m-%d %H:%M:%S"), "done": False}
        ),
    )
    bump()
    return {"ok": True}


class NoteDone(BaseModel):
    index: int
    done: bool = True
    reply: str | None = None


@app.post("/api/stories/{slug}/notes/done")
def note_done(slug: str, req: NoteDone):
    s = _story(slug)

    def f(state):
        if not 0 <= req.index < len(state["notes"]):
            raise HTTPException(404, "no such note")
        state["notes"][req.index]["done"] = req.done
        if req.reply:
            state["notes"][req.index]["reply"] = req.reply

    st.update_state(s, f)
    bump()
    return {"ok": True}


@app.post("/api/stories/{slug}/compose")
def do_compose(slug: str):
    s = _story(slug)
    r = compose.compose_story(s)
    bump()
    return r


@app.get("/files/{slug}/{path:path}")
def files(slug: str, path: str):
    base = _story_dir(slug)
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


# ---- v0.2: projects + editing ----------------------------------------------

STAGES = ("name", "pencils", "inks", "blacks", "tone", "finish", "letters")  # traditional production order
PANEL_KEYS = {
    "title", "action", "refs", "use", "cast", "bubbles", "sfx", "layers", "crop", "protect",
    "seed", "strength", "strip", "width", "height", "ref_label", "avoid", "steps", "output_resolution",
    "camera", "source_span", "beat", "location",  # written by the pipeline; editable from the UI
    "drawing", "stage",  # hand-drawn layers (studio/drawing.py) and the production stage
}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def _edit(slug: str):
    if not (_story_dir(slug) / "story.yaml").exists():
        raise HTTPException(404, f"no story {slug!r}")
    return pj.edit(slug)


def _checked(slug: str) -> st.Story:
    """Reload after an edit so a broken result surfaces as a 400 instead of a broken dashboard."""
    try:
        return st.load(slug)
    except st.StoryError as e:
        raise HTTPException(400, str(e))


def _unique_slug(base: str) -> str:
    base = st.slugify(base)[:48] or "story"
    slug, n = base, 2
    while (st.STORIES / slug).exists():
        slug, n = f"{base}-{n}", n + 1
    return slug


class ProjectReq(BaseModel):
    title: str
    slug: str | None = None
    mode: str = "page"
    direction: str = "rtl"
    template: str = "blank"


def create_project(title: str, mode: str = "page", direction: str = "rtl", template: str = "blank", slug: str | None = None) -> str:
    """Shared with the pipeline (`/api/pipeline/new`). Returns the new slug."""
    if mode not in ("page", "webtoon") or direction not in ("rtl", "ltr"):
        raise st.StoryError("mode must be page|webtoon and direction rtl|ltr")
    slug = st.slugify(slug) if slug else _unique_slug(title)
    if not _SLUG_RE.match(slug):
        raise st.StoryError(f"bad slug {slug!r}")
    d = st.STORIES / slug
    if d.exists():
        raise st.StoryError(f"{slug!r} already exists")
    (d / "refs").mkdir(parents=True)
    if template == "sample":
        src = st.sample_dir()
        if not (src / "story.yaml").exists():
            shutil.rmtree(d)
            raise st.StoryError(f"the sample story ({st.SAMPLE}) is missing")
        (d / "story.yaml").write_text((src / "story.yaml").read_text())
        for f in (src / "refs").glob("*"):
            if f.suffix.lower() in IMAGE_EXT:
                shutil.copy2(f, d / "refs" / f.name)
    elif template == "blank":
        (d / "story.yaml").write_text((st.ROOT / "templates" / "story.yaml").read_text().replace("TITLE", title.replace("\n", " ")))
    else:
        shutil.rmtree(d)
        raise st.StoryError(f"unknown template {template!r} (blank|sample)")
    with pj.edit(slug) as data:
        data["title"] = title
        fmt = data.get("format") or pj.from_plain({})
        fmt["mode"], fmt["direction"] = mode, direction
        data["format"] = fmt
    bump()
    return slug


@app.post("/api/projects")
def new_project(req: ProjectReq):
    try:
        return {"slug": create_project(req.title, req.mode, req.direction, req.template, req.slug)}
    except st.StoryError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/stories/{slug}")
def patch_story(slug: str, body: dict):
    allowed = {"title", "notes", "format", "blocks", "avoid"}
    bad = set(body) - allowed
    if bad:
        raise HTTPException(400, f"can't set {', '.join(sorted(bad))} here (allowed: {', '.join(sorted(allowed))})")
    with _edit(slug) as data:
        for k, v in body.items():
            if k in ("format", "blocks") and isinstance(v, dict):
                cur = data.get(k)
                if cur is None:
                    data[k] = cur = pj.from_plain({})
                pj.set_keys(cur, v)  # merge; None deletes a key
            elif v is None:
                data.pop(k, None)
            else:
                data[k] = pj.from_plain(v)
    _checked(slug)
    bump()
    return {"ok": True}


class AddPanelReq(BaseModel):
    id: str | None = None
    title: str | None = None
    after: str | None = None
    page: str | None = None


def _next_pid(data) -> str:
    nums = [int(m.group(1)) for p in data.get("panels") or [] if (m := re.fullmatch(r"p(\d+)", str(p.get("id"))))]
    return f"p{max(nums, default=0) + 1:02d}"


@app.post("/api/stories/{slug}/panels")
def add_panel(slug: str, req: AddPanelReq):
    with _edit(slug) as data:
        panels = data.get("panels")
        if panels is None:
            data["panels"] = panels = pj.from_plain([])
        pid = req.id or _next_pid(data)
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", pid) or any(p.get("id") == pid for p in panels):
            raise HTTPException(400, f"panel id {pid!r} is invalid or taken")
        blocks = data.get("blocks") or {}
        new = {"id": pid, "title": req.title or f"Panel {pid}", "refs": [], "use": [k for k in ("style", "setting") if k in blocks], "action": ""}
        idx = len(panels)
        if req.after:
            idx = next((i + 1 for i, p in enumerate(panels) if p.get("id") == req.after), idx)
        panels.insert(idx, pj.from_plain(new))
        if req.page:
            page = next((pg for pg in data.get("pages") or [] if pg.get("id") == req.page), None)
            if page is None:
                raise HTTPException(404, f"no page {req.page!r}")
            ids = [sl["panel"] for sl in page.get("panels") or []] + [pid]
            rtl = (data.get("format") or {}).get("direction", "rtl") == "rtl"
            gut = float((data.get("format") or {}).get("gutter", 0.018))
            boxes = exporter._template(len(ids), gut * 1.4, rtl) if len(ids) <= 6 else None
            if boxes is None:
                raise HTTPException(400, "a page holds at most 6 panels with the auto template")
            page["panels"] = pj.from_plain([{"panel": i, "box": b} for i, b in zip(ids, boxes)])
    _checked(slug)
    bump()
    return {"id": pid}


@app.patch("/api/stories/{slug}/panels/{pid}")
def patch_panel(slug: str, pid: str, body: dict):
    with _edit(slug) as data:
        try:
            pj.set_keys(pj.panel(data, pid), body, PANEL_KEYS)
        except st.StoryError as e:
            raise HTTPException(400, str(e))
    _checked(slug)
    bump()
    return {"ok": True}


class OrderReq(BaseModel):
    order: list[str]


@app.put("/api/stories/{slug}/panels/order")
def order_panels(slug: str, req: OrderReq):
    """Reorder `panels:`. Each panel keeps its own comments (ruamel stores them per index, so they move too)."""
    with _edit(slug) as data:
        panels = data.get("panels") or []
        ids = [p.get("id") for p in panels]
        if sorted(req.order) != sorted(ids) or len(set(req.order)) != len(req.order):
            raise HTTPException(400, f"order must list every panel exactly once (have: {', '.join(ids)})")
        old, old_ca = list(panels), dict(panels.ca.items)
        at = {pid: i for i, pid in enumerate(ids)}
        new_ca = {}
        for i, pid in enumerate(req.order):
            panels[i] = old[at[pid]]
            if at[pid] in old_ca:
                new_ca[i] = old_ca[at[pid]]
        panels.ca.items.clear()
        panels.ca.items.update(new_ca)
    _checked(slug)
    bump()
    return {"ok": True, "order": req.order}


@app.delete("/api/stories/{slug}/panels/{pid}")
def delete_panel(slug: str, pid: str):
    with _edit(slug) as data:
        panels = data.get("panels") or []
        i = next((i for i, p in enumerate(panels) if p.get("id") == pid), None)
        if i is None:
            raise HTTPException(404, f"no panel {pid!r}")
        del panels[i]
        for page in data.get("pages") or []:
            slots = page.get("panels") or []
            for j in reversed(range(len(slots))):
                if slots[j].get("panel") == pid:
                    del slots[j]
    bump()
    return {"ok": True}  # generated versions in out/<pid>/ are kept on disk


class PagesReq(BaseModel):
    pages: list[dict]


@app.put("/api/stories/{slug}/pages")
def put_pages(slug: str, req: PagesReq):
    s = _story(slug)
    ids = {p["id"] for p in s.panels}
    for pg in req.pages:
        if not pg.get("id"):
            raise HTTPException(400, "every page needs an id")
        where = f"page {pg['id']}"
        bg = pg.get("background")
        if bg is not None:
            if not isinstance(bg, dict) or bg.get("panel") not in ids:
                raise HTTPException(400, f"{where}: background needs a known panel")
            op = bg.get("opacity", 0.35)
            if not isinstance(op, (int, float)) or not 0 <= op <= 1:
                raise HTTPException(400, f"{where}: background opacity is 0..1")
        if pg.get("paper", "white") not in exporter.PAPERS:
            raise HTTPException(400, f"{where}: paper is white or black")
        for sl in pg.get("panels") or []:
            pid = sl.get("panel", "")
            if pid != "" and pid not in ids:  # "" is an empty slot waiting for a panel
                raise HTTPException(400, f"{where}: unknown panel {pid!r}")
            box = sl.get("box")
            if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
                raise HTTPException(400, f"{where}: panel {pid or '(empty)'} needs box [x, y, w, h]")
            if sl.get("border", "normal") not in exporter.BORDERS:
                raise HTTPException(400, f"{where}: border is one of {', '.join(exporter.BORDERS)}")
            if sl.get("subject") not in (None, *exporter.SUBJECTS):
                raise HTTPException(400, f"{where}: subject is pop or cutout")
            poly = sl.get("poly")
            if poly is not None and not (isinstance(poly, list) and len(poly) >= 3 and all(isinstance(v, list) and len(v) == 2 for v in poly)):
                raise HTTPException(400, f"{where}: poly is a list of at least 3 [x, y] points")
    with _edit(slug) as data:
        data["pages"] = pj.from_plain(req.pages)
    bump()
    return {"ok": True}


class AutoPagesReq(BaseModel):
    per_page: int | None = 4


@app.post("/api/stories/{slug}/pages/auto")
def auto_pages(slug: str, req: AutoPagesReq):
    pages = exporter.auto_pages(_story(slug), req.per_page or 4)
    with _edit(slug) as data:
        data["pages"] = pj.from_plain(pages)
    bump()
    return {"pages": pages}


@app.put("/api/stories/{slug}/cast/{cid}")
def put_cast(slug: str, cid: str, body: dict):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,39}", cid):
        raise HTTPException(400, "cast id: lowercase letters, digits, - or _")
    entry = {k: v for k, v in body.items() if v not in (None, "", [])}
    entry.setdefault("name", cid.title())
    with _edit(slug) as data:
        cast = data.get("cast")
        if cast is None:
            data["cast"] = cast = pj.from_plain({})
        cast[cid] = pj.from_plain(entry)
        cast.fa.set_block_style()  # the template starts with `cast: {}`; keep entries one per line
    _checked(slug)
    bump()
    return {"ok": True}


@app.delete("/api/stories/{slug}/cast/{cid}")
def delete_cast(slug: str, cid: str):
    with _edit(slug) as data:
        cast = data.get("cast") or {}
        if cid not in cast:
            raise HTTPException(404, f"no cast member {cid!r}")
        del cast[cid]
        for p in data.get("panels") or []:
            for key in ("cast", "use"):
                lst = p.get(key)
                if lst and cid in lst and not (key == "use" and cid in (data.get("blocks") or {})):
                    lst.remove(cid)
    bump()
    return {"ok": True}


@app.post("/api/stories/{slug}/refs")
async def upload_ref(slug: str, file: UploadFile = File(...)):
    s = _story(slug)
    name = Path(file.filename or "ref.png").name
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    if ext not in IMAGE_EXT:
        raise HTTPException(400, f"images only ({', '.join(sorted(IMAGE_EXT))})")
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-")[:60] or "ref"
    data = await file.read()
    try:
        from PIL import Image

        Image.open(io.BytesIO(data)).verify()
    except Exception:
        raise HTTPException(400, "that file isn't a readable image")
    dest = s.dir / "refs" / f"{stem}{ext}"
    n = 2
    while dest.exists():
        dest = s.dir / "refs" / f"{stem}-{n}{ext}"
        n += 1
    dest.parent.mkdir(exist_ok=True)
    dest.write_bytes(data)
    bump()
    return {"name": dest.name}


# ---- your own art: import a drawing as a panel version --------------------------------

ART_EXT = IMAGE_EXT | {".psd", ".tif", ".tiff", ".bmp"}
ART_MAX_SIDE = 3200  # scans at 600 dpi are huge; this keeps line work crisp and the model happy


def _read_art(data: bytes):
    """Any image (PSD flattened) -> RGB on white paper, at most ART_MAX_SIDE on the long side."""
    from PIL import Image

    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception:
        raise HTTPException(400, "that file isn't a readable image")
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        paper = Image.new("RGBA", im.size, (255, 255, 255, 255))
        paper.alpha_composite(im)
        im = paper
    im = im.convert("RGB")
    if max(im.size) > ART_MAX_SIDE:
        im.thumbnail((ART_MAX_SIDE, ART_MAX_SIDE), Image.LANCZOS)
    return im


def save_art_version(s: st.Story, pid: str, img, meta: dict, pick: bool = True) -> str:
    """Write `img` as the panel's next version (seed 0) with a .json saying where it came from; pick it."""
    out = st.next_version_name(s, pid, 0)
    img.save(out)
    full = {"seed": 0, "width": img.width, "height": img.height, "engine": "import", "created": time.strftime("%Y-%m-%d %H:%M:%S"), **meta}
    out.with_suffix(".json").write_text(json.dumps(full, indent=2))
    if pick:
        st.update_state(s, lambda state: state["picks"].__setitem__(pid, out.name))
    bump()
    return out.name


@app.post("/api/stories/{slug}/panels/{pid}/import")
async def import_art(slug: str, pid: str, file: UploadFile = File(...)):
    """Your drawing (sketch, scan, inks, finished art) becomes a new version of the panel and is put in use.
    Nothing is generated. PNG, JPG, WebP, PSD (flattened), TIFF, BMP."""
    s = _edit_panel_story(slug, pid)
    name = Path(file.filename or "art.png").name
    if Path(name).suffix.lower() not in ART_EXT:
        raise HTTPException(400, f"images only ({', '.join(sorted(ART_EXT))})")
    img = _read_art(await file.read())
    return {"file": save_art_version(s, pid, img, {"imported": name})}


# ---- scanned pages: a whole hand-drawn page in, panels and a page layout out -----------


@app.post("/api/stories/{slug}/pages/scan")
async def scan_page(slug: str, file: UploadFile = File(...)):
    """Keep a scanned / exported page in scans/ and find its panels. Nothing is created yet: the artist
    reviews the boxes, then POST .../pages/scan/apply."""
    from studio import pagescan

    s = _story(slug)
    name = Path(file.filename or "page.png").name
    if Path(name).suffix.lower() not in ART_EXT:
        raise HTTPException(400, f"images only ({', '.join(sorted(ART_EXT))})")
    img = _read_art(await file.read())
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(name).stem).strip("-")[:60] or "page"
    dest = s.dir / "scans" / f"{stem}.png"
    n = 2
    while dest.exists():
        dest = s.dir / "scans" / f"{stem}-{n}.png"
        n += 1
    dest.parent.mkdir(exist_ok=True)
    img.save(dest)
    rtl = s.format.get("direction", "rtl") == "rtl"
    return {"scan": f"scans/{dest.name}", "size": list(img.size), "panels": pagescan.detect_panels(img, rtl)}


class ScanApplyReq(BaseModel):
    scan: str  # scans/<name>.png from /pages/scan
    boxes: list[list[float]]  # [x, y, w, h] fractions of the scan, in reading order
    stage: str | None = None  # e.g. pencils, inks, finish
    title: str | None = None


@app.post("/api/stories/{slug}/pages/scan/apply")
def apply_scan(slug: str, req: ScanApplyReq):
    """One panel per box (its crop of the scan is version 1, in use) and a new page that places them where
    they were drawn. Boxes past the margins become bleed slots."""
    from PIL import Image

    s = _story(slug)
    src = (s.dir / req.scan).resolve()
    if not src.is_relative_to((s.dir / "scans").resolve()) or not src.is_file():
        raise HTTPException(400, "unknown scan; upload it with /pages/scan first")
    if not req.boxes or len(req.boxes) > 20:
        raise HTTPException(400, "send 1 to 20 boxes")
    if any(len(b) != 4 or b[2] <= 0.01 or b[3] <= 0.01 for b in req.boxes):
        raise HTTPException(400, "each box is [x, y, w, h] fractions with some size")
    if req.stage is not None and req.stage not in STAGES:
        raise HTTPException(400, f"stage is one of {', '.join(STAGES)}")
    scan = Image.open(src).convert("RGB")
    W, H = scan.size
    f = s.format
    pw, ph = f["page"]["width"], f["page"]["height"]
    mx = float(f.get("margin", 0.06))
    my = mx * pw / ph
    label = req.title or src.stem.replace("-", " ")
    with _edit(slug) as data:
        panels = data.get("panels")
        if panels is None:
            data["panels"] = panels = pj.from_plain([])
        pages = data.get("pages")
        if pages is None:
            data["pages"] = pages = pj.from_plain([])
        made, slots = [], []
        for k, (x, y, w, h) in enumerate(req.boxes, 1):
            pid = _next_pid(data)
            entry = {"id": pid, "title": f"{label} {k}", "refs": [], "use": [], "action": ""}
            if req.stage:
                entry["stage"] = req.stage
            panels.append(pj.from_plain(entry))
            made.append(pid)
            # scan fractions -> live-area fractions; anything past the margin bleeds off the page
            lx0, ly0 = (x - mx) / (1 - 2 * mx), (y - my) / (1 - 2 * my)
            lx1, ly1 = (x + w - mx) / (1 - 2 * mx), (y + h - my) / (1 - 2 * my)
            bleed = lx0 < -0.01 or ly0 < -0.01 or lx1 > 1.01 or ly1 > 1.01
            lx0, ly0, lx1, ly1 = max(0.0, lx0), max(0.0, ly0), min(1.0, lx1), min(1.0, ly1)
            # the crop already holds the artist's own frame line, so the slot draws none
            slot = {"panel": pid, "box": [round(lx0, 4), round(ly0, 4), round(lx1 - lx0, 4), round(ly1 - ly0, 4)], "border": "none"}
            if bleed:
                slot["bleed"] = True
            slots.append(slot)
        ids = {str(pg.get("id")) for pg in pages}
        n = len(pages) + 1
        while f"pg{n}" in ids:
            n += 1
        page_id = f"pg{n}"
        pages.append(pj.from_plain({"id": page_id, "panels": slots}))
    s = st.load(slug)
    for pid, (x, y, w, h) in zip(made, req.boxes):
        box = (max(0, round(x * W)), max(0, round(y * H)), min(W, round((x + w) * W)), min(H, round((y + h) * H)))
        save_art_version(s, pid, scan.crop(box), {"imported": req.scan, "scan_box": [x, y, w, h]})
    bump()
    return {"page": page_id, "panels": made}


# ---- drawing layers: the artist's own strokes ---------------------------------------


class LayerReq(BaseModel):
    png: str  # data URL of the layer canvas (RGBA)


@app.put("/api/stories/{slug}/panels/{pid}/drawing/{lid}")
def put_layer(slug: str, pid: str, lid: str, req: LayerReq):
    """Save one drawing layer's pixels. The layer list (names, order, opacity) is the panel's `drawing` key."""
    s = _edit_panel_story(slug, pid)
    try:
        drawing.save_layer(s.dir, pid, lid, req.png)
    except drawing.DrawingError as e:
        raise HTTPException(400, str(e))
    bump()
    return {"ok": True}


@app.delete("/api/stories/{slug}/panels/{pid}/drawing/{lid}")
def delete_layer(slug: str, pid: str, lid: str):
    s = _edit_panel_story(slug, pid)
    try:
        drawing.layer_path(s.dir, pid, lid).unlink(missing_ok=True)
    except drawing.DrawingError as e:
        raise HTTPException(400, str(e))
    bump()
    return {"ok": True}


@app.post("/api/stories/{slug}/panels/{pid}/drawing/merge")
def merge_drawing(slug: str, pid: str):
    """Bake the visible layers into a new version (over the version in use, or white paper) and clear them,
    so Refine, edits and the model see the drawing. The new version is put in use."""
    from PIL import Image

    s = _edit_panel_story(slug, pid)
    panel = s.panel(pid)
    drawn = drawing.layers(s.dir, panel)
    if not drawn:
        raise HTTPException(400, "nothing drawn on this panel yet")
    v = st.picked_version(s, pid)
    base = Image.open(s.dir / "out" / pid / v).convert("RGBA") if v else Image.new("RGBA", drawing.size(s.dir, panel), (255, 255, 255, 255))
    img = drawing.composite(s.dir, panel, base).convert("RGB")
    f = save_art_version(s, pid, img, {"engine": "drawing", "drawn_on": v, "layers": [spec.get("name") or spec.get("id") for spec, _ in drawn]})
    for _, p in drawn:
        p.unlink(missing_ok=True)
    bump()
    return {"file": f}


# ---- refine sketch: your drawing in, a cleaner stage out ------------------------------

KEEP = "Keep every pose, proportion, expression, panel composition and line placement exactly as drawn."
REFINE_PRESETS = {
    "clean": {"strength": 0.45, "label": "Clean lines", "prompt": f"Clean up this rough pencil sketch into crisp, clean black line art on white paper. Remove construction lines and blue pencil. {KEEP} No color, no shading, no screentone."},
    "inks": {"strength": 0.55, "label": "Inks", "prompt": f"Ink this sketch as finished manga line art: confident black pen lines with varied line weight, solid black fills for dark hair and deep shadows, white paper. {KEEP} No color, no screentone."},
    "tone": {"strength": 0.6, "label": "Inks + tone", "prompt": f"Finish this sketch as a printed black-and-white manga panel: clean inked lines, solid blacks and dot screentone shading. {KEEP} No color."},
    "color": {"strength": 0.7, "label": "Full color", "prompt": f"Render this sketch as a finished full-color illustration with clean line art and soft cel shading, in the story's style. {KEEP}"},
}


def _render_size(src_path: Path, s: st.Story) -> tuple[int, int]:
    """The drawing's shape at the story's usual pixel count, in multiples of 16 (a 3000 px scan would not fit in memory)."""
    from PIL import Image

    d = s.settings()
    area = int(d.get("width", 864)) * int(d.get("height", 1152))
    with Image.open(src_path) as im:
        aspect = im.width / im.height
    w = (area * aspect) ** 0.5
    return max(256, round(w / 16) * 16), max(256, round(w / aspect / 16) * 16)


class RefineReq(BaseModel):
    preset: str = "inks"
    strength: float | None = None  # lower keeps more of the drawing
    count: int = 3
    source: str | None = None  # version to refine (default: the one in use)
    prompt: str | None = None  # extra direction


@app.post("/api/stories/{slug}/panels/{pid}/refine")
def refine_sketch(slug: str, pid: str, req: RefineReq):
    """Turn the artist's drawing into clean lines, inks, toned inks or color, keeping their composition.
    Each result is a new version (meta: refine, source); the drawing itself is never changed."""
    if req.preset not in REFINE_PRESETS:
        raise HTTPException(400, f"preset is one of {', '.join(REFINE_PRESETS)}")
    s = _edit_panel_story(slug, pid)
    src, path = _version_path(s, pid, req.source)
    pr = REFINE_PRESETS[req.preset]
    strength = max(0.2, min(1.0, req.strength if req.strength is not None else pr["strength"]))
    prompt = pr["prompt"] + (f" {req.prompt.strip()}" if req.prompt and req.prompt.strip() else "")
    try:
        created, seeds = queue_from_source(
            slug, pid, src, "img2img", prompt, strength, max(1, min(4, req.count)),
            meta={"refine": req.preset}, size=_render_size(path, s),
            source_label="the artist's own drawing of this panel: follow it exactly",
        )
    except st.StoryError as e:
        raise HTTPException(400, str(e))
    return {"jobs": created, "seeds": seeds, "source": src, "strength": strength}


# ---- copilot ---------------------------------------------------------------


class CopilotReq(BaseModel):
    mode: str = "txt2img"
    prompt: str | None = None
    source: str | None = None
    mask: str | None = None
    strength: float | None = None
    count: int = 1


def _with_instruction(prompt: str, extra: str | None) -> str:
    if not extra or not extra.strip():
        return prompt
    note = f"EDIT: {extra.strip()}"
    i = prompt.rfind("\n\nAvoid:")
    return prompt[:i] + "\n\n" + note + prompt[i:] if i >= 0 else prompt + "\n\n" + note


def _decode_mask(data_url: str):
    from PIL import Image

    try:
        raw = base64.b64decode(data_url.split(",", 1)[1] if "," in data_url else data_url)
        m = Image.open(io.BytesIO(raw))
        m.load()
    except Exception:
        raise HTTPException(400, "mask must be a PNG data URL (white = change)")
    if m.mode in ("RGBA", "LA"):  # painted strokes on a transparent canvas: alpha is the mask
        alpha = m.getchannel("A")
        lum = m.convert("L")
        from PIL import ImageChops

        return ImageChops.multiply(alpha, lum) if lum.getextrema()[1] > 0 else alpha
    return m.convert("L")


def _inpaint_post(source_path: Path, mask):
    from PIL import Image, ImageFilter

    def post(out: Path):
        new = Image.open(out).convert("RGB")
        src = Image.open(source_path).convert("RGB").resize(new.size, Image.LANCZOS)
        m = mask.resize(new.size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(max(2, new.width // 220)))
        Image.composite(new, src, m).save(out)

    return post


def _version_path(s: st.Story, pid: str, name: str | None) -> tuple[str, Path]:
    """A version file of this panel by exact name (default: the one in use). Never a path."""
    name = name or st.picked_version(s, pid)
    if not name:
        raise HTTPException(400, f"{pid} has no version yet; generate one first")
    names = {v["file"] for v in st.versions(s, pid)}
    if name not in names:
        raise HTTPException(400, f"{name!r} is not a version of {pid}")
    return name, s.dir / "out" / pid / name


def queue_from_source(slug: str, pid: str, src: str, mode: str, prompt: str | None, strength: float, count: int, mask=None, meta: dict | None = None, fit_source: bool = False, size: tuple[int, int] | None = None, source_label: str | None = None) -> tuple[list[int], list[int]]:
    """img2img / inpaint jobs that start from one version. The panel's own blocks, cast and refs are kept
    (the source goes in as image 1), so characters stay on model. `mask` (PIL L, white = repaint) makes it an
    inpaint: only that region changes. `fit_source` renders at the source's size (crops, extends)."""
    s = st.load(slug)
    panel = s.panel(pid)
    src_path = s.dir / "out" / pid / src
    if fit_source and size is None:
        from PIL import Image

        with Image.open(src_path) as im:
            f = max(1.0, 256 / min(im.size))  # tiny sources render at >= 256px, same aspect
            size = (round(im.width * f / 16) * 16, round(im.height * f / 16) * 16)

    def mutate(plan):
        first = {"name": f"{pid}/{src}", "path": str(src_path), "version": src, "label": source_label or "the current panel, keep its composition and characters"}
        refs = [first] + [r for r in plan["refs"] if r["path"] != str(src_path)]
        plan["refs"] = refs[:10]
        plan["prompt"] = _with_instruction(s.build_prompt(panel, plan["refs"]), prompt)
        plan["strength"] = strength
        if size:
            plan["width"], plan["height"] = size
        return plan

    post = _inpaint_post(src_path, mask) if mask is not None else None
    return enqueue(slug, pid, count=max(1, min(8, count)), plan_mutator=mutate, meta={"copilot": mode, "source": src, **(meta or {})}, post=post)


@app.post("/api/stories/{slug}/panels/{pid}/copilot")
def copilot(slug: str, pid: str, req: CopilotReq):
    s = _story(slug)
    try:
        panel = s.panel(pid)
    except st.StoryError as e:
        raise HTTPException(404, str(e))
    if req.mode not in ("txt2img", "img2img", "inpaint"):
        raise HTTPException(400, "mode must be txt2img, img2img or inpaint")
    count = max(1, min(8, req.count))
    if req.mode == "txt2img":
        seeds = None
        if count == 1:
            seed = panel.get("seed") or next((s.cast[c].get("seed") for c in panel.get("cast") or [] if s.cast.get(c, {}).get("seed")), None)
            seeds = [int(seed)] if seed else None

        def mutate(plan):
            plan["prompt"] = _with_instruction(plan["prompt"], req.prompt)
            return plan

        try:
            created, seeds = enqueue(slug, pid, seeds=seeds, count=count, plan_mutator=mutate, meta={"copilot": "txt2img"})
        except st.StoryError as e:
            raise HTTPException(400, str(e))
        return {"jobs": created, "seeds": seeds}
    src, _ = _version_path(s, pid, req.source)
    strength = req.strength if req.strength is not None else (0.6 if req.mode == "img2img" else 0.85)
    mask = None
    if req.mode == "inpaint":
        if not req.mask:
            raise HTTPException(400, "inpaint needs a mask")
        mask = _decode_mask(req.mask)
    try:
        created, seeds = queue_from_source(slug, pid, src, req.mode, req.prompt, strength, count, mask=mask)
    except st.StoryError as e:
        raise HTTPException(400, str(e))
    return {"jobs": created, "seeds": seeds}


# ---- cut-out character (page devices: pop out of the frame, float with no frame) -----


class SubjectReq(BaseModel):
    point: list[float] | None = None  # click on the character (fractions); none = every foreground figure
    clear: bool = False


@app.post("/api/stories/{slug}/panels/{pid}/subject")
def panel_subject(slug: str, pid: str, req: SubjectReq):
    """Make (or clear) the cut-out mask of the panel's picked version: an alpha PNG in out/<pid>/masks/.
    Pages use it for `subject: pop | cutout`. Apple Vision finds the figure; without Vision a click is needed."""
    import numpy as np
    from PIL import Image, ImageFilter

    from studio import segment as seg

    s = _edit_panel_story(slug, pid)
    name, path = _version_path(s, pid, None)
    out = s.dir / "out" / pid / "masks" / f"subject-{Path(name).stem}.png"
    if req.clear:
        out.unlink(missing_ok=True)
        bump()
        return {"subject": None, "method": None, "area": 0.0}
    img = Image.open(path).convert("RGB")
    key = f"{path}:{path.stat().st_mtime_ns}"
    method = "vision"
    if req.point is not None:
        if len(req.point) != 2:
            raise HTTPException(400, "point is [x, y] fractions")
        try:
            r = seg.segment(img, (req.point[0], req.point[1]), "auto", key=key)
        except RuntimeError as e:
            raise HTTPException(400, str(e))
        m = np.asarray(r["mask"]) > 127
        method = r["method"]
    else:
        if not seg.vision_available():
            raise HTTPException(400, "Click the character to cut it out (automatic finding needs Apple Vision, macOS 14+)")
        try:
            m = seg.vision_labels(img, key) > 0
        except Exception as e:
            raise HTTPException(400, f"Couldn't find a figure: {e}")
    if not m.any():
        raise HTTPException(400, "No character found there. Click on the character.")
    a = Image.fromarray(np.where(m, 255, 0).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))  # soft edge
    rgba = Image.new("RGBA", img.size, (255, 255, 255, 0))
    rgba.putalpha(a)
    out.parent.mkdir(parents=True, exist_ok=True)
    rgba.save(out)
    bump()
    return {"subject": _subject_url(s, pid), "method": method, "area": round(float(m.mean()), 4)}


# ---- image editing (segment, rearrange, erase, fix, extend) -------------------------


class SegmentReq(BaseModel):
    file: str | None = None
    point: list[float]
    method: str = "auto"  # auto | vision | color
    tolerance: float = 0.12
    ops: list[dict] = []  # segment the image as these edits leave it


class EditReq(BaseModel):
    file: str | None = None
    ops: list[dict]
    preview: bool = False


def _edit_panel_story(slug: str, pid: str) -> st.Story:
    s = _story(slug)
    if not any(p["id"] == pid for p in s.panels):
        raise HTTPException(404, f"no panel {pid!r}")
    return s


def _mask_loader(s: st.Story, pid: str):
    from PIL import Image

    base = (s.dir / "out" / pid).resolve()

    def load(rel: str):
        p = (base / rel).resolve()
        if not p.is_relative_to(base) or not p.is_file():
            raise imageedit.EditError(f"no mask file {rel!r}")
        return Image.open(p)

    return load


def _render(s: st.Story, pid: str, file: str | None, ops: list[dict]):
    from PIL import Image

    name, path = _version_path(s, pid, file)
    key = f"{path}:{path.stat().st_mtime_ns}"
    try:
        ctx = imageedit.apply_ops(Image.open(path), ops, _mask_loader(s, pid), cache_key=key)
    except imageedit.EditError as e:
        raise HTTPException(400, str(e))
    return name, path, ctx


@app.post("/api/stories/{slug}/panels/{pid}/segment")
def segment_panel(slug: str, pid: str, req: SegmentReq):
    """Mask of the thing under `point` (fractions of the image). Apple Vision when available, else colour flood."""
    import numpy as np

    from studio import segment as seg

    s = _edit_panel_story(slug, pid)
    if len(req.point) != 2 or req.method not in ("auto", "vision", "color"):
        raise HTTPException(400, "point is [x, y] fractions; method auto | vision | color")
    pixel = [o for o in req.ops if isinstance(o, dict) and o.get("op") not in imageedit.MODEL_OPS]
    name, path, ctx = _render(s, pid, req.file, pixel)
    key = f"{path}:{path.stat().st_mtime_ns}:{json.dumps(pixel, sort_keys=True)}"
    try:
        r = seg.segment(ctx.img, (req.point[0], req.point[1]), req.method, req.tolerance, key=key)
    except RuntimeError as e:
        raise HTTPException(400, str(e))
    m = np.asarray(r["mask"]) > 127
    return {
        "file": name,
        "mask": imageedit.encode_png(r["mask"]),
        "method": r["method"],
        "instance": r["instance"],
        "instances": r["instances"],
        "area": round(float(m.mean()), 4),
        "size": list(ctx.size),
        "vision": seg.vision_available(),
    }


def _save_mask(data: str, out_dir: Path, stem: str) -> str:
    (out_dir / "masks").mkdir(exist_ok=True)
    imageedit.decode_png(data).save(out_dir / "masks" / f"{stem}.png")
    return f"masks/{stem}.png"


def _record_ops(ops: list[dict], out_dir: Path, stem: str) -> list[dict]:
    """Ops as stored in the version .json: inline PNG masks become files under out/<pid>/masks/, so the .json
    stays small and the list replays exactly (`{"png": "masks/..."}` is a valid mask spec)."""
    rec = []
    for i, op in enumerate(ops):
        op = dict(op)
        if isinstance(op.get("png"), str) and op["png"].startswith("data:"):
            op["png"] = _save_mask(op["png"], out_dir, f"{stem}-{i}")
        m = op.get("mask")
        if isinstance(m, str) and m.startswith("data:"):
            op["mask"] = {"png": _save_mask(m, out_dir, f"{stem}-{i}")}
        elif isinstance(m, dict) and isinstance(m.get("png"), str) and m["png"].startswith("data:"):
            op["mask"] = dict(m, png=_save_mask(m["png"], out_dir, f"{stem}-{i}"))
        rec.append(op)
    return rec


def _mask_meta(m) -> dict | None:
    import numpy as np

    ys, xs = np.nonzero(m)
    if not len(xs):
        return None
    h, w = m.shape
    return {"bbox": [round(xs.min() / w, 4), round(ys.min() / h, 4), round((xs.max() + 1 - xs.min()) / w, 4), round((ys.max() + 1 - ys.min()) / h, 4)], "area": round(float(m.mean()), 4)}


@app.post("/api/stories/{slug}/panels/{pid}/edit")
def edit_panel(slug: str, pid: str, req: EditReq):
    """Apply edit ops to a version. Pixel ops (mask, move, erase, crop, rotate, flip, adjust, extend) run here and
    save a NEW version (the source is never touched) whose .json records `edited_from` and the ops. A final
    `fix` / `redraw` op, an `extend`, or an erase with fill "model" then queues model jobs from that result.
    preview: true returns the rendered image without saving or queueing anything."""
    import numpy as np
    from PIL import Image, ImageFilter

    s = _edit_panel_story(slug, pid)
    ops = list(req.ops)
    model_op = None
    if ops and isinstance(ops[-1], dict) and ops[-1].get("op") in imageedit.MODEL_OPS:
        model_op = ops.pop()
    if any(isinstance(o, dict) and o.get("op") in imageedit.MODEL_OPS for o in ops):
        raise HTTPException(400, "fix / redraw must be the last op")
    name, path, ctx = _render(s, pid, req.file, ops)
    if req.preview:
        buf = io.BytesIO()
        ctx.img.save(buf, "PNG", compress_level=1)
        return {"file": name, "image": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(), "size": list(ctx.size), "holes": bool(ctx.holes.any())}

    if model_op is not None:  # validate before anything is written
        prompt = (model_op.get("prompt") or "").strip()
        if model_op["op"] == "fix" and not prompt:
            raise HTTPException(400, "fix needs a prompt (what to change)")
        redraw = model_op["op"] == "redraw"
        strength = float(model_op.get("strength", 0.85 if redraw else 0.6))
        if not 0.05 <= strength <= 1:
            raise HTTPException(400, "strength is between 0.05 and 1")
        try:
            fix_mask = None if redraw else ctx.mask(model_op.get("mask"), required=False)
        except imageedit.EditError as e:
            raise HTTPException(400, str(e))
        if fix_mask is not None and not fix_mask.any():
            raise HTTPException(400, "the fix mask is empty; select something or leave mask out to rework the whole image")

    if model_op is not None or ctx.holes.any():
        try:  # a broken plan (missing ref) must fail before a half-done edit is saved
            s.plan(pid, seed=0)
        except st.StoryError as e:
            raise HTTPException(400, str(e))

    src_meta = next((v for v in st.versions(s, pid) if v["file"] == name), {})
    seed = int(src_meta.get("seed") or 0)
    out_dir = s.dir / "out" / pid
    new_file = None
    if ctx.changed:
        out = st.next_version_name(s, pid, seed)
        ctx.img.save(out)
        meta = {
            **{k: src_meta[k] for k in ("prompt", "refs", "model", "quantize", "steps") if k in src_meta},
            "seed": seed,
            "width": ctx.size[0],
            "height": ctx.size[1],
            "edited_from": name,
            "ops": _record_ops(ops, out_dir, out.stem),
            "engine": "edit",
            "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        out.with_suffix(".json").write_text(json.dumps(meta, indent=2))
        new_file = out.name
    source = new_file or name

    jobs_out: list[int] = []
    seeds_out: list[int] = []
    holes = ctx.holes
    try:
        if model_op is not None:
            if fix_mask is not None or holes.any():
                region = (fix_mask if fix_mask is not None else np.zeros_like(holes)) | holes
                grow = max(3, round(ctx.size[0] * float(model_op.get("grow", 0.015))))
                mask = Image.fromarray(np.where(region, 255, 0).astype(np.uint8)).filter(ImageFilter.MaxFilter(grow * 2 + 1))
                if fix_mask is None:  # only new canvas / erased holes to paint: needs a strong pass
                    strength = max(strength, 0.85)
                mode, meta = "inpaint", {"mask": _mask_meta(region)}
            else:
                mask, mode, meta = None, "img2img", {}
            meta |= {"edited_from": name, "op": model_op["op"], "fix": prompt or None, "strength": strength}
            jobs_out, seeds_out = queue_from_source(slug, pid, source, mode, prompt or None, strength, int(model_op.get("count", 2)), mask=mask, meta=meta, fit_source=True)
        elif holes.any():  # extend / erase with fill "model": repaint the holes
            src_op = next((o for o in reversed(ops) if o.get("op") in ("extend", "erase", "move")), {})
            prompt = src_op.get("prompt") or "continue the scene naturally into this area, same style and lighting, nothing new"
            mask = Image.fromarray(np.where(holes, 255, 0).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))
            meta = {"edited_from": name, "op": src_op.get("op", "fill"), "fix": prompt, "strength": 0.9, "mask": _mask_meta(holes)}
            jobs_out, seeds_out = queue_from_source(slug, pid, source, "inpaint", prompt, 0.9, int(src_op.get("count", 2)), mask=mask, meta=meta, fit_source=True)
    except st.StoryError as e:
        raise HTTPException(400, str(e))
    bump()
    return {"file": new_file, "source": source, "edited_from": name, "jobs": jobs_out, "seeds": seeds_out, "size": list(ctx.size)}


# ---- lettering + export ----------------------------------------------------------


class LetterReq(BaseModel):
    panels: list[str] | None = None
    overwrite: bool = False


@app.post("/api/stories/{slug}/letter")
def letter(slug: str, req: LetterReq):
    s = _story(slug)
    pids = req.panels or [p["id"] for p in s.panels if p.get("bubbles")]
    placed = {}
    for pid in pids:
        try:
            placed[pid] = lettering.auto_letter(st.load(slug), pid, overwrite=req.overwrite)
        except st.StoryError as e:
            raise HTTPException(400, str(e))
    bump()
    return {"placed": placed}


class ExportReq(BaseModel):
    formats: list[str] = ["png", "pdf"]
    preset: str = "digital"
    bleed_mm: float | None = None
    margin_mm: float | None = None


@app.post("/api/stories/{slug}/export")
def do_export(slug: str, req: ExportReq):
    s = _story(slug)
    try:
        files = exporter.export(s, req.formats, req.preset, req.bleed_mm, req.margin_mm)
    except (ValueError, st.StoryError) as e:
        raise HTTPException(400, str(e))
    bump()
    return {"files": files}


# ---- v0.2: app services ---------------------------------------------------------


@app.get("/api/system")
def system():
    return appsvc.system_info(engine.name)


@app.get("/api/settings")
def get_settings():
    return appsvc.load_settings()


@app.put("/api/settings")
def put_settings(body: dict):
    out = appsvc.save_settings(body)
    bump()
    return out


@app.get("/api/models")
def get_models():
    return appsvc.models()


@app.post("/api/models/{mid}/download")
def download_model(mid: str):
    try:
        return appsvc.start_download(mid)
    except KeyError:
        raise HTTPException(404, f"unknown model {mid!r} (have: {', '.join(appsvc.MODELS)})")


@app.get("/api/integrations")
def get_integrations():
    return appsvc.integrations()


@app.post("/api/integrations/{agent}/connect")
def connect_agent(agent: str):
    try:
        return appsvc.connect(agent)
    except KeyError:
        raise HTTPException(404, "agent must be claude or codex")


# ---- v0.2 routers --------------------------------------------------------

from studio.pipeline.routes import router as pipeline_router  # noqa: E402

app.include_router(pipeline_router)
