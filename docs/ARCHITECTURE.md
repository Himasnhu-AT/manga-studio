# manga-studio v0.2 architecture

Local-first manga/webtoon studio. Three processes, all on this Mac:

```
 Tauri shell (app/src-tauri, Rust)      starts/stops the Python backend, hosts the webview
   └─ React UI (app/src, Vite + TS)     Library, Studio, Pipeline, Reader, Onboarding
 Python backend (studio/, FastAPI)      http://127.0.0.1:7860  — model worker, story files, pipeline
   └─ Qwen-Image-2.1 via mflux (MLX)    kept loaded in the worker thread
 MCP bridge (studio mcp, stdio)         Claude Code / Codex / any MCP client -> backend HTTP API
 Ollama (optional, :11434)              local LLM for pipeline stages when no agent is driving
```

The UI talks to the backend over HTTP (`VITE_API` or `http://127.0.0.1:7860`). The backend also
serves the built UI (`app/dist`) at `/`, so the app works in a plain browser too. Live refresh is
the existing SSE stream `/api/events` (an integer revision; refetch when it moves).

## Files on disk (source of truth)

```
stories/<slug>/story.yaml            everything the user/agent authors (below)
stories/<slug>/refs/                 reference images (uploads, cast refs)
stories/<slug>/out/<pid>/NNN-sSEED.png + .json   generated versions (unchanged from v0.1)
stories/<slug>/state.json            picks, stars, notes (unchanged)
stories/<slug>/source.md             pipeline source text (Mode B)
stories/<slug>/pipeline/             stage outputs: analysis.json, script.json, qa.json, state.json
stories/<slug>/source-coverage.json  char spans of source.md -> panel ids
stories/<slug>/final/                composed PNGs, strip, video, export/ (pdf, svg, png bundle)
.studio/settings.json                app settings (onboarding, LLM provider, agent) — gitignored
```

story.yaml is edited with ruamel round-trip (`studio/project.py`) so comments and key order
survive UI edits. Never hand-edit state.json while the server runs.

## story.yaml v0.2 (all new keys optional; v0.1 files still load)

```yaml
title: Cheek Squish
format:
  mode: page            # page | webtoon
  direction: rtl        # rtl | ltr (page mode reading order)
  page: {width: 1654, height: 2339}   # px at 200 dpi ~ B5-ish; webtoon uses width only
  gutter: 0.018         # fraction of page width
  margin: 0.06          # live-area margin, fraction of page width
cast:                   # structured characters; compiled to a block with the same id
  kai:
    name: Kai
    role: the father
    face: young man, pale lilac-grey eyes, small black stud earring
    hair: messy layered silver-white hair that partly covers his eyes
    outfit: oversized plain black long-sleeve crewneck sweater, black pants
    palette: black, silver-white, lilac-grey
    notes: ""
    refs: [family-ref.png]     # files in refs/
    sheet: sheet               # panel id of their reference sheet (optional)
    seed: 10308                # identity seed used by Copilot when none given
blocks: {style: ..., setting: ...}  # verbatim text; if blocks[<cast id>] exists it wins over compiled cast
avoid: "..."
pages:                  # page mode layout; boxes are fractions of the live area
  - id: pg1
    panels:
      - {panel: p01, box: [0, 0, 1, 0.32]}
      - {panel: p02, box: [0, 0.34, 0.49, 0.3], poly: [[0,0],[1,0],[1,0.85],[0,1]]}  # poly: optional, fractions of the box
panels:
  - id: p01
    title: Squish
    refs: [sheet, room]
    use: [style, kai, daughter, setting]
    cast: [kai, daughter]        # optional: injects their blocks (if not in use) + sheet/refs
    action: ...
    seed: 42
    strength: 1.0
    crop: {x: 0.5, y: 0.5, scale: 1.0}   # art framing inside the panel box
    layers:
      background: {visible: true, color: "#ffffff"}
      art: {visible: true}
      fx: {visible: true, items: [{type: screentone, density: 0.5, opacity: 0.25, angle: 45}]}   # screentone | speedlines | focuslines
      lettering: {visible: true}
    protect: [[0.3, 0.2, 0.25, 0.25]]   # face / no-bubble boxes [x,y,w,h] fractions of panel
    bubbles:
      - {id: b1, text: "Hi!", at: [0.7, 0.1], w: 0.4, tail: [0.62, 0.3], style: speech, size: 1.0, vertical: false}
    sfx:
      - {text: "#", at: [0.2, 0.08], size: 1.5, rotate: -10}
```

Prompt order is unchanged (refs line, `use` blocks, action, avoid). `cast:` adds each member's
block (compiled `"{name}, {role}: {face}. Hair: {hair}. Outfit: {outfit}. Palette: {palette}."`)
unless already in `use`, and adds their `sheet` panel (or first ref) to refs if not present, max 10.

## HTTP API (JSON). v0.1 endpoints stay as they are.

v0.1: `GET /api/status`, `GET /api/stories`, `GET /api/stories/{slug}`, `POST /api/generate`,
`GET|DELETE /api/jobs[/{id}]`, `POST /api/stories/{slug}/{pick,star,notes,notes/done,compose}`,
`GET /files/{slug}/{path}`, `GET /api/events`.

`GET /api/stories/{slug}` gains: `format`, `cast`, `blocks`, `avoid`, `pages`, `has_source`,
`pipeline` (summary: `{stages:[{id,status}]}` or null). Each panel already carries every yaml key.

### Projects + editing
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/projects | `{title, slug?, mode, direction, template: blank\|sample}` | `{slug}` |
| PATCH | /api/stories/{slug} | any of `{title, notes, format, blocks, avoid}` | `{ok}` |
| POST | /api/stories/{slug}/panels | `{id?, title?, after?, page?}` | `{id}` |
| PATCH | /api/stories/{slug}/panels/{pid} | any panel key (`action, refs, use, cast, bubbles, sfx, layers, crop, protect, title, seed, strength, strip`) | `{ok}` |
| DELETE | /api/stories/{slug}/panels/{pid} | | `{ok}` |
| PUT | /api/stories/{slug}/pages | `{pages: [...]}` | `{ok}` |
| POST | /api/stories/{slug}/pages/auto | `{per_page?: 4}` | `{pages}` |
| PUT | /api/stories/{slug}/cast/{cid} | cast entry | `{ok}` |
| DELETE | /api/stories/{slug}/cast/{cid} | | `{ok}` |
| POST | /api/stories/{slug}/refs | multipart `file` | `{name}` |
| POST | /api/stories/{slug}/panels/{pid}/copilot | `{mode: txt2img\|img2img\|inpaint, prompt?, source?, mask?, strength?, count?}` | `{jobs, seeds}` |
| POST | /api/stories/{slug}/letter | `{panels?: [pid], overwrite?: false}` | `{placed: {pid: n}}` |
| POST | /api/stories/{slug}/export | `{formats: [png, svg, pdf], preset: digital\|print-b5\|print-a5, bleed_mm?, margin_mm?}` | `{files: [rel paths]}` |

Copilot: `txt2img` = normal generation with cast refs injected. `img2img` = the panel's picked
version (or `source`) placed first in refs at `strength` (default 0.6). `inpaint` = img2img, then
only the masked region (PNG data URL, white = change) is blended back over the source; output
saved as a new version.

### App: system, settings, models, integrations
| Method | Path | Returns |
|---|---|---|
| GET | /api/system | `{platform, arch, apple_silicon, ram_gb, disk_free_gb, python, ffmpeg, engine}` |
| GET/PUT | /api/settings | `{onboarded, agent: claude\|codex\|ollama\|none, llm: {provider: agent\|ollama\|heuristic, ollama_url, text_model, vision_model}, image: {model, quantize}}` |
| GET | /api/models | `[{id, repo, approx_gb, cached, cached_bytes, downloading, progress: {done_bytes, total_bytes}, error}]` |
| POST | /api/models/{id}/download | `{ok}` (poll GET /api/models) |
| GET | /api/integrations | `{claude: {installed, connected}, codex: {installed, connected}, ollama: {installed, running, models: []}, mcp: {command: [...], json: {...}}}` |
| POST | /api/integrations/{claude\|codex}/connect | `{ok, command, output}` |

### Pipeline (Mode B)
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/pipeline/new | `{title, text, mode, direction, provider?}` | `{slug}` (creates project + source.md) |
| PUT | /api/stories/{slug}/source | `{text}` | `{ok}` |
| GET | /api/stories/{slug}/source | | `{text}` |
| GET | /api/stories/{slug}/pipeline | | `PipelineState` |
| POST | /api/stories/{slug}/pipeline/run | `{from?: stage, to?: stage, provider?}` | `PipelineState` |
| POST | /api/stories/{slug}/pipeline/cancel | | `{ok}` |
| GET | /api/stories/{slug}/pipeline/task | | `{stage, instructions, input, schema} \| null` |
| POST | /api/stories/{slug}/pipeline/submit | `{stage, result}` | `PipelineState` |
| PUT | /api/stories/{slug}/pipeline/stages/{stage} | `{output}` (manual override) | `PipelineState` |
| GET | /api/stories/{slug}/coverage | | `{length, spans: [{start, end, panels: []}], covered_ratio, gaps: [{start,end}]}` |

Stages: `analysis`, `script`, `layout`, `artwork`, `lettering`, `qa`.

```ts
type StageStatus = "idle" | "running" | "awaiting_agent" | "done" | "error" | "flagged";
type PipelineState = {
  provider: "agent" | "ollama" | "heuristic";
  running: boolean;
  stages: { id: string; name: string; status: StageStatus; detail?: string;
            progress?: { done: number; total: number }; updated?: string; output?: any }[];
  task?: { stage: string; instructions: string } | null;   // when awaiting_agent
  qa?: { panels: Record<string, { ok: boolean; issues: string[]; attempts: number; flagged: boolean }> };
};
```

Providers for the LLM stages (analysis, script, qa):
- `agent`: stage goes `awaiting_agent`; an MCP client fetches `pipeline/task`, does the work
  (it can look at images), and posts `pipeline/submit`. This is how Claude Code / Codex drive it.
- `ollama`: backend calls `{ollama_url}/api/chat` with `format: <json schema>` (text_model; QA uses vision_model with images).
- `heuristic`: no LLM (paragraph/sentence split, quoted dialogue extraction, geometric QA only).

Layout (3) and lettering (5) are algorithmic. Artwork (4) queues jobs on the worker. QA (6) runs
the geometric bubble-overlap check always, plus the vision check via provider; failing panels
regenerate up to 3 times, then are `flagged` for a manual fix in Studio.

## MCP bridge (`uv run studio mcp`)

stdio server (python `mcp` FastMCP) that proxies to the HTTP API. Tools: `list_projects`,
`get_project`, `create_project`, `update_panel`, `add_panel`, `set_cast`, `prompt_preview`,
`generate` (optional wait), `view_image` (returns the PNG so the agent can look), `get_feedback`,
`resolve_note`, `pick_version`, `auto_letter`, `export`, `pipeline_new`, `pipeline_status`,
`pipeline_run`, `pipeline_task`, `pipeline_submit`.

Register: `claude mcp add manga-studio -- uv --directory <repo> run studio mcp`
(Codex: `codex mcp add manga-studio -- uv --directory <repo> run studio mcp`).
