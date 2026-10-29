"""`studio` CLI: how Claude Code drives the studio. Generation goes through the running server
(so the model stays loaded); read-only commands work straight from disk.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import httpx

from studio import compose, story as st

URL = os.environ.get("STUDIO_URL", "http://127.0.0.1:7860")


def _api(method: str, path: str, **kw):
    try:
        r = httpx.request(method, URL + path, timeout=30, **kw)
    except httpx.ConnectError:
        sys.exit(f"studio server is not running at {URL}. Start it with: uv run studio serve")
    if r.status_code >= 400:
        try:
            msg = r.json().get("detail", r.text)
        except ValueError:
            msg = r.text
        sys.exit(f"error {r.status_code}: {msg}")
    return r.json()


def cmd_serve(a):
    import uvicorn

    if a.mock:
        os.environ["STUDIO_ENGINE"] = "mock"
    print(f"dashboard: http://127.0.0.1:{a.port}  (engine: {os.environ.get('STUDIO_ENGINE', 'mflux')})")
    uvicorn.run("studio.server:app", host=a.host, port=a.port, log_level="warning")


def cmd_stories(a):
    for slug in st.list_stories():
        s = st.load(slug)
        print(f"{slug:24} {s.data.get('title', '')}  ({len(s.panels)} panels)")


def cmd_show(a):
    s = st.load(a.story)
    state = st.read_state(s)
    print(f"# {s.data.get('title', s.slug)}  [{s.slug}]   settings: {s.settings()}")
    for p in s.panels:
        vs = st.versions(s, p["id"])
        pick = st.picked_version(s, p["id"])
        how = "picked" if state["picks"].get(p["id"]) else ("newest" if pick else "-")
        stars = [v["file"] for v in vs if state["stars"].get(f"{p['id']}/{v['file']}")]
        refs = ", ".join(r if isinstance(r, str) else r["ref"] for r in p.get("refs", [])) or "none"
        print(f"\n[{p['id']}] {p.get('title', '')}")
        print(f"  refs: {refs}   versions: {len(vs)}   use: {pick or '-'} ({how})" + (f"   starred: {', '.join(stars)}" if stars else ""))
        try:
            s.plan(p["id"], seed=0)
        except st.StoryError as e:
            print(f"  ! {e}")
        if vs and a.paths:
            for v in vs:
                print(f"    {s.dir / 'out' / p['id'] / v['file']}  seed={v.get('seed')}  {v.get('seconds', '?')}s")
    open_notes = [n for n in state["notes"] if not n.get("done")]
    if open_notes:
        print(f"\n{len(open_notes)} open note(s) from the dashboard: run `studio feedback {s.slug}`")


def cmd_prompt(a):
    s = st.load(a.story)
    plan = s.plan(a.panel, seed=a.seed)
    if a.json:
        print(json.dumps(plan, indent=2))
        return
    for i, r in enumerate(plan["refs"], 1):
        print(f"image {i}: {r['path']}  ({r['label']})")
    print(f"size {plan['width']}x{plan['height']}  model {plan['model']} q{plan['quantize']}  strength {plan['strength']}\n")
    print(plan["prompt"])


def _wait(ids: list[int]):
    pending = set(ids)
    last = {}
    results = {}
    while pending:
        for jid in list(pending):
            j = _api("GET", f"/api/jobs/{jid}")
            line = f"job {jid} [{j['panel']} seed {j['plan']['seed']}] {j['status']}"
            if j["status"] == "running" and j.get("steps"):
                line += f" step {j.get('step', 0)}/{j['steps']}"
            if last.get(jid) != line:
                print(line, flush=True)
                last[jid] = line
            if j["status"] in ("done", "error", "cancelled"):
                pending.discard(jid)
                results[jid] = j
        if pending:
            time.sleep(2)
    ok = True
    for jid, j in results.items():
        if j["status"] == "done":
            s = st.load(j["story"])
            print(f"DONE  {s.dir / 'out' / j['panel'] / j['file']}  ({j['finished'] - j['started']:.0f}s)")
        else:
            ok = False
            print(f"FAIL  job {jid}: {j.get('error', j['status'])}")
    if not ok:
        sys.exit(1)


def cmd_gen(a):
    ids = []
    for pid in a.panels:
        body = {"story": a.story, "panel": pid, "count": a.n}
        if a.seed:
            body["seeds"] = a.seed
        r = _api("POST", "/api/generate", json=body)
        print(f"queued {pid}: jobs {r['jobs']} seeds {r['seeds']}")
        ids += r["jobs"]
    if a.wait:
        _wait(ids)


def cmd_wait(a):
    ids = a.ids or [j["id"] for j in _api("GET", "/api/jobs", params={"active": True})]
    if not ids:
        print("no active jobs")
        return
    _wait(ids)


def cmd_jobs(a):
    for j in _api("GET", "/api/jobs", params={"active": a.active} if a.active else {}):
        extra = f" step {j.get('step', 0)}/{j.get('steps', '?')}" if j["status"] == "running" else ""
        extra += f" -> {j['file']}" if j.get("file") else ""
        extra += f" ! {j['error']}" if j.get("error") else ""
        print(f"{j['id']:4} {j['story']}/{j['panel']:10} seed {j['seed']:<6} {j['status']}{extra}")


def cmd_status(a):
    print(json.dumps(_api("GET", "/api/status"), indent=2))


def cmd_pick(a):
    _api("POST", f"/api/stories/{a.story}/pick", json={"panel": a.panel, "file": a.file})
    print(f"{a.story}/{a.panel}: using {a.file}")


def cmd_feedback(a):
    s = st.load(a.story)
    state = st.read_state(s)
    notes = [(i, n) for i, n in enumerate(state["notes"]) if a.all or not n.get("done")]
    if not notes:
        print("no open notes")
    for i, n in notes:
        where = n.get("panel") or "story"
        if n.get("file"):
            where += f"/{n['file']}"
            where += f"  ({s.dir / 'out' / n['panel'] / n['file']})"
        done = " [done]" if n.get("done") else ""
        print(f"#{i}{done} {n['at']}  {where}\n    {n['text']}")
        if n.get("reply"):
            print(f"    reply: {n['reply']}")
    if state["picks"]:
        print("\npicks: " + ", ".join(f"{k}={v}" for k, v in state["picks"].items()))
    if state["stars"]:
        print("stars: " + ", ".join(state["stars"]))


def cmd_resolve(a):
    _api("POST", f"/api/stories/{a.story}/notes/done", json={"index": a.index, "reply": a.reply})
    print(f"note #{a.index} marked done")


def cmd_compose(a):
    s = st.load(a.story)
    r = compose.compose_story(s) if not a.panel else {"composed": [str(compose.compose_panel(s, a.panel))]}
    print(json.dumps(r, indent=2))


def cmd_video(a):
    from pathlib import Path

    from studio import video

    s = st.load(a.story)
    out = video.make_video(s, fade=a.fade, audio=Path(a.audio) if a.audio else None, out=Path(a.out) if a.out else None)
    print(out)


def cmd_new(a):
    d = st.STORIES / a.slug
    if d.exists():
        sys.exit(f"{d} already exists")
    (d / "refs").mkdir(parents=True)
    tpl = st.ROOT / "templates" / "story.yaml"
    text = tpl.read_text().replace("TITLE", a.title or a.slug)
    (d / "story.yaml").write_text(text)
    print(f"created {d / 'story.yaml'}")


def main():
    ap = argparse.ArgumentParser(prog="studio", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("serve", help="run dashboard + generation worker")
    p.add_argument("--port", type=int, default=7860)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--mock", action="store_true", help="placeholder images, no model")
    p.set_defaults(fn=cmd_serve)

    sub.add_parser("stories", help="list stories").set_defaults(fn=cmd_stories)
    sub.add_parser("status", help="server + model status").set_defaults(fn=cmd_status)

    p = sub.add_parser("show", help="panels, versions, picks, problems")
    p.add_argument("story")
    p.add_argument("--paths", action="store_true", help="list every version file")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("prompt", help="print the exact prompt + refs a panel will use (dry run)")
    p.add_argument("story")
    p.add_argument("panel")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_prompt)

    p = sub.add_parser("gen", help="queue generations")
    p.add_argument("story")
    p.add_argument("panels", nargs="+")
    p.add_argument("-n", type=int, default=1, help="versions per panel (random seeds)")
    p.add_argument("--seed", type=int, nargs="+", help="explicit seeds")
    p.add_argument("--wait", action="store_true", help="block until done and print output paths")
    p.set_defaults(fn=cmd_gen)

    p = sub.add_parser("wait", help="wait for jobs (default: all active)")
    p.add_argument("ids", type=int, nargs="*")
    p.set_defaults(fn=cmd_wait)

    p = sub.add_parser("jobs", help="list jobs")
    p.add_argument("--active", action="store_true")
    p.set_defaults(fn=cmd_jobs)

    p = sub.add_parser("pick", help="choose the version a panel uses (as ref and in the strip)")
    p.add_argument("story")
    p.add_argument("panel")
    p.add_argument("file")
    p.set_defaults(fn=cmd_pick)

    p = sub.add_parser("feedback", help="notes, picks and stars left in the dashboard")
    p.add_argument("story")
    p.add_argument("--all", action="store_true", help="include resolved notes")
    p.set_defaults(fn=cmd_feedback)

    p = sub.add_parser("resolve", help="mark a dashboard note as handled")
    p.add_argument("story")
    p.add_argument("index", type=int)
    p.add_argument("--reply", help="short reply shown under the note in the dashboard")
    p.set_defaults(fn=cmd_resolve)

    p = sub.add_parser("compose", help="draw bubbles on picked panels and build final/strip.png")
    p.add_argument("story")
    p.add_argument("--panel")
    p.set_defaults(fn=cmd_compose)

    p = sub.add_parser("video", help="mp4 of the composed panels (zoom + crossfades) -> final/<story>.mp4")
    p.add_argument("story")
    p.add_argument("--audio", help="audio file to lay under it (trimmed + faded to the video length)")
    p.add_argument("--fade", type=float, default=0.5)
    p.add_argument("--out")
    p.set_defaults(fn=cmd_video)

    p = sub.add_parser("new", help="scaffold a story")
    p.add_argument("slug")
    p.add_argument("--title")
    p.set_defaults(fn=cmd_new)

    a = ap.parse_args()
    try:
        a.fn(a)
    except st.StoryError as e:
        sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()
