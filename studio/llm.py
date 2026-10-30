"""LLM providers for the pipeline's language stages (analysis, script, qa).

Three providers, picked per run:
    agent      an MCP client (Claude Code, Codex, ...) does the stage: we publish a task
               (instructions + input + JSON schema) and wait for `submit`.
    ollama     a local model through Ollama's /api/chat with structured output (`format`).
    heuristic  no LLM at all: deterministic text rules. Always works, good enough to get a draft.

Each stage asks `provider.<stage>(...)`. A provider either returns the result dict or raises
`AwaitAgent(task)` (agent provider only), which parks the stage until the agent submits.
"""

from __future__ import annotations

import base64
import io
import json
import re
from collections import Counter
from pathlib import Path

import httpx

# ---- schemas -------------------------------------------------------------

_SPAN = {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2}
_STR = {"type": "string"}

ANALYSIS_SCHEMA = {
    "type": "object",
    "required": ["cast", "locations", "beats"],
    "properties": {
        "cast": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "name", "role", "face", "hair", "outfit", "palette"],
                "properties": {k: _STR for k in ("id", "name", "role", "face", "hair", "outfit", "palette")},
            },
        },
        "locations": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["id", "name", "description"],
                "properties": {k: _STR for k in ("id", "name", "description")},
            },
        },
        "beats": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["id", "summary", "span"],
                "properties": {"id": _STR, "summary": _STR, "span": _SPAN},
            },
        },
    },
}

DIALOGUE = {
    "type": "object",
    "required": ["speaker", "text", "kind"],
    "properties": {"speaker": _STR, "text": _STR, "kind": {"type": "string", "enum": ["speech", "shout", "thought", "caption"]}},
}

SCRIPT_SCHEMA = {
    "type": "object",
    "required": ["pages"],
    "properties": {
        "pages": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["panels"],
                "properties": {
                    "panels": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "required": ["id", "beat", "span", "camera", "action", "cast", "location", "dialogue"],
                            "properties": {
                                "id": _STR,
                                "beat": _STR,
                                "span": _SPAN,
                                "camera": _STR,
                                "action": _STR,
                                "cast": {"type": "array", "items": _STR},
                                "location": _STR,
                                "dialogue": {"type": "array", "items": DIALOGUE},
                            },
                        },
                    }
                },
            },
        }
    },
}

QA_ITEM = {
    "type": "object",
    "required": ["ok", "issues"],
    "properties": {"ok": {"type": "boolean"}, "issues": {"type": "array", "items": _STR}},
}
QA_SCHEMA = {
    "type": "object",
    "required": ["panels"],
    "properties": {"panels": {"type": "object", "additionalProperties": QA_ITEM}},
}

SCHEMAS = {"analysis": ANALYSIS_SCHEMA, "script": SCRIPT_SCHEMA, "qa": QA_SCHEMA}


class SchemaError(ValueError):
    pass


def validate(value, schema: dict, path: str = "$") -> None:
    """Small JSON-schema subset: type, required, properties, additionalProperties, items, enum, min/maxItems."""
    t = schema.get("type")
    checks = {
        "object": lambda v: isinstance(v, dict),
        "array": lambda v: isinstance(v, list),
        "string": lambda v: isinstance(v, str),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "boolean": lambda v: isinstance(v, bool),
    }
    if t and not checks[t](value):
        raise SchemaError(f"{path}: expected {t}, got {type(value).__name__}")
    if "enum" in schema and value not in schema["enum"]:
        raise SchemaError(f"{path}: {value!r} is not one of {schema['enum']}")
    if t == "object":
        for k in schema.get("required", []):
            if k not in value:
                raise SchemaError(f"{path}: missing required key {k!r}")
        props = schema.get("properties", {})
        for k, v in value.items():
            if k in props:
                validate(v, props[k], f"{path}.{k}")
            elif isinstance(schema.get("additionalProperties"), dict):
                validate(v, schema["additionalProperties"], f"{path}.{k}")
    if t == "array":
        if len(value) < schema.get("minItems", 0):
            raise SchemaError(f"{path}: needs at least {schema['minItems']} item(s)")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise SchemaError(f"{path}: at most {schema['maxItems']} item(s)")
        if "items" in schema:
            for i, v in enumerate(value):
                validate(v, schema["items"], f"{path}[{i}]")


# ---- instructions (the agent sees these; ollama gets them as the system prompt) -----

_RULES = """Consistency rules (these come from how the image model behaves; follow them exactly):
- Exact color words, always: "pastel periwinkle-blue hair", never just "blue" (the model reads "blue" as navy).
- Name the outfit every time, with colors. Clothes are the first thing the model changes.
- No text in images. Dialogue goes in `dialogue`, never in `action`. Never ask for signs, labels, letters or speech bubbles in the art.
- One action = one frozen moment: who is where, doing what, with which expression, from which camera. No "then", no sequences.
- Characters are referred to by name in actions; their looks live in the cast entry, not repeated in actions.
- Spans are character offsets [start, end) into SOURCE exactly as given (0-based, end exclusive)."""

INSTRUCTIONS = {
    "analysis": f"""You are the source analyst for a manga adaptation. Read SOURCE and extract:

1. `cast`: every character who appears on the page more than in passing. `id` is a short lowercase slug
   (e.g. "kai"). `face`, `hair`, `outfit`, `palette` are concrete visual descriptions with exact color words
   (e.g. hair "messy layered silver-white hair that partly covers his eyes"; outfit "oversized plain black
   long-sleeve crewneck sweater, black pants"). Invent consistent specifics when the text is silent, and
   keep them plausible for the story. `role` is a few words ("the father", "rival swordsman").
2. `locations`: each distinct place. `description` is one paragraph an illustrator could paint an empty set
   from: layout, key furniture/props, light, time of day, palette.
3. `beats`: the story in order as pacing beats, each with a one-sentence `summary` and its exact `span`.
   Beats must tile the source: together they cover every non-blank character, in order, with no overlaps.

{_RULES}

Return only JSON matching the schema.""",
    "script": f"""You are the scriptwriter/storyboarder for a manga adaptation. Using ANALYSIS (cast, locations,
beats) and SOURCE, break the story into pages and panels.

- 3 to 6 panels per page for page-format manga; for a webtoon, think of each page as a scroll section.
- Every panel: `id` ("p01", "p02", ... in reading order), `beat` (a beat id), `span` (the exact source
  span this panel adapts; together the panels must cover every beat's span, in order), `camera` (wide,
  medium, close-up, extreme close-up, over-the-shoulder, low angle, bird's-eye...), `action` (one frozen
  moment, 1-3 sentences: positions, poses, expressions, what hands are doing, framing), `cast` (ids of
  characters visible), `location` (a location id), `dialogue` (lines spoken in that moment; `kind` is
  speech, shout, thought or caption; captions carry narration, speaker "narrator").
- Vary camera distance for rhythm; open scenes with an establishing wide shot.
- Keep dialogue short (under ~15 words per bubble); split long speeches across panels.

{_RULES}

Return only JSON matching the schema.""",
    "qa": """You are the quality gate for generated manga panels. For each panel listed in INPUT, look at the
image (path given; open it) and compare with the panel's `action`, its `cast` and their cast entries
(face, hair, outfit, palette), and the bubbles positions.

Mark `ok: false` with short, specific `issues` when you see: a character's identity, hair or outfit colors
drifting from the cast entry; wrong characters present or missing; the action not matching (who touches
whom, expression, pose); malformed hands or anatomy; text, letters or speech bubbles drawn into the art;
a bubble covering a face. Otherwise `ok: true` and `issues: []`. Failing panels get regenerated (up to 3
attempts), so only fail what a regeneration could fix or a human must fix.

Return only JSON: {"panels": {"<panel id>": {"ok": bool, "issues": [str]}}}.""",
}


class AwaitAgent(Exception):
    """Raised by the agent provider: park the stage until an MCP client submits the result."""

    def __init__(self, task: dict):
        super().__init__(task.get("stage"))
        self.task = task


class ProviderError(RuntimeError):
    pass


def _task(stage: str, input_: dict) -> dict:
    return {"stage": stage, "instructions": INSTRUCTIONS[stage], "input": input_, "schema": SCHEMAS[stage]}


# ---- agent ---------------------------------------------------------------


class AgentProvider:
    name = "agent"

    def analysis(self, source: str, ctx: dict) -> dict:
        raise AwaitAgent(_task("analysis", {"source": source, "title": ctx.get("title"), "format": ctx.get("format")}))

    def script(self, source: str, analysis: dict, ctx: dict) -> dict:
        raise AwaitAgent(_task("script", {"source": source, "analysis": analysis, "format": ctx.get("format")}))

    def qa(self, items: list[dict], ctx: dict) -> dict:
        raise AwaitAgent(_task("qa", {"panels": items, "cast": ctx.get("cast", {})}))


# ---- ollama --------------------------------------------------------------


class OllamaProvider:
    name = "ollama"

    def __init__(self, url: str, text_model: str, vision_model: str):
        self.url = url.rstrip("/")
        self.text_model = text_model
        self.vision_model = vision_model

    def _chat(self, model: str, system: str, user: str, schema: dict, images: list[str] | None = None) -> dict:
        msg = {"role": "user", "content": user}
        if images:
            msg["images"] = images
        body = {
            "model": model,
            "stream": False,
            "format": schema,
            "options": {"temperature": 0.4},
            "messages": [{"role": "system", "content": system}, msg],
        }
        try:
            r = httpx.post(f"{self.url}/api/chat", json=body, timeout=httpx.Timeout(600, connect=5))
        except httpx.ConnectError as e:
            raise ProviderError(f"Ollama isn't running at {self.url}. Start it with `ollama serve`.") from e
        except httpx.TimeoutException as e:
            raise ProviderError(f"Ollama ({model}) timed out.") from e
        if r.status_code == 404:
            raise ProviderError(f"Ollama has no model {model!r}. Pull it with `ollama pull {model}`.")
        if r.status_code >= 400:
            raise ProviderError(f"Ollama error {r.status_code}: {r.text[:300]}")
        content = r.json().get("message", {}).get("content", "")
        try:
            return json.loads(content)
        except ValueError as e:
            raise ProviderError(f"{model} returned invalid JSON: {content[:200]}") from e

    def _structured(self, stage: str, model: str, user: str, images=None) -> dict:
        last = None
        for _ in range(2):  # one retry with the validation error fed back
            out = self._chat(model, INSTRUCTIONS[stage], user if last is None else f"{user}\n\nYour previous answer was invalid: {last}. Fix it.", SCHEMAS[stage], images)
            try:
                validate(out, SCHEMAS[stage])
                return out
            except SchemaError as e:
                last = str(e)
        raise ProviderError(f"{model} could not produce a valid {stage}: {last}")

    def analysis(self, source: str, ctx: dict) -> dict:
        out = self._structured("analysis", self.text_model, f"TITLE: {ctx.get('title')}\n\nSOURCE ({len(source)} chars):\n{source}")
        return repair_spans(out, source, "beats")

    def script(self, source: str, analysis: dict, ctx: dict) -> dict:
        user = f"FORMAT: {json.dumps(ctx.get('format'))}\n\nANALYSIS:\n{json.dumps(analysis, indent=1)}\n\nSOURCE ({len(source)} chars):\n{source}"
        return self._structured("script", self.text_model, user)

    def qa(self, items: list[dict], ctx: dict) -> dict:
        panels = {}
        for it in items:
            img = _b64_image(it["image"])
            user = (
                "Check this one panel.\n" + json.dumps({k: it[k] for k in ("panel", "action", "cast", "bubbles") if k in it}, indent=1)
                + "\n\nCAST:\n" + json.dumps({c: ctx.get("cast", {}).get(c) for c in it.get("cast", [])}, indent=1)
                + f'\n\nAnswer as {{"panels": {{"{it["panel"]}": {{"ok": ..., "issues": [...]}}}}}}'
            )
            out = self._structured("qa", self.vision_model, user, images=[img])
            panels[it["panel"]] = out["panels"].get(it["panel"]) or next(iter(out["panels"].values()), {"ok": True, "issues": []})
        return {"panels": panels}


def _b64_image(path: str, max_side: int = 1024) -> str:
    from PIL import Image

    im = Image.open(path).convert("RGB")
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode()


# ---- heuristic -------------------------------------------------------------

_STOP = set(
    """The A An And But Or So Then When While After Before He She It They We You I His Her Its Their Our Your My
    This That These Those There Here What Who Why How Where Yes No Oh Ah Hey Well Not Now Just Still Even
    One Two Three Mr Mrs Ms Dr Sir Miss Okay OK Maybe Please Thanks Thank Sorry Good Morning Night Today
    Tomorrow Yesterday Once Every All Some Any As At In On Of To For From With By Into Onto If Because Though
    Although Meanwhile Suddenly Finally Later Soon Again Only Also Instead Outside Inside Behind Above Below
    Monday Tuesday Wednesday Thursday Friday Saturday Sunday God""".split()
)

_HAIR = [
    "short jet-black hair with a side part",
    "long chestnut-brown hair in a low ponytail",
    "messy ash-blond hair",
    "shoulder-length auburn-red hair with straight bangs",
    "short silver-grey hair, neatly combed",
    "long pastel periwinkle-blue hair to the waist",
]
_OUTFIT = [
    "navy-blue school blazer over a white collared shirt, grey trousers",
    "oversized moss-green hoodie, black jeans, white sneakers",
    "cream knit cardigan over a pale-yellow blouse, brown pleated skirt",
    "charcoal-grey wool coat, burgundy scarf, dark trousers",
    "white t-shirt under a faded denim jacket, khaki pants",
    "black turtleneck sweater, black slacks",
]
_EYES = ["dark brown eyes", "amber eyes", "grey-green eyes", "hazel eyes", "pale lilac-grey eyes", "deep blue eyes"]

_SENT = re.compile(r"[^.!?\n]+(?:[.!?]+[\"'”’)]*|$)")
_QUOTE = re.compile(r"[\"“]([^\"”]{1,300})[\"”]")
_PLACES = (
    "kitchen bakery cafe café shop store market street alley road bridge station platform train bus car classroom "
    "school hallway corridor rooftop roof office room bedroom bathroom living-room garden park forest woods beach "
    "sea harbor harbour river lake mountain village town city castle palace temple shrine church library hospital "
    "restaurant bar tavern inn hotel apartment house home yard field farm dojo gym arena stadium lab laboratory "
    "basement attic cave desert ship deck camp tent"
).split()
_LOC = re.compile(r"\b(?:in|at|inside|into|across|through|outside) (?:the|a|an|her|his|their|our) ((?:[a-z]+ )?[a-z]{3,})\b")


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "x"


def paragraphs(text: str) -> list[tuple[int, int]]:
    """Exact spans of blank-line separated paragraphs, trimmed of surrounding whitespace."""
    out = []
    for m in re.finditer(r"\S(?:.*?\S)?(?=\n\s*\n|\s*$)", text, flags=re.S):
        out.append((m.start(), m.end()))
    return out


def sentences(text: str, start: int, end: int) -> list[tuple[int, int]]:
    out = []
    for m in _SENT.finditer(text, start, end):
        s, e = m.start(), m.end()
        while s < e and text[s].isspace():
            s += 1
        while e > s and text[e - 1].isspace():
            e -= 1
        if e > s:
            out.append((s, e))
    return out


def repair_spans(analysis: dict, source: str, key: str) -> dict:
    """Clamp spans into the source and keep them ordered (LLMs are sloppy with offsets)."""
    n = len(source)
    for b in analysis.get(key, []):
        s, e = b["span"]
        s, e = max(0, min(n, int(s))), max(0, min(n, int(e)))
        b["span"] = [min(s, e), max(s, e)]
    return analysis


class HeuristicProvider:
    name = "heuristic"

    def analysis(self, source: str, ctx: dict) -> dict:
        words = re.findall(r"\b[A-Z][a-z]{1,15}\b", source)
        counts = Counter(w for w in words if w not in _STOP)
        names = [w for w, c in counts.most_common(6) if c >= 2] or [w for w, _ in counts.most_common(2)]
        cast = []
        for i, nm in enumerate(names):
            cast.append(
                {
                    "id": _slug(nm),
                    "name": nm,
                    "role": "main character" if i == 0 else "supporting character",
                    "face": f"young adult with {_EYES[i % len(_EYES)]} and a calm expression",
                    "hair": _HAIR[i % len(_HAIR)],
                    "outfit": _OUTFIT[i % len(_OUTFIT)],
                    "palette": "muted, low-saturation tones",
                }
            )
        low = source.lower()
        places = Counter(w for w in re.findall(r"[a-zé]+", low) if w in _PLACES)
        if not places:
            places = Counter(m.group(1) for m in _LOC.finditer(low))
        locs = []
        for place, _ in places.most_common(3):
            first = low.find(place)
            sent = next((source[s:e] for s, e in sentences(source, 0, len(source)) if s <= first < e), "")
            locs.append({"id": _slug(place), "name": place.title(), "description": f"The {place}. {sent.strip()} Soft natural light, uncluttered, drawn as an empty set."})
        if not locs:
            locs = [{"id": "main", "name": "Main setting", "description": "A simple everyday interior with soft daylight from a window, uncluttered."}]
        beats = []
        for i, (s, e) in enumerate(paragraphs(source), 1):
            sent = sentences(source, s, e)
            summary = source[sent[0][0] : sent[0][1]] if sent else source[s:e]
            beats.append({"id": f"b{i}", "summary": summary[:160], "span": [s, e]})
        return {"cast": cast, "locations": locs, "beats": beats}

    def script(self, source: str, analysis: dict, ctx: dict) -> dict:
        cast = analysis.get("cast", [])
        locs = analysis.get("locations", []) or [{"id": "main", "name": "Main setting"}]
        cameras = ["wide establishing shot", "medium shot", "close-up"]
        panels = []
        for beat in analysis.get("beats", []):
            bs, be = beat["span"]
            sents = sentences(source, bs, be) or [(bs, be)]
            per = 1 if len(sents) <= 2 else 2
            chunks = [sents[i : i + per] for i in range(0, len(sents), per)][:4]
            # make chunk spans contiguous so the whole beat is covered
            for ci, ch in enumerate(chunks):
                s = bs if ci == 0 else ch[0][0]
                e = chunks[ci + 1][0][0] if ci + 1 < len(chunks) else be
                text = source[s:e]
                present = [c["id"] for c in cast if re.search(rf"\b{re.escape(c['name'])}\b", text)]
                loc = next((l["id"] for l in locs if l["name"].lower() in text.lower()), None)
                loc = loc or (panels[-1]["location"] if panels else locs[0]["id"])
                dialogue = []
                for m in _QUOTE.finditer(text):
                    line = m.group(1).strip()
                    speaker = "narrator"
                    best = None
                    for c in cast:
                        for nm in re.finditer(rf"\b{re.escape(c['name'])}\b", text):
                            d = abs(nm.start() - m.start())
                            if best is None or d < best:
                                best, speaker = d, c["id"]
                    kind = "shout" if line.endswith("!") or line.isupper() else "speech"
                    dialogue.append({"speaker": speaker, "text": line, "kind": kind})
                action = _QUOTE.sub("", text)
                action = re.sub(r"\s+", " ", action).strip(" ,.")
                camera = cameras[len(panels) % 3] if ci else ("wide establishing shot" if not panels else cameras[len(panels) % 3])
                panels.append(
                    {
                        "id": f"p{len(panels) + 1:02d}",
                        "beat": beat["id"],
                        "span": [s, e],
                        "camera": camera,
                        "action": (f"{camera.capitalize()}. {action[:400]}." if action else f"{camera.capitalize()}."),
                        "cast": present,
                        "location": loc,
                        "dialogue": dialogue,
                    }
                )
        pages = [{"panels": panels[i : i + 4]} for i in range(0, len(panels), 4)] or [{"panels": []}]
        return {"pages": pages}

    def qa(self, items: list[dict], ctx: dict) -> dict:
        return {"panels": {it["panel"]: {"ok": True, "issues": []} for it in items}}


def make_provider(name: str, settings: dict | None = None):
    llm = (settings or {}).get("llm", {})
    if name == "agent":
        return AgentProvider()
    if name == "ollama":
        return OllamaProvider(llm.get("ollama_url", "http://127.0.0.1:11434"), llm.get("text_model", "qwen3:8b"), llm.get("vision_model", "qwen2.5vl:7b"))
    if name == "heuristic":
        return HeuristicProvider()
    raise ValueError(f"unknown provider {name!r} (agent | ollama | heuristic)")


def image_path(p: str | Path) -> str:
    return str(Path(p))
