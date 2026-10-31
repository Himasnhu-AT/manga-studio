# manga-studio v0.2 architecture

Local-first manga/webtoon studio. Three processes, all on this Mac:

```
 Tauri shell (app/src-tauri, Rust)      starts/stops the Python backend, hosts the webview
   └─ React UI (app/src, Vite + TS)     Library, Studio, Pipeline, Reader, Onboarding
 Python backend (studio/, FastAPI)      http://127.0.0.1:7860: model worker, story files, pipeline
   └─ Qwen-Image-2.1 via mflux (MLX)    kept loaded in the worker thread
 MCP bridge (studio mcp, stdio)         Claude Code / Codex / any MCP client -> backend HTTP API
 Ollama (optional, :11434)              local LLM for pipeline stages when no agent is driving
```

The UI talks to the backend over HTTP (`VITE_API` or `http://127.0.0.1:7860`). The backend also
serves the built UI (`app/dist`) at `/` (assets under `/assets/`), so the app works in a plain browser
too; the v0.1 dashboard moved to `/legacy`. Live refresh is
the existing SSE stream `/api/events` (an integer revision; refetch when it moves).

## Files on disk (source of truth)

```
stories/<slug>/story.yaml            everything the user/agent authors (below)
stories/<slug>/refs/                 reference images (uploads, cast refs)
stories/<slug>/out/<pid>/NNN-sSEED.png + .json   generated and edited versions (an edit's .json has edited_from + ops)
stories/<slug>/out/<pid>/masks/      mask PNGs referenced by recorded edit ops (not versions)
stories/<slug>/state.json            picks, stars, notes (unchanged)
stories/<slug>/source.md             pipeline source text (Mode B)
stories/<slug>/pipeline/             stage outputs: analysis.json, script.json, qa.json, state.json
stories/<slug>/source-coverage.json  char spans of source.md -> panel ids
stories/<slug>/final/                composed PNGs, strip, video, export/ (pdf, svg, png bundle)
.studio/settings.json                app settings (onboarding, LLM provider, agent); gitignored, STUDIO_SETTINGS overrides
.studio/backend.log                  backend output when the Tauri shell started it
```

Those are checkout paths. The installed app (a downloaded `.app`) keeps the same story layout but
moves everything out of its read-only, code-signed bundle (see "Desktop shell" below):

```
~/Manga Studio/stories/<slug>/                          stories (seeded with cheek-squish on first launch)
~/Library/Application Support/Manga Studio/settings.json app settings
~/Library/Application Support/Manga Studio/backend.log   backend output
~/Library/Application Support/Manga Studio/venv/         the backend's Python environment (uv)
~/Library/Application Support/Manga Studio/pycache/      Python bytecode (PYTHONPYCACHEPREFIX)
~/Library/Application Support/Manga Studio/bin/manga-studio-mcp   MCP launcher, rewritten every launch
```

## Desktop shell (`app/src-tauri/src/lib.rs`)

On launch the shell reuses a backend already listening on 127.0.0.1:7860 or spawns one (its own
process group; stopped on quit only if it spawned it). It picks one of two layouts:

- **Dev** (debug build, `MANGA_STUDIO_ROOT` set, or a release binary outside a `.app` whose source
  checkout exists): `uv run studio serve --port 7860` in the repo. Settings, log and stories as in a
  checkout.
- **Installed** (binary inside `<App>.app/Contents/MacOS`): the backend ships as Tauri resources in
  `Contents/Resources/backend/` (`pyproject.toml`, `uv.lock`, `studio/**/*.py`, `templates/`,
  `dashboard/`, `fonts/`, `stories/cheek-squish/{story.yaml,refs/}`; listed in
  `tauri.conf.json` `bundle.resources`). It runs
  `uv run --frozen --project <Resources>/backend studio serve --port 7860` from the data folder with
  `UV_PROJECT_ENVIRONMENT`, `STUDIO_STORIES`, `STUDIO_HOME`, `STUDIO_SETTINGS`,
  `PYTHONPYCACHEPREFIX` and `STUDIO_MCP_LAUNCHER` set to the user paths above, so nothing is
  written inside the bundle. The first launch creates the venv (`uv sync`, a minute or two; the
  UI says so). If uv is missing the banner and the onboarding "This Mac" step show
  `curl -LsSf https://astral.sh/uv/install.sh | sh` and a Restart button.

Both modes append the usual install dirs (`~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`) to the backend's PATH, since GUI apps start with a minimal one. First run
(onboarding window vs main window) is decided by `onboarded` in the same settings file the backend
uses in that mode.

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
| PATCH | /api/stories/{slug}/panels/{pid} | any panel key (`action, refs, use, cast, bubbles, sfx, layers, crop, protect, title, seed, strength, strip, width, height, ref_label, avoid, steps, output_resolution`, plus pipeline keys `camera, source_span, beat, location`); `null` deletes a key | `{ok}` |
| DELETE | /api/stories/{slug}/panels/{pid} | | `{ok}` |
| PUT | /api/stories/{slug}/panels/order | `{order: [ids]}` (every panel id exactly once) | `{ok, order}` |
| PUT | /api/stories/{slug}/pages | `{pages: [...]}` | `{ok}` |
| POST | /api/stories/{slug}/pages/auto | `{per_page?: 4}` | `{pages}` |
| PUT | /api/stories/{slug}/cast/{cid} | cast entry | `{ok}` |
| DELETE | /api/stories/{slug}/cast/{cid} | | `{ok}` |
| POST | /api/stories/{slug}/refs | multipart `file` | `{name}` |
| POST | /api/stories/{slug}/panels/{pid}/copilot | `{mode: txt2img\|img2img\|inpaint, prompt?, source?, mask?, strength?, count?}` | `{jobs, seeds}` |
| POST | /api/stories/{slug}/panels/{pid}/segment | `{point: [x, y], file?, method?: auto\|vision\|color, tolerance?: 0.12, ops?}` | `{file, mask (PNG data URL), method, instance, instances: [{index, bbox, area}], area, size, vision}` |
| POST | /api/stories/{slug}/panels/{pid}/edit | `{ops: [...], file?, preview?: false}` | `{file (new version or null), source, edited_from, jobs, seeds, size}`; preview: `{image, size, holes}` |
| POST | /api/stories/{slug}/letter | `{panels?: [pid], overwrite?: false}` | `{placed: {pid: n}}` |
| POST | /api/stories/{slug}/export | `{formats: [png, svg, pdf], preset: digital\|print-b5\|print-a5, bleed_mm?, margin_mm?}` | `{files: [rel paths]}` |

Copilot: `txt2img` = normal generation with cast refs injected. `img2img` = the panel's picked
version (or `source`) placed first in refs at `strength` (default 0.6). `inpaint` = img2img, then
only the masked region (PNG data URL, white = change) is blended back over the source; output
saved as a new version.

### Image editing (`studio/imageedit.py`, `studio/segment.py`)

Edits are non-destructive. `edit` applies `ops` to a version (`file`, default the one in use) and saves
the result as a NEW version in `out/<pid>/` whose `.json` has `edited_from` and the recorded ops (inline
PNG masks are saved to `out/<pid>/masks/` and referenced as `{"png": "masks/..."}`, so the list replays
exactly). The app previews with `preview: true` and sends the same ops on Apply; agents send them through
MCP `edit_image`. Pixel work is PIL + numpy (+ OpenCV Telea inpaint, already a dependency of mflux) in
the backend, so the result is the same whoever applied it. Coordinates are fractions of the image as it
is when the op runs.

| op | fields | |
|---|---|---|
| `mask` | `id`, one of `png` (data URL or `masks/` file), `point` (segment), `rect` [x,y,w,h], `poly`; `mode` replace\|add\|subtract\|intersect; `grow` px | named masks follow later crop/rotate/flip |
| `move` | `mask`, `dx`, `dy`, `scale`, `rotate` (deg, clockwise), `flip` h\|v, `fill` local\|none\|model | consecutive moves are one rearrangement: all lifted from the same image, holes filled once, pasted in list order (later = on top) |
| `erase` | `mask`, `fill` local\|model\|white | `model` also repaints the hole with an inpaint job |
| `crop` | `box` [x,y,w,h] | |
| `rotate` | `deg` (multiple of 90, clockwise) | |
| `flip` | `axis` h\|v, `mask`? | with a mask: flips the selection in place |
| `adjust` | `brightness`, `contrast`, `saturation` (multipliers, 1 = same), `mask`? | |
| `extend` | `side` up\|down\|left\|right, `amount` (0.2 = 20%), `prompt`?, `count`? | pads (size rounded to 16), then inpaints the new strip |
| `fix` | `prompt`, `mask`?, `strength` (0.4 subtle, 0.6 medium, 0.85 redraw), `count` (2), `grow` | last op only. With a mask: inpaint that region (grown ~1.5%); without: img2img of the whole image |
| `redraw` | `prompt`?, `strength` (0.85) | whole-image img2img |

Model work goes through the shared worker queue (`queue_from_source`, also used by copilot): the
edited image is image 1, the panel's blocks, cast and refs ride along, the render size follows the
source's aspect, and each candidate lands as a new version whose `.json` records `edited_from`, `op`,
`fix` (the prompt), `strength` and `mask` (bbox + area). Picking a candidate is a normal pick.

Segment: Apple Vision `VNGenerateForegroundInstanceMaskRequest` (macOS 14+, pyobjc, no download, ~0.2 s,
label map cached per image); the instance under the click is returned. Off macOS, on error, or on
background, it falls back to a colour flood fill (`tolerance` 0..1). The app composes results into its
selection with shift (add) and alt (subtract) and refines with lasso and brush.

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
| POST | /api/pipeline/new | `{title, text, mode, direction, provider?, autostart?: true}` | `{slug}` (creates project + source.md, starts the run unless `autostart: false`) |
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

stdio server built on mcp 2.3's `MCPServer` (FastMCP no longer exists there) that proxies to the HTTP
API at `STUDIO_URL` (default http://127.0.0.1:7860). The workflow and consistency rules ship in the
server instructions. 26 tools: `list_projects`, `get_project`, `create_project`, `update_story`,
`update_panel`, `add_panel`, `set_cast`, `prompt_preview`, `generate` (waits by default),
`copilot`, `segment`, `edit_image` (same op JSON as `/edit`; waits for fix/extend candidates), `view_image` (returns the picture, max 1024 px JPEG, so the agent can look), `jobs`,
`get_feedback`, `resolve_note`, `pick_version`, `auto_letter`, `export`, `pipeline_new`,
`pipeline_status`, `pipeline_run`, `pipeline_task`, `pipeline_submit`. When the backend isn't
running, tools fail with a message telling the agent to open the app or run `uv run studio serve`.

Register: `claude mcp add --scope user manga-studio -- manga-studio-mcp` (Codex: `codex mcp add manga-studio -- manga-studio-mcp`). The app's Connect button runs exactly this, and
replaces an older registration that pointed at a path.
`manga-studio-mcp` is a launcher in `~/.local/bin` (on PATH wherever uv is installed), written by
Connect or `uv run studio mcp-install`. It never puts a path in the agent's config:
- in a checkout it runs `uv --directory <repo> run studio mcp`;
- in the installed app it hands off to the app's own launcher in
  `~/Library/Application Support/Manga Studio/bin/`, which sets the data env and runs
  `uv run --frozen --project <Resources>/backend studio mcp`. That one is rewritten on every launch,
  so moving or updating the app keeps the registration working.
`/api/integrations` returns the exact shell-quoted commands as `mcp.add.claude` / `mcp.add.codex`.

## Environment variables

| Name | Default | What |
|---|---|---|
| `STUDIO_URL` | http://127.0.0.1:7860 | backend URL for the CLI and the MCP bridge (and the Vite dev proxy) |
| `STUDIO_ENGINE` | `mflux` | `mock` draws placeholders instead of loading the model (`serve --mock`) |
| `STUDIO_STORIES` | `<repo>/stories` | stories directory (tests and QA point it at a scratch copy) |
| `STUDIO_HOME` | `<repo>/.studio` | app state folder (settings live here unless `STUDIO_SETTINGS` says otherwise) |
| `STUDIO_SETTINGS` | `$STUDIO_HOME/settings.json` | app settings file |
| `STUDIO_APP_DIST` | `<repo>/app/dist` | built UI served at `/` (falls back to the v0.1 dashboard) |
| `STUDIO_MCP_LAUNCHER` | unset | MCP command the app registers with agents (set by the installed app) |
| `STUDIO_MLX_CACHE_GB` | 2 | cap on MLX's buffer cache |
| `MANGA_STUDIO_ROOT` | the checkout the app was built from | repo the Tauri shell runs the backend in (forces dev mode) |
| `UV_PROJECT_ENVIRONMENT`, `PYTHONPYCACHEPREFIX` | uv / Python defaults | set by the installed app so the venv and bytecode live outside the bundle |
| `VITE_API` | http://127.0.0.1:7860 | backend URL baked into a Tauri production build |
