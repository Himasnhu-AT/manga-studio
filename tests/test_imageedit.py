"""Image editing: segment, pixel ops, new versions with edited_from, fix/extend jobs, path guards."""

import base64
import io
import json
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from studio import imageedit, segment as seg, server, story as st

client = TestClient(server.app)
W, H = 160, 200


def scene() -> Image.Image:
    """Grey background, a red square at (40..80, 40..80) and a blue disc lower right."""
    im = Image.new("RGB", (W, H), (200, 200, 200))
    d = ImageDraw.Draw(im)
    d.rectangle([40, 40, 79, 79], fill=(220, 30, 30))
    d.ellipse([90, 120, 140, 170], fill=(30, 60, 220))
    return im


def png_url(m: np.ndarray) -> str:
    return imageedit.encode_png(m)


@pytest.fixture
def story():
    slug = client.post("/api/projects", json={"title": "Edit test", "template": "sample"}).json()["slug"]
    s = st.load(slug)
    d = s.dir / "out" / "p03"
    d.mkdir(parents=True)
    scene().save(d / "001-s5.png")
    (d / "001-s5.json").write_text(json.dumps({"seed": 5, "prompt": "p", "width": W, "height": H}))
    client.patch(f"/api/stories/{slug}/panels/p03", json={"refs": [], "cast": []})  # no sheet versions in this copy
    return slug


def red_mask():
    m = np.zeros((H, W), bool)
    m[40:80, 40:80] = True
    return m


# ---- segment ---------------------------------------------------------------------


def test_color_segment_selects_connected_region():
    r = seg.segment(scene(), (60 / W, 60 / H), method="color", tolerance=0.1)
    m = np.asarray(r["mask"]) > 127
    assert r["method"] == "color"
    assert m[60, 60] and m.sum() == 40 * 40  # exactly the square, not the background
    bg = np.asarray(seg.segment(scene(), (0.02, 0.02), method="color")["mask"]) > 127
    assert bg[5, 5] and not bg[60, 60] and not bg[145, 115]


def test_segment_endpoint_fallback(story, monkeypatch):
    monkeypatch.setattr(seg, "vision_available", lambda: False)
    r = client.post(f"/api/stories/{story}/panels/p03/segment", json={"point": [60 / W, 60 / H], "method": "auto"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["method"] == "color" and j["file"] == "001-s5.png" and j["size"] == [W, H]
    m = np.asarray(imageedit.decode_png(j["mask"])) > 127
    assert m.sum() == 1600
    assert client.post(f"/api/stories/{story}/panels/p03/segment", json={"point": [0.5, 0.5], "method": "vision"}).status_code == 400


@pytest.mark.skipif(not seg.vision_available(), reason="Apple Vision not available")
def test_vision_segment_runs():
    im = Image.new("RGB", (512, 512), (235, 235, 235))
    d = ImageDraw.Draw(im)
    d.ellipse([150, 100, 360, 470], fill=(40, 40, 40))
    r = seg.segment(im, (0.5, 0.5), method="auto")
    assert r["method"] in ("vision", "color")  # Vision may not call a blob an object; auto still answers
    assert (np.asarray(r["mask"]) > 127)[256, 256]


# ---- pixel ops ---------------------------------------------------------------------------


def test_mask_modes_and_rect():
    ctx = imageedit.apply_ops(
        scene(),
        [
            {"op": "mask", "id": "a", "rect": [0, 0, 0.5, 1]},
            {"op": "mask", "id": "a", "rect": [0, 0, 0.25, 1], "mode": "subtract"},
            {"op": "mask", "id": "b", "poly": [[0, 0], [1, 0], [0, 1]]},
        ],
    )
    a = ctx.masks["a"]
    assert not a[:, : W // 4 - 1].any() and a[:, W // 4 + 1 : W // 2 - 1].all()
    assert ctx.masks["b"][2, 2] and not ctx.masks["b"][H - 2, W - 2]
    assert not ctx.changed


def test_move_lifts_fills_and_pastes():
    ctx = imageedit.apply_ops(scene(), [{"op": "mask", "id": "m", "png": png_url(red_mask())}, {"op": "move", "mask": "m", "dx": 0.25, "dy": 0.3}])
    a = np.asarray(ctx.img).astype(int)
    assert a[120, 100][0] > 180 and a[120, 100][2] < 80  # red square moved 40px right, 60px down
    hole = a[60, 60]
    assert abs(hole - [200, 200, 200]).max() < 40  # old spot filled with background


def test_move_scale_flip_rotate_keep_center():
    m = red_mask()
    ctx = imageedit.apply_ops(scene(), [{"op": "move", "mask": png_url(m), "scale": 0.5, "flip": "h", "rotate": 90}])
    a = np.asarray(ctx.img).astype(int)
    assert a[60, 60][0] > 180  # still centred on the old centre
    assert abs(a[42, 42] - [200, 200, 200]).max() < 40  # corners shrank away and were filled


def test_erase_crop_rotate_flip_adjust():
    m = png_url(red_mask())
    ctx = imageedit.apply_ops(scene(), [{"op": "erase", "mask": m}])
    assert abs(np.asarray(ctx.img).astype(int)[60, 60] - [200, 200, 200]).max() < 40
    ctx = imageedit.apply_ops(scene(), [{"op": "mask", "id": "m", "png": m}, {"op": "crop", "box": [0.25, 0.2, 0.5, 0.5]}])
    assert ctx.size == (80, 100) and ctx.masks["m"][0, 0] and ctx.masks["m"].sum() == 1600  # mask followed the crop
    ctx = imageedit.apply_ops(scene(), [{"op": "rotate", "deg": 90}])
    assert ctx.size == (H, W)
    a = np.asarray(ctx.img)
    assert a[60, H - 60][0] > 180  # clockwise: (x, y) -> (H - y, x)
    ctx = imageedit.apply_ops(scene(), [{"op": "flip", "axis": "h"}])
    assert np.asarray(ctx.img)[60, W - 61][0] > 180
    ctx = imageedit.apply_ops(scene(), [{"op": "adjust", "brightness": 0.5, "mask": m}])
    a = np.asarray(ctx.img).astype(int)
    assert a[60, 60][0] < 130 and a[5, 5][0] == 200  # only the selection darkened
    with pytest.raises(imageedit.EditError):
        imageedit.apply_ops(scene(), [{"op": "rotate", "deg": 45}])
    with pytest.raises(imageedit.EditError):
        imageedit.apply_ops(scene(), [{"op": "erase", "mask": "nope"}])
    with pytest.raises(imageedit.EditError):
        imageedit.apply_ops(scene(), [{"op": "explode"}])


def test_extend_pads_and_marks_hole():
    ctx = imageedit.apply_ops(scene(), [{"op": "extend", "side": "down", "amount": 0.2}])
    w, h = ctx.size
    assert w == W and h % 16 == 0 and h > H
    assert ctx.holes[h - 1].all() and not ctx.holes[: H - 1].any()


def test_diffuse_fallback():
    out = imageedit._diffuse(scene(), red_mask())
    assert abs(np.asarray(out).astype(int)[60, 60] - [200, 200, 200]).max() < 30


# ---- endpoint: versions, preview, jobs, path checks ----------------------------------


def wait_jobs(ids, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        js = [client.get(f"/api/jobs/{i}").json() for i in ids]
        if all(j["status"] in ("done", "error", "cancelled") for j in js):
            return js
        time.sleep(0.2)
    raise TimeoutError(ids)


def test_edit_saves_new_version_with_ops(story):
    src = st.STORIES / story / "out" / "p03" / "001-s5.png"
    before = src.read_bytes()
    pv = client.post(f"/api/stories/{story}/panels/p03/edit", json={"ops": [{"op": "flip", "axis": "h"}], "preview": True}).json()
    assert pv["image"].startswith("data:image/png") and pv["size"] == [W, H]
    assert len(st.versions(st.load(story), "p03")) == 1  # preview saves nothing

    ops = [{"op": "mask", "id": "m", "png": png_url(red_mask())}, {"op": "move", "mask": "m", "dx": 0.2, "dy": 0.1}, {"op": "adjust", "contrast": 1.1}]
    r = client.post(f"/api/stories/{story}/panels/p03/edit", json={"file": "001-s5.png", "ops": ops})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["file"] == "002-s5.png" and j["jobs"] == []
    assert src.read_bytes() == before  # original never changes
    meta = json.loads((src.parent / "002-s5.json").read_text())
    assert meta["edited_from"] == "001-s5.png" and [o["op"] for o in meta["ops"]] == ["mask", "move", "adjust"]
    assert meta["ops"][0]["png"] == "masks/002-s5-0.png" and (src.parent / "masks" / "002-s5-0.png").exists()
    # the recorded ops replay to the same pixels
    replay = client.post(f"/api/stories/{story}/panels/p03/edit", json={"file": "001-s5.png", "ops": meta["ops"], "preview": True}).json()
    a = np.asarray(Image.open(io.BytesIO(base64.b64decode(replay["image"].split(",")[1]))).convert("RGB"))
    assert (a == np.asarray(Image.open(src.parent / "002-s5.png").convert("RGB"))).all()
    d = client.get(f"/api/stories/{story}").json()
    p = next(p for p in d["panels"] if p["id"] == "p03")
    assert [v["file"] for v in p["versions"]] == ["001-s5.png", "002-s5.png"]  # masks/ is not a version


def test_fix_queues_inpaint_and_img2img(story):
    m = png_url(red_mask())
    r = client.post(f"/api/stories/{story}/panels/p03/edit", json={"ops": [{"op": "fix", "prompt": "make the square a cat", "mask": m, "count": 2}]})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["file"] is None and j["source"] == "001-s5.png" and len(j["jobs"]) == 2
    done = wait_jobs(j["jobs"])
    assert all(x["status"] == "done" for x in done), done
    job = client.get(f"/api/jobs/{j['jobs'][0]}").json()
    assert job["plan"]["refs"][0]["version"] == "001-s5.png" and "EDIT: make the square a cat" in job["plan"]["prompt"]
    assert (job["plan"]["width"], job["plan"]["height"]) == (256, 320)  # source aspect, at least 256px
    out = st.STORIES / story / "out" / "p03" / done[0]["file"]
    meta = json.loads(out.with_suffix(".json").read_text())
    assert meta["edited_from"] == "001-s5.png" and meta["fix"] == "make the square a cat" and meta["copilot"] == "inpaint" and meta["mask"]["bbox"]
    # inpaint keeps pixels outside the (grown) mask
    a, b = np.asarray(Image.open(out).convert("RGB")).astype(int), np.asarray(scene()).astype(int)
    assert abs(a[190, 5] - b[190, 5]).max() < 3

    r = client.post(f"/api/stories/{story}/panels/p03/edit", json={"ops": [{"op": "fix", "prompt": "brighter", "strength": 0.4, "count": 1}]}).json()
    job = client.get(f"/api/jobs/{r['jobs'][0]}").json()
    assert job["meta"]["copilot"] == "img2img" and job["plan"]["strength"] == 0.4
    assert client.post(f"/api/stories/{story}/panels/p03/edit", json={"ops": [{"op": "fix", "prompt": ""}]}).status_code == 400
    assert client.post(f"/api/stories/{story}/panels/p03/edit", json={"ops": [{"op": "fix", "prompt": "x"}, {"op": "flip"}]}).status_code == 400
    wait_jobs(r["jobs"])


def test_extend_saves_padded_version_and_outpaints(story):
    r = client.post(f"/api/stories/{story}/panels/p03/edit", json={"ops": [{"op": "extend", "side": "down", "amount": 0.25, "prompt": "show her legs"}]}).json()
    assert r["file"] == "002-s5.png" and len(r["jobs"]) == 2 and r["size"][1] > H
    job = client.get(f"/api/jobs/{r['jobs'][0]}").json()
    assert job["meta"]["copilot"] == "inpaint" and job["meta"]["source"] == "002-s5.png" and abs(job["plan"]["height"] / job["plan"]["width"] - r["size"][1] / r["size"][0]) < 0.05
    assert "show her legs" in job["plan"]["prompt"]
    wait_jobs(r["jobs"])


def test_edit_path_guards(story):
    for bad in ("../../story.yaml", "../p01/001-s5.png", "/etc/passwd", "masks/x.png"):
        r = client.post(f"/api/stories/{story}/panels/p03/edit", json={"file": bad, "ops": [{"op": "flip"}]})
        assert r.status_code == 400, bad
        r = client.post(f"/api/stories/{story}/panels/p03/segment", json={"file": bad, "point": [0.5, 0.5]})
        assert r.status_code == 400, bad
    r = client.post(f"/api/stories/{story}/panels/p03/edit", json={"ops": [{"op": "erase", "mask": {"png": "../../../story.yaml"}}]})
    assert r.status_code == 400
    assert client.post(f"/api/stories/..%2F..%2Fetc/panels/p03/edit", json={"ops": []}).status_code == 404
    assert client.post(f"/api/stories/{story}/panels/nope/edit", json={"ops": []}).status_code == 404
    assert client.post(f"/api/stories/{story}/panels/p03/copilot", json={"mode": "img2img", "source": "../../story.yaml"}).status_code == 400
