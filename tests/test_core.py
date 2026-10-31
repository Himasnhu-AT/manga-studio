"""Backend core: prompt stability, cast, round-trip edits, projects, copilot, lettering, export, settings."""

import base64
import io
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from studio import appsvc, export, lettering, story as st
from studio import server

HERE = Path(__file__).resolve().parent
client = TestClient(server.app)


def wait_jobs(ids, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        js = [client.get(f"/api/jobs/{i}").json() for i in ids]
        if all(j["status"] in ("done", "error", "cancelled") for j in js):
            return js
        time.sleep(0.2)
    raise TimeoutError(ids)


@pytest.fixture
def sample():
    """A fresh copy of cheek-squish (story.yaml + refs + generated versions) per test."""
    slug = client.post("/api/projects", json={"title": "Sample copy", "template": "sample"}).json()["slug"]
    src, dst = st.STORIES / "cheek-squish", st.STORIES / slug
    import shutil

    shutil.copytree(src / "out", dst / "out")
    if (src / "state.json").exists():
        shutil.copy2(src / "state.json", dst / "state.json")
    return slug


def test_cheek_squish_prompts_unchanged():
    base = json.loads((HERE / "cheek_squish_prompts.json").read_text())
    s = st.load("cheek-squish")
    for p in s.panels:
        assert s.plan(p["id"], seed=1)["prompt"] == base[p["id"]], p["id"]


def test_cast_injection(sample):
    r = client.put(f"/api/stories/{sample}/cast/mika", json={"name": "Mika", "role": "the neighbour", "face": "round face, freckles", "hair": "short mint-green bob", "outfit": "yellow raincoat", "refs": ["family-ref.png"]})
    assert r.status_code == 200, r.text
    assert client.patch(f"/api/stories/{sample}/panels/p05", json={"cast": ["mika"]}).status_code == 200
    plan = st.load(sample).plan("p05", seed=1)
    assert "MIKA: Mika, the neighbour: round face, freckles. Hair: short mint-green bob. Outfit: yellow raincoat." in plan["prompt"]
    assert plan["refs"][-1]["name"] == "family-ref.png"
    # explicit block wins over the compiled one
    client.patch(f"/api/stories/{sample}", json={"blocks": {"mika": "Mika, verbatim block."}})
    assert "MIKA: Mika, verbatim block." in st.load(sample).plan("p05", seed=1)["prompt"]
    # deleting the member removes it from panels
    assert client.delete(f"/api/stories/{sample}/cast/mika").status_code == 200
    assert "mika" not in (st.load(sample).panel("p05").get("cast") or [])


def test_patch_panel_keeps_comments(sample):
    f = st.STORIES / sample / "story.yaml"
    before = f.read_text()
    bubbles = [{"text": "Hello", "at": [0.5, 0.2], "w": 0.3, "style": "speech", "vertical": True}]
    r = client.patch(f"/api/stories/{sample}/panels/p02", json={"action": "A new action.", "bubbles": bubbles, "protect": [[0.1, 0.4, 0.2, 0.2]]})
    assert r.status_code == 200, r.text
    after = f.read_text()
    assert "# ---- references (not in the strip)" in after and "# Verbatim blocks." in after
    p = st.load(sample).panel("p02")
    assert p["action"] == "A new action." and p["bubbles"][0]["vertical"] is True
    # untouched panels keep their exact text
    assert before.split("  - id: p03")[1] == after.split("  - id: p03")[1]
    assert client.patch(f"/api/stories/{sample}/panels/p02", json={"nope": 1}).status_code == 400


def test_create_blank_project_and_panels():
    r = client.post("/api/projects", json={"title": "Rain Day", "mode": "webtoon", "direction": "ltr"})
    slug = r.json()["slug"]
    d = client.get(f"/api/stories/{slug}").json()
    assert d["title"] == "Rain Day" and d["format"]["mode"] == "webtoon" and d["format"]["direction"] == "ltr"
    assert d["cast"] == {} and d["pages"] == [] and d["has_source"] is False and d["pipeline"] is None
    pid = client.post(f"/api/stories/{slug}/panels", json={"title": "Second"}).json()["id"]
    assert pid == "p02"
    pages = client.post(f"/api/stories/{slug}/pages/auto", json={"per_page": 4}).json()["pages"]
    assert [sl["panel"] for sl in pages[0]["panels"]] == ["p01", "p02"]
    assert client.delete(f"/api/stories/{slug}/panels/p02").status_code == 200
    assert all(sl["panel"] != "p02" for pg in st.load(slug).data["pages"] for sl in pg["panels"])
    lst = {x["slug"]: x for x in client.get("/api/stories").json()}
    assert lst[slug]["mode"] == "webtoon" and "updated" in lst[slug]


def test_ref_upload(sample):
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(buf, "PNG")
    r = client.post(f"/api/stories/{sample}/refs", files={"file": ("../evil name.png", buf.getvalue(), "image/png")})
    assert r.json()["name"] == "evil-name.png"
    assert (st.STORIES / sample / "refs" / "evil-name.png").exists()
    r = client.post(f"/api/stories/{sample}/refs", files={"file": ("x.txt", b"hi", "text/plain")})
    assert r.status_code == 400


def test_copilot_img2img_and_inpaint(sample):
    s = st.load(sample)
    src = st.picked_version(s, "p03")
    r = client.post(f"/api/stories/{sample}/panels/p03/copilot", json={"mode": "img2img", "prompt": "make her smile wider"})
    assert r.status_code == 200, r.text
    job = wait_jobs(r.json()["jobs"])[0]
    assert job["status"] == "done", job
    assert job["plan"]["refs"][0]["version"] == src and job["plan"]["strength"] == 0.6
    assert "EDIT: make her smile wider" in job["plan"]["prompt"]
    assert job["plan"]["prompt"].startswith("Reference images. Image 1: the current panel")

    W, H = Image.open(s.dir / "out" / "p03" / src).size
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rectangle([0, 0, W // 4, H // 4], fill=255)
    buf = io.BytesIO()
    mask.save(buf, "PNG")
    url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    r = client.post(f"/api/stories/{sample}/panels/p03/copilot", json={"mode": "inpaint", "mask": url, "source": src})
    job = wait_jobs(r.json()["jobs"])[0]
    assert job["status"] == "done", job
    out = Image.open(s.dir / "out" / "p03" / job["file"]).convert("RGB")
    orig = Image.open(s.dir / "out" / "p03" / src).convert("RGB").resize(out.size)
    # far from the mask the source is kept, so the bottom-right corner matches the original
    assert out.getpixel((out.width - 5, out.height - 5)) == orig.getpixel((out.width - 5, out.height - 5))
    meta = json.loads((s.dir / "out" / "p03" / job["file"]).with_suffix(".json").read_text())
    assert meta["copilot"] == "inpaint" and meta["source"] == src


def test_auto_letter_avoids_protect(sample):
    face = [0.55, 0.05, 0.4, 0.35]
    client.patch(f"/api/stories/{sample}/panels/p04", json={"protect": [face], "bubbles": [{"text": "Aoi... what are you doing?", "w": 0.38}, {"text": "Hmm?", "w": 0.2}]})
    r = client.post(f"/api/stories/{sample}/letter", json={"panels": ["p04"]})
    assert r.json()["placed"] == {"p04": 2}
    s = st.load(sample)
    assert all(b.get("at") and b.get("tail") for b in s.panel("p04")["bubbles"])
    assert lettering.overlap_issues(s, "p04") == []
    # forcing a bubble onto the face is reported
    client.patch(f"/api/stories/{sample}/panels/p04", json={"bubbles": [{"text": "On the face", "at": [0.75, 0.2], "w": 0.3}]})
    assert any("covers protected area" in i for i in lettering.overlap_issues(st.load(sample), "p04"))


def test_export_page_and_webtoon(sample):
    r = client.post(f"/api/stories/{sample}/export", json={"formats": ["png", "svg", "pdf"], "preset": "print-a5"})
    assert r.status_code == 200, r.text
    files = r.json()["files"]
    d = st.STORIES / sample
    assert any(f.endswith(".pdf") for f in files) and any(f.endswith(".svg") for f in files)
    for f in files:
        assert (d / f).stat().st_size > 0
    png = next(f for f in files if f.endswith(".png"))
    im = Image.open(d / png)
    assert im.size == (export._px(148, 350) + 2 * export._px(3, 350), export._px(210, 350) + 2 * export._px(3, 350))  # trim + 3 mm bleed
    svg = (d / next(f for f in files if f.endswith(".svg"))).read_text()
    assert "<ellipse" in svg or "<polygon" in svg
    assert "Daaad!" in svg  # lettering stays vector text

    client.patch(f"/api/stories/{sample}", json={"format": {"mode": "webtoon"}})
    files = client.post(f"/api/stories/{sample}/export", json={"formats": ["png", "svg"]}).json()["files"]
    assert any(f.endswith("-webtoon.png") for f in files) and any(f.endswith("-001.png") for f in files)
    assert client.post(f"/api/stories/{sample}/export", json={"formats": ["gif"]}).status_code == 400


def test_compose_vertical_and_layers(sample):
    client.patch(
        f"/api/stories/{sample}/panels/p05",
        json={
            "bubbles": [{"text": "縦書きのテスト", "at": [0.2, 0.3], "vertical": True}],
            "layers": {"background": {"color": "#eeeeee"}, "fx": {"items": [{"type": "screentone", "density": 0.5, "opacity": 0.3}, {"type": "speedlines", "angle": 20}, {"type": "focuslines"}]}},
            "crop": {"x": 0.4, "y": 0.4, "scale": 1.3},
        },
    )
    r = client.post(f"/api/stories/{sample}/compose")
    assert "p05" in r.json()["composed"]


def test_settings_and_app_endpoints(monkeypatch):
    s = client.get("/api/settings").json()
    assert s["onboarded"] is False and s["llm"]["provider"] == "heuristic"
    s = client.put("/api/settings", json={"onboarded": True, "llm": {"provider": "ollama"}}).json()
    assert s["onboarded"] is True and s["llm"]["provider"] == "ollama" and s["llm"]["text_model"] == "qwen3:8b"
    assert appsvc.load_settings()["onboarded"] is True

    sysinfo = client.get("/api/system").json()
    assert sysinfo["engine"] == "mock" and "ram_gb" in sysinfo

    started = []
    monkeypatch.setattr(appsvc, "_download", lambda mid: started.append(mid) or appsvc._downloads[mid].update(downloading=False))
    assert client.post("/api/models/qwen-image-2.1/download").json()["ok"]
    time.sleep(0.1)
    assert started == ["qwen-image-2.1"]
    ms = {m["id"]: m for m in client.get("/api/models").json()}
    assert set(ms) == {"qwen-image-2.1-turbo", "qwen-image-2.1"}
    assert client.post("/api/models/nope/download").status_code == 404

    monkeypatch.setattr(appsvc, "_agent", lambda b, fresh=False: {"installed": True, "connected": b == "claude"})
    monkeypatch.setattr(appsvc, "_ollama", lambda url: {"installed": True, "running": False, "models": []})
    integ = client.get("/api/integrations").json()
    assert integ["claude"]["connected"] and not integ["codex"]["connected"]
    assert integ["mcp"]["command"][-2:] == ["studio", "mcp"]
    assert client.post("/api/integrations/claude/connect").json()["output"] == "already connected"


def test_sheet_casting_itself_and_unplaced_bubbles(sample):
    # a reference sheet that lists its cast must not use itself as a ref
    client.put(f"/api/stories/{sample}/cast/kai", json={"name": "Kai", "sheet": "sheet"})
    assert client.patch(f"/api/stories/{sample}/panels/sheet", json={"cast": ["kai"]}).status_code == 200
    plan = st.load(sample).plan("sheet", seed=1)
    assert all(r["name"] != "sheet" for r in plan["refs"])
    # pipeline-made bubbles: no `at` yet, extra keys; panels with camera/source_span
    r = client.patch(
        f"/api/stories/{sample}/panels/p06",
        json={"camera": "close-up", "source_span": [10, 80], "bubbles": [{"text": "Not placed yet", "speaker": "aoi"}, {"text": "Placed", "at": [0.3, 0.2], "speaker": "kai"}]},
    )
    assert r.status_code == 200, r.text
    assert "p06" in client.post(f"/api/stories/{sample}/compose").json()["composed"]
    files = client.post(f"/api/stories/{sample}/export", json={"formats": ["png", "svg"]}).json()["files"]
    assert files
    s = st.load(sample)
    assert "bubble 1 has no position" in lettering.overlap_issues(s, "p06")
    assert lettering.auto_letter(s, "p06") == 1
    assert all(b.get("at") for b in st.load(sample).panel("p06")["bubbles"])
