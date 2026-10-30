"""Write side of story.yaml: round-trip edits that keep comments, key order and folded blocks.

Reads elsewhere still use `story.load()` (plain PyYAML -> dicts). Writes go through `edit()`:

    with edit(slug) as data:          # ruamel CommentedMap, mutate in place
        panel(data, "p01")["action"] = "..."

The file is written atomically when the block exits without an exception.
"""

from __future__ import annotations

import io
import threading
from contextlib import contextmanager
from pathlib import Path

import yaml
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.scalarstring import DoubleQuotedScalarString, FoldedScalarString

from studio import story as st

_lock = threading.Lock()


def _yaml() -> YAML:
    y = YAML()
    y.preserve_quotes = True
    y.width = 4096  # never re-wrap lines a human wrapped
    y.indent(mapping=2, sequence=4, offset=2)
    return y


def to_plain(obj):
    """ruamel containers -> plain dict/list (for JSON responses)."""
    if isinstance(obj, dict):
        return {str(k): to_plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_plain(v) for v in obj]
    if isinstance(obj, str):
        return str(obj)
    return obj


def from_plain(obj, long_text: bool = True):
    """Plain JSON value -> ruamel value. Long strings become folded `>-` blocks like hand-written ones;
    short lists of scalars (coordinates, ids) stay inline as `[a, b]`."""
    if isinstance(obj, dict):
        m = CommentedMap()
        for k, v in obj.items():
            m[k] = from_plain(v, long_text)
        return m
    if isinstance(obj, list):
        s = CommentedSeq(from_plain(v, long_text) for v in obj)
        if all(not isinstance(v, (dict, list)) for v in obj) and len(obj) <= 12:
            s.fa.set_flow_style()
            for i, v in enumerate(s):
                s[i] = _flow_safe(v)
        elif all(isinstance(v, dict) for v in obj) and obj and all(len(str(v)) < 140 for v in obj):
            for item in s:  # bubbles / page boxes: one flow mapping per line, like the hand-written yaml
                item.fa.set_flow_style()
                for k in list(item):
                    item[k] = _flow_safe(item[k])
        return s
    if isinstance(obj, str) and long_text and len(obj) > 90 and "\n" not in obj:
        return FoldedScalarString(obj)
    if isinstance(obj, str) and _pyyaml_retypes(obj):
        return DoubleQuotedScalarString(obj)
    return obj


def _pyyaml_retypes(v: str) -> bool:
    """We write with ruamel (YAML 1.2) but `story.load` reads with PyYAML (YAML 1.1), which turns
    plain `Yes`/`No`/`On`/`Off`/`y`, `12:30` (base 60), `1e3` etc. into non-strings. Quote those."""
    try:
        return yaml.safe_load(v) != v
    except yaml.YAMLError:
        return True


_FLOW_SPECIAL = set(",[]{}:#?&*!|>'\"%@`")


def _flow_safe(v):
    """Inside `{...}`/`[...]` plain scalars can't hold , ? : # etc.; quote text like the hand-written yaml does."""
    if isinstance(v, str) and not isinstance(v, DoubleQuotedScalarString):
        if not v or v != v.strip() or any(c in _FLOW_SPECIAL for c in v) or " " in v or _pyyaml_retypes(v):
            return DoubleQuotedScalarString(str(v))
    return v


def story_file(slug: str) -> Path:
    return st.STORIES / slug / "story.yaml"


@contextmanager
def edit(slug: str):
    f = story_file(slug)
    if not f.exists():
        raise st.StoryError(f"no story {slug!r}")
    with _lock:
        y = _yaml()
        data = y.load(f.read_text()) or CommentedMap()
        yield data
        buf = io.StringIO()
        y.dump(data, buf)
        tmp = f.with_suffix(".yaml.tmp")
        tmp.write_text(buf.getvalue())
        tmp.replace(f)


def write_new(slug: str, data: dict) -> Path:
    """Create stories/<slug>/story.yaml (+ refs/) from a plain dict."""
    d = st.STORIES / slug
    (d / "refs").mkdir(parents=True, exist_ok=True)
    buf = io.StringIO()
    _yaml().dump(from_plain(data), buf)
    (d / "story.yaml").write_text(buf.getvalue())
    return d


def panel(data, pid: str):
    for p in data.get("panels") or []:
        if p.get("id") == pid:
            return p
    raise st.StoryError(f"panel {pid!r} not found")


def set_keys(target, values: dict, allowed: set[str] | None = None) -> None:
    """Assign keys from a JSON body; None deletes the key."""
    for k, v in values.items():
        if allowed is not None and k not in allowed:
            raise st.StoryError(f"key {k!r} can't be set here (allowed: {', '.join(sorted(allowed))})")
        if v is None:
            target.pop(k, None)
        else:
            target[k] = from_plain(v)


def block(container):
    """Force block style on a mapping/sequence (one created as `{}`/`[]` would otherwise stay inline)."""
    fa = getattr(container, "fa", None)
    if fa is not None:
        fa.set_block_style()
    return container
