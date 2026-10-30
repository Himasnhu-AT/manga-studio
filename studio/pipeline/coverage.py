"""Source coverage: which characters of source.md each panel adapts (so no story beat is skipped).

Panels carry `source_span: [start, end)` (char offsets into source.md). Coverage merges them,
reports gaps that contain real text, and writes stories/<slug>/source-coverage.json.
"""

from __future__ import annotations

import json

from studio import story as st


def source_text(slug: str) -> str:
    p = st.STORIES / slug / "source.md"
    return p.read_text() if p.exists() else ""


def compute(slug: str) -> dict:
    text = source_text(slug)
    n = len(text)
    try:
        panels = st.load(slug).panels
    except st.StoryError:
        panels = []
    marks: list[tuple[int, int, str]] = []
    for p in panels:
        sp = p.get("source_span")
        if isinstance(sp, (list, tuple)) and len(sp) == 2:
            s, e = max(0, min(n, int(sp[0]))), max(0, min(n, int(sp[1])))
            if e > s:
                marks.append((s, e, p["id"]))

    # Split the source at every span boundary; each segment lists the panels covering it.
    cuts = sorted({0, n, *(m[0] for m in marks), *(m[1] for m in marks)})
    spans, gaps = [], []
    covered = total = 0
    for a, b in zip(cuts, cuts[1:]):
        pids = [pid for s, e, pid in marks if s <= a and b <= e]
        seg = text[a:b]
        real = sum(1 for ch in seg if not ch.isspace())
        total += real
        if pids:
            covered += real
            if spans and spans[-1]["end"] == a and spans[-1]["panels"] == pids:
                spans[-1]["end"] = b
            else:
                spans.append({"start": a, "end": b, "panels": pids})
        elif real:
            if gaps and gaps[-1]["end"] == a:
                gaps[-1]["end"] = b
            else:
                gaps.append({"start": a, "end": b})
    out = {"length": n, "spans": spans, "covered_ratio": round(covered / total, 4) if total else 0.0, "gaps": gaps}
    d = st.STORIES / slug
    if d.exists():
        (d / "source-coverage.json").write_text(json.dumps(out, indent=1))
    return out
