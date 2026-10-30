"""Pipeline state machine + runner.

    analysis -> script -> layout -> artwork -> lettering -> qa

State lives in stories/<slug>/pipeline/: state.json (stage statuses, provider, pending agent task),
analysis.json, script.json, qa.json. One runner thread per story. A stage either finishes, fails,
or (agent provider) parks as `awaiting_agent` until an MCP client submits its result; submitting
re-enters the run at that stage with the result and carries on to the run's original end stage.
"""

from __future__ import annotations

import json
import math
import random
import re
import sys
import threading
import time
from pathlib import Path

from studio import llm, project as pj, story as st
from studio.pipeline import coverage

STAGES = [
    ("analysis", "Source analysis"),
    ("script", "Script"),
    ("layout", "Storyboard layout"),
    ("artwork", "Artwork"),
    ("lettering", "Lettering"),
    ("qa", "QA gate"),
]
ORDER = [s for s, _ in STAGES]
NAMES = dict(STAGES)
MAX_ATTEMPTS = 3

_lock = threading.RLock()
_runs: dict[str, dict] = {}


def plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


class PipelineError(RuntimeError):
    pass


class Conflict(PipelineError):
    pass


# ---- state files ------------------------------------------------------------


def pdir(slug: str) -> Path:
    return st.STORIES / slug / "pipeline"


def _read(slug: str, name: str, default=None):
    p = pdir(slug) / name
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text())
    except ValueError:
        return default


def _write(slug: str, name: str, data) -> None:
    d = pdir(slug)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / (name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(d / name)


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _blank_state(provider: str = "heuristic") -> dict:
    return {
        "provider": provider,
        "running": False,
        "run": None,
        "stages": {s: {"status": "idle"} for s in ORDER},
        "task": None,
        "submitted": None,
    }


def bump() -> None:
    srv = sys.modules.get("studio.server")
    if srv is not None:
        try:
            srv.bump()
        except Exception:
            pass


def load_state(slug: str) -> dict:
    """In memory `stages` is {id: entry}; on disk it's a list of {id, status, ...} in stage order."""
    s = _read(slug, "state.json")
    if not s:
        return _blank_state(_default_provider())
    base = _blank_state(s.get("provider", "heuristic"))
    base.update(s)
    if isinstance(base["stages"], list):
        base["stages"] = {e["id"]: {k: v for k, v in e.items() if k not in ("id", "name")} for e in base["stages"] if e.get("id") in NAMES}
    for sid in ORDER:
        base["stages"].setdefault(sid, {"status": "idle"})
    return base


def _save_state(slug: str, s: dict) -> None:
    disk = dict(s)
    disk["stages"] = [{"id": sid, "name": NAMES[sid], **s["stages"][sid]} for sid in ORDER]
    _write(slug, "state.json", disk)


def update(slug: str, fn) -> dict:
    with _lock:
        s = load_state(slug)
        fn(s)
        _save_state(slug, s)
    bump()
    return s


def set_stage(slug: str, sid: str, **kw) -> None:
    def f(s):
        e = s["stages"][sid]
        for k, v in kw.items():
            if v is None:
                e.pop(k, None)
            else:
                e[k] = v
        e["updated"] = _now()

    update(slug, f)


def _default_provider() -> str:
    try:
        from studio import appsvc

        return appsvc.load_settings().get("llm", {}).get("provider", "heuristic")
    except Exception:
        return "heuristic"


def _settings() -> dict:
    try:
        from studio import appsvc

        return appsvc.load_settings()
    except Exception:
        return {}


def exists(slug: str) -> bool:
    return (pdir(slug) / "state.json").exists() or (st.STORIES / slug / "source.md").exists()


def summary(slug: str) -> dict | None:
    """Compact status for the story detail endpoint; None when the story has no pipeline."""
    if not exists(slug):
        return None
    s = load_state(slug)
    return {"stages": [{"id": sid, "status": s["stages"][sid]["status"]} for sid in ORDER], "running": is_running(slug)}


def is_running(slug: str) -> bool:
    r = _runs.get(slug)
    return bool(r and r["thread"].is_alive())


def stage_output(slug: str, sid: str):
    if sid == "analysis":
        return _read(slug, "analysis.json")
    if sid == "script":
        return _read(slug, "script.json")
    if sid == "qa":
        return _read(slug, "qa.json")
    try:
        story = st.load(slug)
    except st.StoryError:
        return None
    if sid == "layout":
        return {"mode": (story.data.get("format") or {}).get("mode", "page"), "pages": story.data.get("pages") or []}
    if sid == "artwork":
        return {"panels": {p["id"]: st.picked_version(story, p["id"]) for p in story.panels}}
    if sid == "lettering":
        return {"panels": {p["id"]: len(p.get("bubbles") or []) for p in story.panels if p.get("strip", True) is not False}}
    return None


def public_state(slug: str, outputs: bool = True) -> dict:
    s = load_state(slug)
    stages = []
    for sid in ORDER:
        e = dict(s["stages"][sid])
        item = {"id": sid, "name": NAMES[sid], "status": e.get("status", "idle")}
        for k in ("detail", "progress", "updated"):
            if k in e:
                item[k] = e[k]
        if outputs and item["status"] in ("done", "flagged", "awaiting_agent", "error", "running"):
            item["output"] = stage_output(slug, sid)
        stages.append(item)
    task = s.get("task")
    return {
        "provider": s.get("provider", "heuristic"),
        "running": is_running(slug),
        "stages": stages,
        "task": {"stage": task["stage"], "instructions": task["instructions"]} if task else None,
        "qa": _read(slug, "qa.json"),
    }


def get_task(slug: str) -> dict | None:
    return load_state(slug).get("task")


# ---- runner -------------------------------------------------------------------


class Ctx:
    def __init__(self, slug: str, provider_name: str, cancel: threading.Event):
        self.slug = slug
        self.provider_name = provider_name
        self.provider = llm.make_provider(provider_name, _settings())
        self.cancel = cancel

    def take_submitted(self, sid: str):
        """Result an agent submitted for this stage (consumed once)."""
        out = {}

        def f(s):
            sub = s.get("submitted")
            if sub and sub.get("stage") == sid:
                out["r"] = sub["result"]
                s["submitted"] = None

        update(self.slug, f)
        return out.get("r")

    def progress(self, sid: str, done: int, total: int, detail: str | None = None):
        set_stage(self.slug, sid, progress={"done": done, "total": total}, **({"detail": detail} if detail else {}))

    def check_cancel(self):
        if self.cancel.is_set():
            raise _Cancelled()


class _Cancelled(Exception):
    pass


def run(slug: str, frm: str | None = None, to: str | None = None, provider: str | None = None) -> dict:
    st.load(slug)  # 404s early for unknown stories
    if frm and frm not in ORDER:
        raise PipelineError(f"unknown stage {frm!r} (stages: {', '.join(ORDER)})")
    if to and to not in ORDER:
        raise PipelineError(f"unknown stage {to!r} (stages: {', '.join(ORDER)})")
    if provider and provider not in ("agent", "ollama", "heuristic"):
        raise PipelineError(f"unknown provider {provider!r} (agent | ollama | heuristic)")
    with _lock:
        if is_running(slug):
            return public_state(slug)
        s = load_state(slug)
        if frm is None:
            frm = next((sid for sid in ORDER if s["stages"][sid]["status"] not in ("done",)), None)
            if frm is None:
                return public_state(slug)  # everything is done; pass `from` to redo a stage
        to = to or "qa"
        if ORDER.index(to) < ORDER.index(frm):
            raise PipelineError(f"`to` ({to}) comes before `from` ({frm})")
        prov = provider or s.get("provider") or _default_provider()
        cancel = threading.Event()

        def f(s):
            s["provider"] = prov
            s["run"] = {"from": frm, "to": to, "started": _now()}
            s["task"] = None
            for sid in ORDER[ORDER.index(frm) : ORDER.index(to) + 1]:
                s["stages"][sid] = {"status": "idle", "updated": _now()}

        update(slug, f)
        t = threading.Thread(target=_loop, args=(slug, frm, to, prov, cancel), daemon=True, name=f"pipeline-{slug}")
        _runs[slug] = {"thread": t, "cancel": cancel}
        t.start()
    time.sleep(0.05)
    return public_state(slug)


def cancel(slug: str) -> None:
    r = _runs.get(slug)
    if r:
        r["cancel"].set()
    # also drop queued generation jobs for this story so the worker frees up
    srv = sys.modules.get("studio.server")
    if srv is not None:
        for j in list(srv.jobs.values()):
            if j["story"] == slug and j["status"] == "queued" and j.get("meta", {}).get("pipeline"):
                j["status"] = "cancelled"

    def f(s):
        if s.get("task"):
            sid = s["task"]["stage"]
            s["stages"][sid]["status"] = "idle"
            s["stages"][sid]["detail"] = "cancelled"
            s["task"] = None

    update(slug, f)


def _loop(slug: str, frm: str, to: str, prov: str, cancel_ev: threading.Event) -> None:
    ctx = Ctx(slug, prov, cancel_ev)
    for sid in ORDER[ORDER.index(frm) : ORDER.index(to) + 1]:
        if cancel_ev.is_set():
            set_stage(slug, sid, status="idle", detail="cancelled")
            break
        set_stage(slug, sid, status="running", detail=None, progress=None)
        try:
            res = RUNNERS[sid](ctx) or {}
        except llm.AwaitAgent as a:
            task = a.task

            def f(s, task=task):
                s["task"] = task
                s["stages"][sid].update(status="awaiting_agent", detail="Waiting for your AI agent (MCP: pipeline_task / pipeline_submit)", updated=_now())

            update(slug, f)
            return
        except _Cancelled:
            set_stage(slug, sid, status="idle", detail="cancelled")
            return
        except Exception as e:  # surface in the UI, keep the server alive
            set_stage(slug, sid, status="error", detail=f"{type(e).__name__}: {e}")
            return
        set_stage(slug, sid, status=res.get("status", "done"), detail=res.get("detail"))
        if res.get("status") == "error":
            return
    coverage.compute(slug)
    bump()


def submit(slug: str, stage: str, result) -> dict:
    s = load_state(slug)
    task = s.get("task")
    if not task:
        raise Conflict("no stage is waiting for an agent right now")
    if task["stage"] != stage:
        raise Conflict(f"the pipeline is waiting for {task['stage']!r}, not {stage!r}")
    llm.validate(result, llm.SCHEMAS[stage])  # raises SchemaError -> 400
    to = (s.get("run") or {}).get("to") or "qa"
    if ORDER.index(to) < ORDER.index(stage):
        to = stage

    def f(s):
        s["submitted"] = {"stage": stage, "result": result}
        s["task"] = None

    update(slug, f)
    return run(slug, frm=stage, to=to, provider="agent")


def override(slug: str, stage: str, output) -> dict:
    """Manual override: replace a stage's output, re-apply its effect, mark later stages idle."""
    if stage not in ORDER:
        raise PipelineError(f"unknown stage {stage!r}")
    if is_running(slug):
        raise Conflict("the pipeline is running; cancel it first")
    status = "done"
    if stage == "analysis":
        llm.validate(output, llm.ANALYSIS_SCHEMA)
        _write(slug, "analysis.json", output)
        apply_analysis(slug, output)
    elif stage == "script":
        llm.validate(output, llm.SCRIPT_SCHEMA)
        output = normalize_script(output)
        _write(slug, "script.json", output)
        apply_script(slug, output)
    elif stage == "layout":
        if not isinstance(output, dict) or not isinstance(output.get("pages"), list):
            raise llm.SchemaError("layout output must be {pages: [...]}")
        with pj.edit(slug) as d:
            d["pages"] = pj.from_plain(output["pages"])
    elif stage == "artwork":
        picks = (output or {}).get("picks") if isinstance(output, dict) else None
        if not isinstance(picks, dict):
            raise llm.SchemaError("artwork output must be {picks: {panel: file}}")
        story = st.load(slug)
        for pid, f in picks.items():
            if f not in [v["file"] for v in st.versions(story, pid)]:
                raise llm.SchemaError(f"{f!r} is not a version of {pid}")
        st.update_state(story, lambda s: s["picks"].update(picks))
    elif stage == "qa":
        llm.validate(output, llm.QA_SCHEMA)
        qa = _read(slug, "qa.json", {"panels": {}})
        for pid, v in output["panels"].items():
            e = qa["panels"].setdefault(pid, {"attempts": 0})
            e.update(ok=v["ok"], issues=v["issues"], flagged=not v["ok"])
        _write(slug, "qa.json", qa)
        status = "flagged" if any(e.get("flagged") for e in qa["panels"].values()) else "done"
    else:
        raise llm.SchemaError("lettering has no output to override; move bubbles in the Studio instead")

    def f(s):
        s["stages"][stage] = {"status": status, "detail": "edited by hand", "updated": _now()}
        for later in ORDER[ORDER.index(stage) + 1 :]:
            s["stages"][later] = {"status": "idle", "updated": _now()}
        s["task"] = None

    update(slug, f)
    coverage.compute(slug)
    return public_state(slug)


# ---- stage: analysis ------------------------------------------------------------

STYLE = {
    "page": (
        "Black-and-white Japanese manga panel. Clean confident ink lineart, screentone shading, high contrast, "
        "expressive faces, dynamic composition, consistent character designs. No text, no speech bubbles, no letters."
    ),
    "webtoon": (
        "Full-color vertical webtoon panel. Clean thin lineart, soft cel-shading, gentle gradients, soft lighting, "
        "expressive faces, consistent character designs. No text, no speech bubbles, no letters."
    ),
}


def _ctx_info(slug: str) -> dict:
    story = st.load(slug)
    return {"title": story.data.get("title", slug), "format": pj.to_plain(story.data.get("format") or {"mode": "page", "direction": "rtl"})}


def stage_analysis(ctx: Ctx) -> dict:
    source = coverage.source_text(ctx.slug)
    if not source.strip():
        raise PipelineError("no source text yet: add it in the Pipeline view (or PUT /source)")
    result = ctx.take_submitted("analysis")
    if result is None:
        result = ctx.provider.analysis(source, _ctx_info(ctx.slug))
    llm.validate(result, llm.ANALYSIS_SCHEMA)
    result = llm.repair_spans(result, source, "beats")
    _write(ctx.slug, "analysis.json", result)
    apply_analysis(ctx.slug, result)
    return {"detail": f"{plural(len(result['cast']), 'character')}, {plural(len(result['locations']), 'location')}, {plural(len(result['beats']), 'beat')}"}


def _cid(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-") or "x"


def apply_analysis(slug: str, a: dict) -> None:
    with pj.edit(slug) as d:
        mode = (d.get("format") or {}).get("mode", "page")
        cast = d.get("cast")
        if cast is None:
            d["cast"] = cast = pj.from_plain({})
        pj.block(cast)
        ids = []
        for c in a["cast"]:
            cid = _cid(c["id"])
            ids.append(cid)
            entry = dict(cast.get(cid) or {})
            entry.update({k: c[k] for k in ("name", "role", "face", "hair", "outfit", "palette")})
            entry.setdefault("sheet", "sheet")
            cast[cid] = pj.from_plain(entry)
        blocks = d.get("blocks")
        if blocks is None:
            d["blocks"] = blocks = pj.from_plain({})
        pj.block(blocks)
        if "style" not in blocks:
            blocks["style"] = pj.from_plain(STYLE.get(mode, STYLE["page"]))
        for loc in a["locations"]:
            blocks[f"setting-{_cid(loc['id'])}"] = pj.from_plain(loc["description"])
        if d.get("avoid") is None:
            d["avoid"] = "any text, letters, speech bubbles, watermark, signature"

        panels = d.get("panels")
        if panels is None:
            d["panels"] = panels = pj.from_plain([])
        pj.block(panels)
        by_id = {p.get("id"): p for p in panels}
        names = ", ".join(c["name"] for c in a["cast"]) or "the characters"
        refs_wanted = [
            {
                "id": "sheet",
                "title": "Character sheet",
                "strip": False,
                "width": 1248,
                "height": 832,
                "ref_label": "character reference sheet",
                "refs": [],
                # cast ids in `use` compile their blocks; `cast:` would also inject the sheet as its own ref
                "use": ["style", *ids],
                "action": f"Character turnaround sheet on a plain white background: {names} standing side by side, full body, front view, relaxed neutral expressions, evenly lit, nothing else in frame.",
            }
        ]
        for loc in a["locations"]:
            lid = _cid(loc["id"])
            refs_wanted.append(
                {
                    "id": f"plate-{lid}",
                    "title": f"{loc['name']} plate",
                    "strip": False,
                    "ref_label": f"the {loc['name']} set, empty",
                    "refs": [],
                    "use": ["style", f"setting-{lid}"],
                    "action": f"The {loc['name']} with nobody in it: an establishing view of the empty set, same lighting throughout.",
                }
            )
        insert_at = 0
        for want in refs_wanted:
            if want["id"] in by_id:
                p = by_id[want["id"]]
                for k in ("use", "ref_label", "title"):
                    p[k] = pj.from_plain(want[k])
                if not p.get("action"):
                    p["action"] = pj.from_plain(want["action"])
            else:
                panels.insert(insert_at, pj.from_plain(want))
            insert_at += 1


# ---- stage: script ----------------------------------------------------------------


def normalize_script(script: dict) -> dict:
    """Renumber panels p01.. in reading order and record the original ids."""
    n = 0
    for page in script["pages"]:
        for p in page["panels"]:
            n += 1
            if p["id"] != f"p{n:02d}":
                p.setdefault("orig_id", p["id"])
                p["id"] = f"p{n:02d}"
    return script


def stage_script(ctx: Ctx) -> dict:
    source = coverage.source_text(ctx.slug)
    analysis = _read(ctx.slug, "analysis.json")
    if not analysis:
        raise PipelineError("run source analysis first")
    result = ctx.take_submitted("script")
    if result is None:
        result = ctx.provider.script(source, analysis, _ctx_info(ctx.slug))
    llm.validate(result, llm.SCRIPT_SCHEMA)
    n = len(source)
    for page in result["pages"]:
        for p in page["panels"]:
            s, e = p["span"]
            p["span"] = [max(0, min(n, int(s))), max(0, min(n, int(e)))]
    result = normalize_script(result)
    _write(ctx.slug, "script.json", result)
    apply_script(ctx.slug, result)
    cov = coverage.compute(ctx.slug)
    count = sum(len(p["panels"]) for p in result["pages"])
    return {"detail": f"{plural(count, 'panel')} on {plural(len(result['pages']), 'page')}, {round(cov['covered_ratio'] * 100)}% of the source covered"}


_STYLE_OF = {"speech": "speech", "shout": "shout", "thought": "thought", "caption": "caption"}


def _title(action: str) -> str:
    words = re.sub(r"^(?:wide|medium|close-up|extreme close-up)[^.]*\.\s*", "", action, flags=re.I).split()
    return " ".join(words[:5]).rstrip(",.;:") or "Panel"


def apply_script(slug: str, script: dict) -> None:
    with pj.edit(slug) as d:
        blocks = d.get("blocks") or {}
        cast_ids = set((d.get("cast") or {}).keys())
        panels = d.get("panels")
        if panels is None:
            d["panels"] = panels = pj.from_plain([])
        pj.block(panels)
        refs = [p for p in panels if p.get("strip", True) is False]
        ref_ids = {p.get("id") for p in refs}
        old = {p.get("id"): p for p in panels if p.get("strip", True) is not False}
        manual = [p for p in panels if p.get("strip", True) is not False and "source_span" not in p]
        new_panels = []
        for page in script["pages"]:
            for sp in page["panels"]:
                lid = _cid(sp.get("location", ""))
                setting = f"setting-{lid}" if f"setting-{lid}" in blocks else next((k for k in blocks if str(k).startswith("setting")), None)
                plate = f"plate-{lid}" if f"plate-{lid}" in ref_ids else next((r for r in ref_ids if str(r).startswith("plate-")), None)
                bubbles = [
                    {"id": f"b{i}", "text": dl["text"], "style": _STYLE_OF.get(dl.get("kind"), "speech"), "speaker": dl.get("speaker")}
                    for i, dl in enumerate(sp.get("dialogue") or [], 1)
                    if dl.get("text", "").strip()
                ]
                want = {
                    "title": _title(sp["action"]),
                    "refs": [r for r in ("sheet", plate) if r and r in ref_ids],
                    "use": ["style"] + ([setting] if setting else []),
                    "cast": [c for c in (_cid(x) for x in sp.get("cast") or []) if c in cast_ids],
                    "action": sp["action"],
                    "camera": sp.get("camera"),
                    "source_span": list(sp["span"]),
                }
                if sp["id"] in old and "source_span" in old[sp["id"]]:
                    p = old[sp["id"]]
                    pj.set_keys(p, want)
                    if [b.get("text") for b in (p.get("bubbles") or [])] != [b["text"] for b in bubbles]:
                        p["bubbles"] = pj.from_plain(bubbles)
                else:
                    p = pj.from_plain({"id": sp["id"], **want, "bubbles": bubbles})
                new_panels.append(p)
        taken = {p["id"] for p in new_panels}
        manual = [p for p in manual if p.get("id") not in taken]
        panels.clear()
        panels.extend(refs + new_panels + manual)


# ---- stage: layout -------------------------------------------------------------------

ACTION_WORDS = re.compile(r"\b(run|runs|running|punch|punches|jump|jumps|leap|leaps|slam|slams|crash|crashes|kick|kicks|fall|falls|lunge|lunges|grab|grabs|throw|throws|explode|explodes|chase|chases|strike|strikes|rush|rushes|dash|dashes|swing|swings|charge|charges)\b", re.I)

ROW_TEMPLATES = {
    1: [[1]],
    2: [[1, 1], [2]],
    3: [[1, 2], [2, 1], [1, 1, 1]],
    4: [[1, 2, 1], [2, 2], [1, 1, 2]],
    5: [[2, 1, 2], [1, 2, 2], [2, 2, 1]],
}


def _group_pages(story_panels: list[dict], script: dict | None) -> list[list[dict]]:
    by_id = {p["id"]: p for p in story_panels}
    groups: list[list[dict]] = []
    if script:
        used = set()
        for page in script["pages"]:
            g = [by_id[sp["id"]] for sp in page["panels"] if sp["id"] in by_id]
            if g:
                groups.append(g)
                used.update(p["id"] for p in g)
        leftovers = [p for p in story_panels if p["id"] not in used]
        if leftovers:
            groups.append(leftovers)
    else:
        groups = [story_panels]
    out = []
    for g in groups:  # keep every page at 1-5 panels, prefer 3-4
        while len(g) > 5:
            out.append(g[:4])
            g = g[4:]
        if g:
            out.append(g)
    return out


def _slot(points: list[tuple[float, float]]) -> dict:
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    w, h = x1 - x0, y1 - y0
    box = [round(x0, 4), round(y0, 4), round(w, 4), round(h, 4)]
    rect = len(points) == 4 and set(map(lambda p: (round(p[0], 4), round(p[1], 4)), points)) == {
        (round(x0, 4), round(y0, 4)), (round(x1, 4), round(y0, 4)), (round(x1, 4), round(y1, 4)), (round(x0, 4), round(y1, 4))
    }
    if rect:
        return {"box": box}
    return {"box": box, "poly": [[round((px - x0) / w, 4), round((py - y0) / h, 4)] for px, py in points]}


def layout_page(panels: list[dict], page_index: int, fmt: dict) -> list[dict]:
    n = len(panels)
    options = ROW_TEMPLATES[n]
    rows = options[page_index % len(options)]
    pw = float((fmt.get("page") or {}).get("width", 1654))
    ph = float((fmt.get("page") or {}).get("height", 2339))
    margin = float(fmt.get("margin", 0.06))
    gutter = float(fmt.get("gutter", 0.018))
    live_w, live_h = pw * (1 - 2 * margin), ph - 2 * margin * pw
    gx, gy = gutter * pw / live_w, gutter * pw / live_h
    rtl = fmt.get("direction", "rtl") == "rtl"

    # row heights: a lone establishing/wide panel gets more room
    it = iter(panels)
    row_panels = [[next(it) for _ in range(k)] for k in rows]
    weights = [1.35 if len(rp) == 1 and re.search(r"\bwide|establishing\b", (rp[0].get("camera") or rp[0].get("action") or ""), re.I) else 1.0 for rp in row_panels]
    avail = 1 - gy * (len(rows) - 1)
    slots = []
    y = 0.0
    for ri, rp in enumerate(row_panels):
        h = avail * weights[ri] / sum(weights)
        k = len(rp)
        if k == 1:
            cols = [(0.0, 1.0)]
        else:
            split = 0.58 if (page_index + ri) % 2 == 0 else 0.42
            fracs = [split, 1 - split] if k == 2 else [1 / k] * k
            aw = 1 - gx * (k - 1)
            cols, x = [], 0.0
            for f in fracs:
                cols.append((x, x + aw * f))
                x += aw * f + gx
        order = list(range(k))[::-1] if rtl else list(range(k))  # first panel sits at the reading start
        diagonal = k == 2 and any(ACTION_WORDS.search(p.get("action") or "") for p in rp)
        for i, p in enumerate(rp):
            x0, x1 = cols[order[i]]
            y0, y1 = y, y + h
            if diagonal:
                s = 0.05
                left_is = order[i] == 0
                if left_is:
                    pts = [(x0, y0), (x1 + s, y0), (x1 - s, y1), (x0, y1)]
                else:
                    pts = [(x0 + s, y0), (x1, y0), (x1, y1), (x0 - s, y1)]
            else:
                pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            slot = _slot(pts)
            slots.append({"panel": p["id"], **slot})
        y += h + gy
    return slots


def _art_size(box: list[float], fmt: dict) -> tuple[int, int]:
    pw = float((fmt.get("page") or {}).get("width", 1654))
    ph = float((fmt.get("page") or {}).get("height", 2339))
    margin = float(fmt.get("margin", 0.06))
    live_w, live_h = pw * (1 - 2 * margin), ph - 2 * margin * pw
    aspect = max(0.4, min(2.5, (box[2] * live_w) / max(1e-6, box[3] * live_h)))
    w = math.sqrt(1.0e6 * aspect)
    h = w / aspect

    def r32(v):
        return int(max(512, min(1536, round(v / 32) * 32)))

    return r32(w), r32(h)


def stage_layout(ctx: Ctx) -> dict:
    story = st.load(ctx.slug)
    fmt = pj.to_plain(story.data.get("format") or {"mode": "page", "direction": "rtl"})
    story_panels = [p for p in story.panels if p.get("strip", True) is not False]
    if not story_panels:
        raise PipelineError("no story panels to lay out; run the script stage first")
    if fmt.get("mode") == "webtoon":
        with pj.edit(ctx.slug) as d:
            d["pages"] = pj.from_plain([])
        return {"detail": f"webtoon scroll: {len(story_panels)} panels in reading order"}
    groups = _group_pages(story_panels, _read(ctx.slug, "script.json"))
    pages = [{"id": f"pg{i + 1}", "panels": layout_page(g, i, fmt)} for i, g in enumerate(groups)]
    sizes = {s["panel"]: _art_size(s["box"], fmt) for pg in pages for s in pg["panels"]}
    with pj.edit(ctx.slug) as d:
        d["pages"] = pj.from_plain(pages)
        for p in d.get("panels") or []:
            if p.get("id") in sizes and "source_span" in p:  # only size panels the pipeline owns
                p["width"], p["height"] = sizes[p["id"]]
    return {"detail": f"{plural(len(pages), 'page')}, {'right-to-left' if fmt.get('direction', 'rtl') == 'rtl' else 'left-to-right'}"}


# ---- stage: artwork -------------------------------------------------------------------


def _server():
    srv = sys.modules.get("studio.server")
    if srv is None:
        raise PipelineError("artwork needs the studio server (run the pipeline from `studio serve`)")
    return srv


def _wait_jobs(ctx: Ctx, ids: list[int], on_done=None, timeout: float = 3 * 3600) -> dict[int, dict]:
    srv = _server()
    pending, results, t0 = set(ids), {}, time.time()
    while pending:
        if ctx.cancel.is_set():
            for jid in pending:
                j = srv.jobs.get(jid)
                if j and j["status"] == "queued":
                    j["status"] = "cancelled"
            raise _Cancelled()
        for jid in list(pending):
            j = srv.jobs.get(jid)
            if j is None or j["status"] in ("done", "error", "cancelled"):
                pending.discard(jid)
                results[jid] = j or {"status": "error", "error": "job vanished"}
                if on_done:
                    on_done(jid, results[jid])
        if time.time() - t0 > timeout:
            raise PipelineError("timed out waiting for generations")
        if pending:
            time.sleep(0.4)
    return results


def _enqueue(slug: str, pid: str, seed: int | None = None, meta: dict | None = None) -> int:
    srv = _server()
    seeds = [seed] if seed is not None else None
    ids, _ = srv.enqueue(slug, pid, seeds=seeds, count=1, meta={"pipeline": True, **(meta or {})})
    return ids[0]


def stage_artwork(ctx: Ctx) -> dict:
    story = st.load(ctx.slug)
    refs = [p for p in story.panels if p.get("strip", True) is False]
    panels = [p for p in story.panels if p.get("strip", True) is not False]
    todo_refs = [p for p in refs if not st.versions(story, p["id"])]
    todo = [p for p in panels if not st.versions(story, p["id"])]
    total = len(todo_refs) + len(todo)
    done = [0]
    failed: list[str] = []
    if total == 0:
        return {"detail": "every panel already has artwork"}
    ctx.progress("artwork", 0, total, f"drawing {len(todo_refs)} reference sheet(s) first")

    def tick(_jid, job):
        done[0] += 1
        if job.get("status") != "done":
            failed.append(f"{job.get('panel', '?')}: {job.get('error', job.get('status'))}")
        ctx.progress("artwork", done[0], total)

    ids = [_enqueue(ctx.slug, p["id"], p.get("seed")) for p in todo_refs]
    res = _wait_jobs(ctx, ids, tick)
    # references become anchors: pick the newest version unless the user already picked one
    story = st.load(ctx.slug)
    picks = {j["panel"]: j["file"] for j in res.values() if j.get("status") == "done"}

    def f(state):
        for pid, file in picks.items():
            state["picks"].setdefault(pid, file)

    if picks:
        st.update_state(story, f)
    if todo_refs and not picks and any(not st.versions(story, p["id"]) for p in refs):
        return {"status": "error", "detail": "reference sheets failed: " + "; ".join(failed[:3])}

    ctx.progress("artwork", done[0], total, f"drawing {len(todo)} panel(s)")
    ids = []
    for p in todo:
        try:
            ids.append(_enqueue(ctx.slug, p["id"], p.get("seed")))
        except st.StoryError as e:
            failed.append(f"{p['id']}: {e}")
            done[0] += 1
    _wait_jobs(ctx, ids, tick)
    if failed and len(failed) >= total:
        return {"status": "error", "detail": "; ".join(failed[:3])}
    return {"detail": f"{total - len(failed)} of {total} drawn" + (f"; failed: {'; '.join(failed[:3])}" if failed else "")}


# ---- stage: lettering -----------------------------------------------------------------


def _lettering():
    try:
        from studio import lettering
    except ImportError as e:
        raise PipelineError("studio.lettering isn't available yet") from e
    return lettering


def stage_lettering(ctx: Ctx) -> dict:
    lt = _lettering()
    story = st.load(ctx.slug)
    panels = [p for p in story.panels if p.get("strip", True) is not False]
    placed = 0
    for i, p in enumerate(panels):
        ctx.check_cancel()
        if any("at" not in b for b in (p.get("bubbles") or [])):
            placed += lt.auto_letter(st.load(ctx.slug), p["id"], overwrite=False) or 0
        ctx.progress("lettering", i + 1, len(panels))
    return {"detail": f"placed {placed} bubble(s) across {len(panels)} panels"}


# ---- stage: qa ----------------------------------------------------------------------------


def stage_qa(ctx: Ctx) -> dict:
    lt = _lettering()
    qa = _read(ctx.slug, "qa.json") or {"panels": {}}
    submitted = ctx.take_submitted("qa")
    for _round in range(MAX_ATTEMPTS + 2):
        ctx.check_cancel()
        story = st.load(ctx.slug)
        state = st.read_state(story)
        targets = [p for p in story.panels if p.get("strip", True) is not False and st.picked_version(story, p["id"])]
        check = [p for p in targets if not qa["panels"].get(p["id"], {}).get("ok") and not qa["panels"].get(p["id"], {}).get("flagged")]
        if not check:
            break
        geo: dict[str, list[str]] = {}
        for p in check:
            e = qa["panels"].setdefault(p["id"], {"ok": False, "issues": [], "attempts": 0, "flagged": False})
            issues = lt.overlap_issues(story, p["id"]) or []
            if issues and not e.get("relettered"):
                lt.auto_letter(story, p["id"], overwrite=True)
                e["relettered"] = True
                story = st.load(ctx.slug)
                issues = lt.overlap_issues(story, p["id"]) or []
            geo[p["id"]] = list(issues)
        story = st.load(ctx.slug)
        cast = pj.to_plain(story.data.get("cast") or {})
        items = []
        for p in check:
            v = st.picked_version(story, p["id"])
            items.append(
                {
                    "panel": p["id"],
                    "image": str(story.dir / "out" / p["id"] / v),
                    "action": p.get("action", ""),
                    "cast": list(p.get("cast") or []),
                    "bubbles": [{"text": b.get("text"), "at": b.get("at"), "w": b.get("w")} for b in p.get("bubbles") or []],
                    "attempt": qa["panels"][p["id"]].get("attempts", 0) + 1,
                }
            )
        _write(ctx.slug, "qa.json", qa)
        ctx.progress("qa", len(targets) - len(check), len(targets), f"checking {len(check)} panel(s)")
        if submitted is not None:
            vision = submitted.get("panels", {})
            submitted = None
        else:
            vision = ctx.provider.qa(items, {"cast": cast}).get("panels", {})  # agent: raises AwaitAgent
        regen = []
        for p in check:
            pid = p["id"]
            e = qa["panels"][pid]
            v = vision.get(pid) or {"ok": True, "issues": []}
            e["issues"] = geo[pid] + list(v.get("issues") or [])
            e["ok"] = not e["issues"]
            if e["ok"]:
                continue
            if not v.get("ok", True) and e.get("attempts", 0) < MAX_ATTEMPTS and not state["picks"].get(pid):
                e["attempts"] = e.get("attempts", 0) + 1
                regen.append(pid)
            else:
                e["flagged"] = True
        _write(ctx.slug, "qa.json", qa)
        if not regen:
            break
        ctx.progress("qa", len(targets) - len(check), len(targets), f"regenerating {', '.join(regen)}")
        ids = [_enqueue(ctx.slug, pid, random.randint(1, 99999), {"qa_attempt": qa["panels"][pid]["attempts"]}) for pid in regen]
        _wait_jobs(ctx, ids)
    flagged = [pid for pid, e in qa["panels"].items() if e.get("flagged")]
    ok = [pid for pid, e in qa["panels"].items() if e.get("ok")]
    ctx.progress("qa", len(ok) + len(flagged), len(qa["panels"]))
    if flagged:
        return {"status": "flagged", "detail": f"{len(ok)} passed, {len(flagged)} flagged for a manual fix: {', '.join(flagged)}"}
    return {"detail": f"{plural(len(ok), 'panel')} passed"}


RUNNERS = {
    "analysis": stage_analysis,
    "script": stage_script,
    "layout": stage_layout,
    "artwork": stage_artwork,
    "lettering": stage_lettering,
    "qa": stage_qa,
}


# ---- new project from source ----------------------------------------------------------------


def new_project(title: str, text: str, mode: str = "page", direction: str = "rtl", provider: str | None = None, autostart: bool = True) -> str:
    if mode not in ("page", "webtoon"):
        raise PipelineError("mode must be page or webtoon")
    if direction not in ("rtl", "ltr"):
        raise PipelineError("direction must be rtl or ltr")
    base = st.slugify(title) or "story"
    slug, n = base, 2
    while (st.STORIES / slug).exists():
        slug, n = f"{base}-{n}", n + 1
    data = {
        "title": title,
        "notes": "Created from source text by the automated pipeline. Open the Pipeline view to follow or override each stage.",
        "format": {
            "mode": mode,
            "direction": direction,
            "page": {"width": 1654, "height": 2339},
            "gutter": 0.018,
            "margin": 0.06,
        },
        "defaults": {"model": "qwen-image-2.1-turbo", "quantize": 4, "width": 864, "height": 1152},
        "refs": {},
        "cast": {},
        "blocks": {"style": STYLE[mode]},
        "avoid": "any text, letters, speech bubbles, watermark, signature",
        "pages": [],
        "panels": [],
    }
    pj.write_new(slug, data)
    (st.STORIES / slug / "source.md").write_text(text)
    prov = provider or _default_provider()
    _save_state(slug, _blank_state(prov))
    bump()
    if autostart and text.strip():
        run(slug, "analysis", "qa", prov)
    return slug


def set_source(slug: str, text: str) -> None:
    st.load(slug)
    (st.STORIES / slug / "source.md").write_text(text)
    if not (pdir(slug) / "state.json").exists():
        _save_state(slug, _blank_state(_default_provider()))
    coverage.compute(slug)
    bump()
