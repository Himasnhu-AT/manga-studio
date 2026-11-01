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


def test_settings_and_app_endpoints(monkeypatch, tmp_path):
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

    # no real agent CLIs or ~/.local/bin: CI has neither claude nor codex
    monkeypatch.setenv("STUDIO_MCP_BIN_DIR", str(tmp_path / "bin"))
    monkeypatch.setattr(appsvc, "_agent", lambda b, **_: {"installed": True, "connected": b == "claude"})
    monkeypatch.setattr(appsvc, "_registered_command", lambda b: "manga-studio-mcp")
    monkeypatch.setattr(appsvc, "_ollama", lambda url: {"installed": True, "running": False, "models": []})
    integ = client.get("/api/integrations").json()
    assert integ["claude"]["connected"] and not integ["codex"]["connected"]
    assert integ["mcp"]["command"] == ["manga-studio-mcp"]
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


def test_one_word_strings_survive_yaml_round_trip(sample):
    """ruamel writes YAML 1.2, PyYAML reads 1.1: `Yes`/`On`/`12:30` must come back as strings."""
    from studio import project as pj

    with pj.edit(sample) as d:
        p = pj.panel(d, "p03")
        pj.set_keys(p, {"title": "Yes", "bubbles": [{"text": "On", "at": [0.5, 0.2]}, {"text": "12:30", "at": [0.5, 0.6]}]})
    p = st.load(sample).panel("p03")
    assert p["title"] == "Yes"
    assert [b["text"] for b in p["bubbles"]] == ["On", "12:30"]


def test_auto_letter_keeps_bubbles_moved_while_planning(sample, monkeypatch):
    """A bubble the user places during the (slow) salience search keeps the user's position."""
    from studio import project as pj

    with pj.edit(sample) as d:
        pj.set_keys(pj.panel(d, "p03"), {"bubbles": [{"id": "a", "text": "First"}, {"id": "b", "text": "Second"}]})
    real = lettering.salience

    def slow_salience(img):
        with pj.edit(sample) as d:  # the user drags bubble b mid-plan
            pj.panel(d, "p03")["bubbles"][1]["at"] = pj.from_plain([0.25, 0.75])
        return real(img)

    monkeypatch.setattr(lettering, "salience", slow_salience)
    n = lettering.auto_letter(st.load(sample), "p03")
    bs = st.load(sample).panel("p03")["bubbles"]
    assert n == 1 and bs[0]["at"] and bs[1]["at"] == [0.25, 0.75]


def test_story_slugs_cannot_escape_stories_dir():
    # `..` as a slug used to resolve to the stories folder's parent (the repo root) and serve any
    # file in it, .env included.
    (st.STORIES.parent / "secret.txt").write_text("nope")
    for url in ("/files/%2E%2E/secret.txt", "/files/%2E/../secret.txt",
                "/api/stories/%2E%2E", "/api/stories/%2E%2E/feedback"):
        assert client.get(url).status_code == 404, url
    assert client.put("/api/stories/%2E%2E/meta", json={"title": "x"}).status_code in (404, 405, 422), "edit"


def test_panel_order(sample):
    ids = [p["id"] for p in st.load(sample).panels]
    new = ids[:2] + list(reversed(ids[2:]))
    r = client.put(f"/api/stories/{sample}/panels/order", json={"order": new})
    assert r.status_code == 200, r.text
    assert [p["id"] for p in st.load(sample).panels] == new
    text = (st.STORIES / sample / "story.yaml").read_text()
    assert "# ---- references" in text and "# ---- story" in text  # comments survive the reorder
    assert client.put(f"/api/stories/{sample}/panels/order", json={"order": new[:-1]}).status_code == 400
    assert client.put(f"/api/stories/{sample}/panels/order", json={"order": new[:-1] + [new[0]]}).status_code == 400
    assert client.put(f"/api/stories/{sample}/panels/order", json={"order": new[:-1] + ["nope"]}).status_code == 400


def test_auto_crop_matches_canvas():
    # Expected numbers worked by hand from app/src/lib/layout.ts artFrame/autoCrop:
    # 864x1152 art (aspect 0.75) in a 2:1 slot -> visible = 0.375 of the height.
    ia, sa = 864 / 1152, 2.0
    top_bubble = {"bubbles": [{"text": "Hi", "at": [0.7, 0.1]}]}
    c = export.auto_crop(top_bubble, ia, sa)  # top = 0.1 - 0.09 = 0.01 -> y = 0.01 / 0.625 = 0.016
    assert c["x"] == 0.5 and c["scale"] == 1 and c["y"] == pytest.approx(0.016)
    left, top, w, h = export.art_frame(ia, sa, c)  # h = 2 / 0.75 * 100 = 266.67%
    assert (left, w) == (0, 100) and h == pytest.approx(266.6667, abs=1e-3) and top == pytest.approx(-2.66667, abs=1e-4)
    low = {"bubbles": [{"text": "Hi", "at": [0.5, 0.6]}]}  # 0.51 / 0.625 = 0.816 -> capped at 0.5
    assert export.auto_crop(low, ia, sa)["y"] == 0.5
    assert export.auto_crop({}, ia, sa) is None  # no lettering: centred cover
    assert export.auto_crop(top_bubble, ia, 0.5) is None  # tall slot: no vertical overflow
    explicit = {"crop": {"x": 0.2, "y": 0.9, "scale": 1.5}, **top_bubble}
    assert export.auto_crop(explicit, ia, sa) == explicit["crop"]
    # explicit crop in a tall slot: width overflows, focal x works like object-position
    left, top, w, h = export.art_frame(ia, 0.5, explicit["crop"])  # w = 0.75/0.5*100*1.5 = 225, h = 150
    assert w == pytest.approx(225) and h == pytest.approx(150)
    assert left == pytest.approx(-25) and top == pytest.approx(-45)
    # slot pixels: 1000x500 slot, top bubble -> frame top -13.33px, 1000 x 1333.33px
    assert export.slot_frame_px(top_bubble, (864, 1152), 1000, 500) == pytest.approx((0, -13.3333, 1000, 1333.333), abs=1e-3)


def test_export_frames_wide_slot_like_canvas():
    art = Image.new("RGB", (864, 1152), (240, 240, 240))
    ImageDraw.Draw(art).rectangle([0, 0, 863, 114], fill=(220, 30, 30))  # red band = top 10% where bubbles live
    with_bubble = export._fit(art, {"bubbles": [{"text": "Hi", "at": [0.7, 0.1]}]}, 1000, 500)
    assert with_bubble.getpixel((500, 5))[:3] == (220, 30, 30)  # top of the art stays in view
    centred = export._fit(art, {}, 1000, 500)
    assert centred.getpixel((500, 5))[:3] == (240, 240, 240)  # plain cover crop cuts the top band


def test_page_devices_validate_and_export(sample):
    """Manga page devices: empty slots, borders, bleed, a page background, black paper, and the cut-out
    character (pop out of the frame / float with no frame) all save and export."""
    url = f"/api/stories/{sample}/pages"
    # empty slots are allowed (templates and splits leave them); bad values are refused
    assert client.put(url, json={"pages": [{"id": "pg1", "panels": [{"panel": "", "box": [0, 0, 1, 1]}]}]}).status_code == 200
    assert client.put(url, json={"pages": [{"id": "pg1", "panels": [{"panel": "p01", "box": [0, 0, 1, 1], "border": "wavy"}]}]}).status_code == 400
    assert client.put(url, json={"pages": [{"id": "pg1", "panels": [{"panel": "p01", "box": [0, 0, 1, 1], "subject": "float"}]}]}).status_code == 400
    assert client.put(url, json={"pages": [{"id": "pg1", "background": {"panel": "nope"}, "panels": []}]}).status_code == 400

    # cut out p01's character by clicking it (colour flood where Vision isn't available)
    r = client.post(f"/api/stories/{sample}/panels/p01/subject", json={"point": [0.5, 0.5]})
    assert r.status_code == 200, r.text
    assert r.json()["subject"].startswith("out/p01/masks/subject-")
    d = client.get(f"/api/stories/{sample}").json()
    assert next(p for p in d["panels"] if p["id"] == "p01")["subject"]

    pages = [
        {
            "id": "pg1",
            "paper": "black",
            "background": {"panel": "p02", "opacity": 0.5},
            "panels": [
                {"panel": "p03", "box": [0, 0, 1, 0.3], "bleed": True, "border": "bold"},
                {"panel": "p01", "box": [0.5, 0.33, 0.5, 0.3], "subject": "pop"},
                {"panel": "p04", "box": [0, 0.33, 0.48, 0.3], "border": "none"},
                {"panel": "p01", "box": [0.1, 0.66, 0.5, 0.34], "subject": "cutout"},
                {"panel": "", "box": [0.62, 0.66, 0.38, 0.34]},
            ],
        }
    ]
    assert client.put(url, json={"pages": pages}).status_code == 200
    r = client.post(f"/api/stories/{sample}/export", json={"formats": ["png", "svg"], "preset": "print-a5"})
    assert r.status_code == 200, r.text
    files = r.json()["files"]
    root = st.STORIES / sample
    im = Image.open(root / next(f for f in files if f.endswith(".png"))).convert("RGB")
    # the bled top panel reaches the very corner of the bleed; plain paper elsewhere stays black
    assert im.getpixel((1, 1)) != export.PAPERS["black"]
    geo = export.page_geometry(st.load(sample), "print-a5", None, None)
    lx, ly, lw, lh = geo["live"]
    gutter_px = (int(lx + 0.49 * lw), int(ly + 0.315 * lh))  # between the rows, no panel there
    assert sum(im.getpixel(gutter_px)) < 3 * 140  # black paper behind a 50% background
    svg = (root / next(f for f in files if f.endswith(".svg"))).read_text()
    # frame lines: the bold bled panel and the pop-out panel; none for the borderless, cutout or empty slots
    assert svg.count('fill="none" stroke="#19191e"') == 2
    assert 'class="page-background"' in svg and 'class="subject pop"' in svg and 'class="subject cutout"' in svg

    # clearing the cut-out falls back to a normal framed panel
    assert client.post(f"/api/stories/{sample}/panels/p01/subject", json={"clear": True}).json()["subject"] is None
    assert client.post(f"/api/stories/{sample}/export", json={"formats": ["png"]}).status_code == 200


def test_import_art_becomes_picked_version(sample):
    """Your own drawing goes straight in as a version (transparent -> white paper, huge scans shrunk)."""
    buf = io.BytesIO()
    sketch = Image.new("RGBA", (4000, 5000), (0, 0, 0, 0))
    ImageDraw.Draw(sketch).line([(100, 100), (3900, 4900)], fill=(30, 60, 200, 255), width=20)
    sketch.save(buf, "PNG")
    r = client.post(f"/api/stories/{sample}/panels/p03/import", files={"file": ("rough page.png", buf.getvalue(), "image/png")})
    assert r.status_code == 200, r.text
    f = r.json()["file"]
    s = st.load(sample)
    assert st.picked_version(s, "p03") == f and f.endswith("-s0.png")
    im = Image.open(s.dir / "out" / "p03" / f)
    assert max(im.size) == server.ART_MAX_SIDE and im.mode == "RGB" and im.getpixel((5, 5)) == (255, 255, 255)
    meta = json.loads((s.dir / "out" / "p03" / f).with_suffix(".json").read_text())
    assert meta["engine"] == "import" and meta["imported"] == "rough page.png"
    assert client.post(f"/api/stories/{sample}/panels/p03/import", files={"file": ("notes.txt", b"hi", "text/plain")}).status_code == 400
    assert client.post(f"/api/stories/{sample}/panels/p03/import", files={"file": ("bad.png", b"nope", "image/png")}).status_code == 400


def test_refine_sketch_keeps_the_drawing_shape(sample):
    """Refine starts from the artist's drawing, at its shape and the story's usual size, with a preset prompt."""
    buf = io.BytesIO()
    Image.new("RGB", (3000, 1500), "white").save(buf, "PNG")  # a wide panel sketch
    f = client.post(f"/api/stories/{sample}/panels/p05/import", files={"file": ("wide.png", buf.getvalue(), "image/png")}).json()["file"]
    r = client.post(f"/api/stories/{sample}/panels/p05/refine", json={"preset": "tone", "count": 1})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == f and r.json()["strength"] == 0.6
    job = wait_jobs(r.json()["jobs"])[0]
    assert job["status"] == "done", job
    plan = job["plan"]
    assert plan["refs"][0]["version"] == f and "artist's own drawing" in plan["refs"][0]["label"]
    assert "screentone" in plan["prompt"] and plan["width"] % 16 == 0 and abs(plan["width"] / plan["height"] - 2) < 0.05
    assert plan["width"] * plan["height"] < 1.2 * 864 * 1152
    meta = json.loads((st.STORIES / sample / "out" / "p05" / job["file"]).with_suffix(".json").read_text())
    assert meta["refine"] == "tone" and meta["source"] == f
    assert client.post(f"/api/stories/{sample}/panels/p05/refine", json={"preset": "sparkles"}).status_code == 400


def test_drawing_layers_render_and_merge(sample):
    """Layers drawn in the Studio show in every render (even with no version yet) and merge into a version."""
    pid = client.post(f"/api/stories/{sample}/panels", json={"title": "Drawn"}).json()["id"]
    rough = Image.new("RGBA", (400, 600), (0, 0, 0, 0))
    ImageDraw.Draw(rough).line([(0, 0), (399, 599)], fill=(90, 140, 210, 255), width=12)
    inks = Image.new("RGBA", (400, 600), (0, 0, 0, 0))
    ImageDraw.Draw(inks).rectangle([150, 250, 250, 350], fill=(20, 20, 20, 255))

    def url(im):
        b = io.BytesIO()
        im.save(b, "PNG")
        return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()

    assert client.patch(f"/api/stories/{sample}/panels/{pid}", json={"drawing": [{"id": "rough", "name": "Rough", "opacity": 0.5}, {"id": "inks", "name": "Inks"}]}).status_code == 200
    assert client.put(f"/api/stories/{sample}/panels/{pid}/drawing/rough", json={"png": url(rough)}).status_code == 200
    assert client.put(f"/api/stories/{sample}/panels/{pid}/drawing/inks", json={"png": url(inks)}).status_code == 200
    assert client.put(f"/api/stories/{sample}/panels/{pid}/drawing/Bad%20Id", json={"png": url(inks)}).status_code == 400
    d = client.get(f"/api/stories/{sample}").json()
    assert set(next(p for p in d["panels"] if p["id"] == pid)["drawing_files"]) == {"rough", "inks"}

    from studio.compose import render_panel

    img = render_panel(st.load(sample), pid)  # no version yet: white paper + layers
    assert img.size == (400, 600) and img.getpixel((200, 300))[:3] == (20, 20, 20)
    r, g, b, _ = img.getpixel((5, 5))  # the blue rough at 50% over white
    assert b > r and r > 90

    f = client.post(f"/api/stories/{sample}/panels/{pid}/drawing/merge").json()["file"]
    s = st.load(sample)
    assert st.picked_version(s, pid) == f
    assert Image.open(s.dir / "out" / pid / f).getpixel((200, 300)) == (20, 20, 20)
    assert not (s.dir / "out" / pid / "drawing" / "inks.png").exists()
    assert client.post(f"/api/stories/{sample}/panels/{pid}/drawing/merge").status_code == 400


def _page_with_panels(rects, size=(1240, 1754)):
    """A white page with bordered panels drawn in it (rects in px), like a scan of hand-drawn work."""
    page = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(page)
    for x0, y0, x1, y1 in rects:
        d.rectangle([x0, y0, x1, y1], outline=(15, 15, 15), width=6)
        d.line([(x0 + 40, y0 + 60), (x1 - 40, y1 - 60)], fill=(60, 110, 200), width=5)  # some blue pencil art
    d.text((600, 1700), "12", fill=(0, 0, 0))  # a page number in the margin is not a panel
    return page


def test_detect_panels_on_a_scanned_page():
    from studio import pagescan

    rects = [(80, 80, 1160, 560), (640, 600, 1160, 1100), (80, 600, 600, 1100), (80, 1140, 1160, 1670)]
    found = pagescan.detect_panels(_page_with_panels(rects), rtl=True)
    assert len(found) == 4
    W, H = 1240, 1754
    want = [rects[0], rects[1], rects[2], rects[3]]  # reading order, right to left: top, right, left, bottom
    for f, (x0, y0, x1, y1) in zip(found, want):
        x, y, w, h = f["box"]
        assert abs(x - x0 / W) < 0.01 and abs(y - y0 / H) < 0.01 and abs(w - (x1 - x0) / W) < 0.015 and abs(h - (y1 - y0) / H) < 0.015
        assert f["unclear"] is False
    ltr = pagescan.detect_panels(_page_with_panels(rects), rtl=False)
    assert ltr[1]["box"][0] < ltr[2]["box"][0]  # left panel first when reading left to right


def test_scan_import_creates_panels_and_a_page(sample):
    rects = [(80, 80, 1160, 560), (640, 600, 1160, 1100), (80, 600, 600, 1100), (0, 1140, 1240, 1754)]
    buf = io.BytesIO()
    _page_with_panels(rects).save(buf, "PNG")
    r = client.post(f"/api/stories/{sample}/pages/scan", files={"file": ("ch1 page 03.png", buf.getvalue(), "image/png")})
    assert r.status_code == 200, r.text
    scan = r.json()
    assert scan["scan"] == "scans/ch1-page-03.png" and len(scan["panels"]) >= 3
    boxes = [[r_[0] / 1240, r_[1] / 1754, (r_[2] - r_[0]) / 1240, (r_[3] - r_[1]) / 1754] for r_ in rects]
    r = client.post(f"/api/stories/{sample}/pages/scan/apply", json={"scan": scan["scan"], "boxes": boxes, "stage": "pencils"})
    assert r.status_code == 200, r.text
    out = r.json()
    s = st.load(sample)
    page = next(pg for pg in s.data["pages"] if pg["id"] == out["page"])
    assert [sl["panel"] for sl in page["panels"]] == out["panels"]
    assert page["panels"][3].get("bleed") is True and not page["panels"][0].get("bleed")
    assert all(sl["border"] == "none" for sl in page["panels"])  # the scan has the artist's own frame lines
    p = s.panel(out["panels"][1])
    assert p["stage"] == "pencils"
    v = st.picked_version(s, p["id"])
    assert Image.open(s.dir / "out" / p["id"] / v).size == (520, 500)
    assert client.post(f"/api/stories/{sample}/pages/scan/apply", json={"scan": "../story.yaml", "boxes": boxes}).status_code == 400
    assert client.post(f"/api/stories/{sample}/pages/scan/apply", json={"scan": scan["scan"], "boxes": boxes, "stage": "done"}).status_code == 400


def test_detect_panels_without_opencv(monkeypatch):
    """The pure-numpy path finds the same panels when OpenCV isn't installed."""
    import sys

    from studio import pagescan

    monkeypatch.setitem(sys.modules, "cv2", None)  # import cv2 -> ImportError
    monkeypatch.setattr(pagescan, "WORK_SIDE", 300)  # keep the BFS quick
    rects = [(80, 80, 1160, 560), (80, 600, 1160, 1670)]
    found = pagescan.detect_panels(_page_with_panels(rects), rtl=True)
    assert len(found) == 2 and abs(found[1]["box"][1] - 600 / 1754) < 0.02


def test_detect_splits_panels_joined_by_a_bubble():
    from studio import pagescan

    page = _page_with_panels([(80, 1120, 560, 1670), (600, 1120, 1160, 1670), (80, 80, 1160, 1080)])
    ImageDraw.Draw(page).ellipse([480, 1180, 700, 1300], outline=(20, 20, 20), width=5, fill="white")  # bubble over the gutter
    found = pagescan.detect_panels(page, rtl=True)
    assert len(found) == 3
    right, left = found[1]["box"], found[2]["box"]
    assert abs(right[0] - 600 / 1240) < 0.02 and abs(left[0] - 80 / 1240) < 0.01 and left[0] + left[2] < 0.5


def test_video_hit_lands_song_moment_on_panel(sample, tmp_path):
    """--hit p03@20 starts the song so second 20 plays the moment panel p03 appears."""
    import shutil
    import subprocess

    from studio import compose, video

    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    s = st.load(sample)
    for p in s.panels:
        if p.get("strip", True) is not False:
            compose.compose_panel(s, p["id"])
    song = tmp_path / "song.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=90", str(song)], check=True)
    ids = [p["id"] for p in s.panels if p.get("strip", True) is not False]
    durs = [video._hold(p) + (0.5 if 0 < i < len(ids) - 1 else 0.25) for i, p in enumerate(p for p in s.panels if p.get("strip", True) is not False)]
    t3 = video.panel_start(durs, 0.5, ids.index("p03"))
    assert t3 > 0
    out = video.make_video(s, audio=song, hit=("p03", 20.0), out=tmp_path / "v.mp4")
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(out)], capture_output=True, text=True)
    assert probe.stdout.strip() == "aac"
