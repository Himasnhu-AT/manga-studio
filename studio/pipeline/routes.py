"""HTTP routes for the pipeline (Mode B). Mounted by studio.server."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from studio import llm, story as st
from studio.pipeline import core, coverage

router = APIRouter()

Stage = Literal["analysis", "script", "layout", "artwork", "lettering", "qa"]
Provider = Literal["agent", "ollama", "heuristic"]


def _story(slug: str) -> None:
    try:
        st.load(slug)
    except st.StoryError as e:
        raise HTTPException(404, str(e))


def _call(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except st.StoryError as e:
        raise HTTPException(404, str(e))
    except llm.SchemaError as e:
        raise HTTPException(400, f"invalid result: {e}")
    except core.Conflict as e:
        raise HTTPException(409, str(e))
    except (core.PipelineError, ValueError) as e:
        raise HTTPException(400, str(e))


class NewReq(BaseModel):
    title: str
    text: str
    mode: Literal["page", "webtoon"] = "page"
    direction: Literal["rtl", "ltr"] = "rtl"
    provider: Provider | None = None
    autostart: bool = True


@router.post("/api/pipeline/new")
def pipeline_new(req: NewReq):
    if not req.title.strip():
        raise HTTPException(400, "title is required")
    slug = _call(core.new_project, req.title.strip(), req.text, req.mode, req.direction, req.provider, req.autostart)
    return {"slug": slug}


class SourceReq(BaseModel):
    text: str


@router.get("/api/stories/{slug}/source")
def get_source(slug: str):
    _story(slug)
    return {"text": coverage.source_text(slug)}


@router.put("/api/stories/{slug}/source")
def put_source(slug: str, req: SourceReq):
    _call(core.set_source, slug, req.text)
    return {"ok": True}


@router.get("/api/stories/{slug}/pipeline")
def get_pipeline(slug: str):
    _story(slug)
    return core.public_state(slug)


class RunReq(BaseModel):
    model_config = {"populate_by_name": True}
    from_: Stage | None = Field(None, alias="from")
    to: Stage | None = None
    provider: Provider | None = None


@router.post("/api/stories/{slug}/pipeline/run")
def run_pipeline(slug: str, req: RunReq | None = None):
    req = req or RunReq()
    return _call(core.run, slug, req.from_, req.to, req.provider)


@router.post("/api/stories/{slug}/pipeline/cancel")
def cancel_pipeline(slug: str):
    _story(slug)
    core.cancel(slug)
    return {"ok": True}


@router.get("/api/stories/{slug}/pipeline/task")
def pipeline_task(slug: str):
    _story(slug)
    return core.get_task(slug)


class SubmitReq(BaseModel):
    stage: Stage
    result: Any


@router.post("/api/stories/{slug}/pipeline/submit")
def pipeline_submit(slug: str, req: SubmitReq):
    _story(slug)
    return _call(core.submit, slug, req.stage, req.result)


class OverrideReq(BaseModel):
    output: Any


@router.put("/api/stories/{slug}/pipeline/stages/{stage}")
def pipeline_override(slug: str, stage: Stage, req: OverrideReq):
    _story(slug)
    return _call(core.override, slug, stage, req.output)


@router.get("/api/stories/{slug}/coverage")
def get_coverage(slug: str):
    _story(slug)
    return coverage.compute(slug)
