"""Dashboard + generation server. One worker thread owns the model; jobs run one at a time.

Run:  uv run studio serve        (STUDIO_ENGINE=mock for placeholder images)
"""

from __future__ import annotations

import asyncio
import base64
import io
import itertools
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

from studio import appsvc, compose, export as exporter, lettering, project as pj, story as st
from studio.engine import make_engine

DASHBOARD = Path(__file__).resolve().parent.parent / "dashboard" / "index.html"
APP_DIST = Path(__file__).resolve().parent.parent / "app" / "dist"

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


def _story(slug: str) -> st.Story:
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
    return {"rev": _rev, **engine.status(), "queued": sum(j["status"] == "queued" for j in jobs.values())}


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
                    "panels": len(s.panels),
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
    for j in sorted(jobs.values(), key=lambda j: j["id"], reverse=True):
        if story and j["story"] != story:
            continue
        if active and j["status"] not in ("queued", "running"):
            continue
        out.append({k: v for k, v in j.items() if k not in ("plan", "trace", "post")} | {"seed": j["plan"]["seed"]})
    return out[:200]


@app.get("/api/jobs/{jid}")
def job(jid: int):
    if jid not in jobs:
        raise HTTPException(404, "no such job")
    return {k: v for k, v in jobs[jid].items() if k != "post"}


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


# ---- v0.2: projects + editing ----------------------------------------------

PANEL_KEYS = {
    "title", "action", "refs", "use", "cast", "bubbles", "sfx", "layers", "crop", "protect",
    "seed", "strength", "strip", "width", "height", "ref_label", "avoid", "steps", "output_resolution",
    "camera", "source_span", "beat", "location",  # written by the pipeline; editable from the UI
}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def _edit(slug: str):
    if not (st.STORIES / slug / "story.yaml").exists():
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
        src = st.STORIES / "cheek-squish"
        if not (src / "story.yaml").exists():
            shutil.rmtree(d)
            raise st.StoryError("the sample story (stories/cheek-squish) is missing")
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
        for sl in pg.get("panels") or []:
            if sl.get("panel") not in ids:
                raise HTTPException(400, f"page {pg['id']}: unknown panel {sl.get('panel')!r}")
            box = sl.get("box")
            if not (isinstance(box, list) and len(box) == 4):
                raise HTTPException(400, f"page {pg['id']}: panel {sl['panel']} needs box [x, y, w, h]")
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
    seeds = None
    if req.mode == "txt2img" and count == 1:
        seed = panel.get("seed") or next((s.cast[c].get("seed") for c in panel.get("cast") or [] if s.cast.get(c, {}).get("seed")), None)
        seeds = [int(seed)] if seed else None
    meta = {"copilot": req.mode}
    post = None
    if req.mode == "txt2img":
        def mutate(plan):
            plan["prompt"] = _with_instruction(plan["prompt"], req.prompt)
            return plan
    else:
        src = req.source or st.picked_version(s, pid)
        if not src or not (s.dir / "out" / pid / src).exists():
            raise HTTPException(400, f"{pid} has no version to start from; generate one first")
        src_path = s.dir / "out" / pid / src
        meta["source"] = src
        strength = req.strength if req.strength is not None else (0.6 if req.mode == "img2img" else 0.85)

        def mutate(plan):
            first = {"name": f"{pid}/{src}", "path": str(src_path), "version": src, "label": "the current panel, keep its composition and characters"}
            refs = [first] + [r for r in plan["refs"] if r["path"] != str(src_path)]
            plan["refs"] = refs[:10]
            plan["prompt"] = _with_instruction(s.build_prompt(panel, plan["refs"]), req.prompt)
            plan["strength"] = strength
            return plan

        if req.mode == "inpaint":
            if not req.mask:
                raise HTTPException(400, "inpaint needs a mask")
            post = _inpaint_post(src_path, _decode_mask(req.mask))
    try:
        created, seeds = enqueue(slug, pid, seeds=seeds, count=count, plan_mutator=mutate, meta=meta, post=post)
    except st.StoryError as e:
        raise HTTPException(400, str(e))
    return {"jobs": created, "seeds": seeds}


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
