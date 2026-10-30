"""Pipeline (Mode B) end to end on the mock engine, plus the agent hand-off and the MCP bridge.

Runs against a scratch stories dir; never touches the real stories/ or loads the model.
"""

import os
import tempfile
import time
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="studio-pipeline-")
os.environ["STUDIO_ENGINE"] = "mock"
os.environ["STUDIO_STORIES"] = _TMP
os.environ["STUDIO_SETTINGS"] = str(Path(_TMP) / "settings.json")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from studio import llm, story as st  # noqa: E402
from studio.server import app  # noqa: E402

client = TestClient(app)

SOURCE = """Mira pushed open the door of the bakery before dawn. The ovens were still cold, and flour dust hung in the grey light. "Taro, wake up!" she called.

Taro stumbled out from the back room, hair sticking up. He rubbed his eyes and yawned. "Five more minutes, Mira," he mumbled, reaching for the counter.

Mira tossed him an apron and laughed. Together they lit the ovens, and by sunrise the bakery smelled of warm bread. "Best team in town," Taro said, grinning.
"""


def _wait(slug, until, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = client.get(f"/api/stories/{slug}/pipeline").json()
        if until(s):
            return s
        time.sleep(0.3)
    raise AssertionError(f"timed out; last state: {[(x['id'], x['status'], x.get('detail')) for x in s['stages']]}")


def _stage(s, sid):
    return next(x for x in s["stages"] if x["id"] == sid)


def test_schema_validator():
    with pytest.raises(llm.SchemaError):
        llm.validate({"cast": [], "locations": [], "beats": []}, llm.ANALYSIS_SCHEMA)  # minItems
    llm.validate({"panels": {"p01": {"ok": True, "issues": []}}}, llm.QA_SCHEMA)
    with pytest.raises(llm.SchemaError):
        llm.validate({"panels": {"p01": {"ok": "yes", "issues": []}}}, llm.QA_SCHEMA)


def test_heuristic_spans_are_exact():
    a = llm.HeuristicProvider().analysis(SOURCE, {})
    assert {c["name"] for c in a["cast"]} >= {"Mira", "Taro"}
    assert len(a["beats"]) == 3
    for b in a["beats"]:
        s, e = b["span"]
        assert SOURCE[s:e] == SOURCE[s:e].strip() and SOURCE[s:e]
    sc = llm.HeuristicProvider().script(SOURCE, a, {})
    llm.validate(sc, llm.SCRIPT_SCHEMA)
    lines = [d["text"] for pg in sc["pages"] for p in pg["panels"] for d in p["dialogue"]]
    assert "Taro, wake up!" in lines


def test_heuristic_end_to_end():
    r = client.post("/api/pipeline/new", json={"title": "Bakery Dawn", "text": SOURCE, "mode": "page", "direction": "rtl", "provider": "heuristic"})
    assert r.status_code == 200, r.text
    slug = r.json()["slug"]
    s = _wait(slug, lambda s: not s["running"] and (_stage(s, "qa")["status"] in ("done", "flagged") or any(x["status"] == "error" for x in s["stages"])), timeout=180)
    statuses = {x["id"]: (x["status"], x.get("detail")) for x in s["stages"]}
    assert all(v[0] in ("done", "flagged") for v in statuses.values()), statuses

    story = st.load(slug)
    assert {"mira", "taro"} <= set(story.data["cast"])
    ids = [p["id"] for p in story.panels]
    assert "sheet" in ids and any(i.startswith("plate-") for i in ids)
    strip = [p for p in story.panels if p.get("strip", True) is not False]
    assert len(strip) >= 3
    assert story.data["pages"] and all(1 <= len(pg["panels"]) <= 5 for pg in story.data["pages"])
    # every story panel has art and every bubble got a position
    for p in strip:
        assert st.picked_version(story, p["id"]), p["id"]
        for b in p.get("bubbles") or []:
            assert "at" in b, (p["id"], b)
    assert any(p.get("bubbles") for p in strip)
    # reference sheet became an anchor
    assert st.read_state(story)["picks"].get("sheet")
    # prompt carries cast and setting
    plan = story.plan(strip[0]["id"], seed=1)
    assert "Image 1" in plan["prompt"]

    cov = client.get(f"/api/stories/{slug}/coverage").json()
    assert cov["covered_ratio"] > 0.9, cov
    assert (st.STORIES / slug / "source-coverage.json").exists()

    detail = client.get(f"/api/stories/{slug}").json()
    assert detail["pipeline"] and len(detail["pipeline"]["stages"]) == 6

    # manual override of the layout re-applies and resets later stages
    pages = s["stages"][2]["output"]["pages"]
    r = client.put(f"/api/stories/{slug}/pipeline/stages/layout", json={"output": {"pages": pages[:1]}})
    assert r.status_code == 200, r.text
    after = r.json()
    assert _stage(after, "layout")["status"] == "done" and _stage(after, "artwork")["status"] == "idle"
    assert len(st.load(slug).data["pages"]) == 1


def test_webtoon_layout_has_no_pages():
    r = client.post("/api/pipeline/new", json={"title": "Scroll", "text": SOURCE, "mode": "webtoon", "direction": "ltr", "provider": "heuristic"})
    slug = r.json()["slug"]
    _wait(slug, lambda s: _stage(s, "layout")["status"] == "done" or any(x["status"] == "error" for x in s["stages"]))
    client.post(f"/api/stories/{slug}/pipeline/cancel")
    assert st.load(slug).data.get("pages") == []


def test_agent_handoff():
    r = client.post("/api/pipeline/new", json={"title": "Agent Run", "text": SOURCE, "mode": "page", "direction": "ltr", "provider": "agent"})
    slug = r.json()["slug"]
    s = _wait(slug, lambda s: _stage(s, "analysis")["status"] == "awaiting_agent")
    assert s["task"]["stage"] == "analysis" and "exact color words" in s["task"]["instructions"].lower()
    task = client.get(f"/api/stories/{slug}/pipeline/task").json()
    assert task["schema"]["required"] == ["cast", "locations", "beats"] and task["input"]["source"] == SOURCE

    bad = client.post(f"/api/stories/{slug}/pipeline/submit", json={"stage": "analysis", "result": {"cast": []}})
    assert bad.status_code == 400
    wrong = client.post(f"/api/stories/{slug}/pipeline/submit", json={"stage": "script", "result": {}})
    assert wrong.status_code == 409

    good = llm.HeuristicProvider().analysis(SOURCE, {})
    r = client.post(f"/api/stories/{slug}/pipeline/submit", json={"stage": "analysis", "result": good})
    assert r.status_code == 200, r.text
    s = _wait(slug, lambda s: _stage(s, "script")["status"] == "awaiting_agent")
    assert _stage(s, "analysis")["status"] == "done"
    assert "mira" in st.load(slug).data["cast"]

    script = llm.HeuristicProvider().script(SOURCE, good, {})
    r = client.post(f"/api/stories/{slug}/pipeline/submit", json={"stage": "script", "result": script})
    assert r.status_code == 200
    # layout, artwork, lettering run by themselves; QA comes back to the agent
    s = _wait(slug, lambda s: _stage(s, "qa")["status"] == "awaiting_agent" or any(x["status"] == "error" for x in s["stages"]), timeout=180)
    assert _stage(s, "qa")["status"] == "awaiting_agent", [(x["id"], x["status"], x.get("detail")) for x in s["stages"]]
    task = client.get(f"/api/stories/{slug}/pipeline/task").json()
    items = task["input"]["panels"]
    assert items and all(Path(i["image"]).exists() for i in items)
    verdict = {"panels": {i["panel"]: {"ok": True, "issues": []} for i in items}}
    verdict["panels"][items[0]["panel"]] = {"ok": False, "issues": ["hair color drifted"]}
    r = client.post(f"/api/stories/{slug}/pipeline/submit", json={"stage": "qa", "result": verdict})
    assert r.status_code == 200
    # the failing panel is regenerated and goes back to the agent for a second look
    s = _wait(slug, lambda s: _stage(s, "qa")["status"] == "awaiting_agent" and s["qa"]["panels"][items[0]["panel"]]["attempts"] == 1, timeout=120)
    task = client.get(f"/api/stories/{slug}/pipeline/task").json()
    assert [i["panel"] for i in task["input"]["panels"]] == [items[0]["panel"]]
    r = client.post(f"/api/stories/{slug}/pipeline/submit", json={"stage": "qa", "result": {"panels": {items[0]["panel"]: {"ok": True, "issues": []}}}})
    s = _wait(slug, lambda s: _stage(s, "qa")["status"] in ("done", "flagged"))
    assert _stage(s, "qa")["status"] == "done"


def test_mcp_tools_listed():
    import asyncio

    from studio import mcp_server

    tools = asyncio.run(mcp_server.server.list_tools())
    names = {t.name for t in tools}
    for need in ("list_projects", "get_project", "update_panel", "generate", "view_image", "get_feedback", "pipeline_task", "pipeline_submit"):
        assert need in names
