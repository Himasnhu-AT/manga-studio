# manga-studio: how Claude drives it

The user directs a manga/webtoon story; **Claude writes prompts and runs generations; the user
looks at results in the Manga Studio app** (desktop app, or http://127.0.0.1:7860 in a browser)
and leaves picks, stars and notes there. The user may also be editing in the app while you work.

Model: Qwen-Image-2.1 (Turbo by default) running locally on Apple Silicon through mflux, kept
loaded inside `studio serve`. Up to 10 reference images per generation.

## The pieces

| What | Where | Run |
|---|---|---|
| Desktop app (Tauri + Vite + React) | `app/` | `cd app && pnpm tauri dev` (starts the backend if it isn't running) |
| Backend: FastAPI + model worker + pipeline | `studio/` | `uv run studio serve` (`--mock` = placeholder images, no model) |
| MCP bridge for agents | `studio/mcp_server.py` | `uv run studio mcp` (stdio; proxies the backend HTTP API) |
| Contract: story.yaml v0.2, HTTP API, MCP tools | `docs/ARCHITECTURE.md` | |

`pnpm` only for the app (never npm/yarn). Browser-only UI: `cd app && pnpm build`, then
`studio serve` serves it at `/`; the v0.1 dashboard lives at `/legacy`.

## Commands (run from this directory)

```bash
uv run studio serve                 # backend + worker; keep it running (background). --mock = no model
uv run studio show <story>          # panels, versions, which version is used, broken refs, open notes
uv run studio prompt <story> <pid>  # exact prompt + reference images a panel will send (dry run)
uv run studio gen <story> <pid>... [-n 4] [--seed 42] --wait   # queue + wait; prints output paths
uv run studio feedback <story>      # the user's notes, picks, stars  <- read this every turn
uv run studio resolve <story> <n> --reply "what I changed"     # close a note (reply shows in the app)
uv run studio pick <story> <pid> <file>     # choose the version used as ref + in the strip
uv run studio compose <story>       # draw bubbles/sfx on picked panels -> final/<pid>.png + final/strip.png
uv run studio video <story> [--audio file]  # composed panels -> final/<story>.mp4 (zoom + crossfades)
uv run studio new <slug> --title "..."      # scaffold a story from templates/story.yaml
uv run studio pipeline <slug> [run|status|task|cancel]  # Mode B pipeline (see below)
```

If `gen` says the server isn't running, start `uv run studio serve` in the background (don't
use memgate). If the desktop app is open, it already runs one. The first job loads the model
(about 1 to 2 min); later jobs reuse it.

## MCP or CLI

When `manga-studio` MCP tools are available (registered with
`claude mcp add manga-studio -- uv --directory <repo> run studio mcp`), prefer them: they go through
the same running backend the app uses, and `view_image` hands you the picture directly. Tools:
`list_projects`, `get_project`, `create_project`, `update_story`, `update_panel`, `add_panel`,
`set_cast`, `prompt_preview`, `generate`, `copilot`, `segment`, `edit_image`, `view_image`, `jobs`, `get_feedback`,
`resolve_note`, `pick_version`, `auto_letter`, `export`, `pipeline_new`, `pipeline_status`,
`pipeline_run`, `pipeline_task`, `pipeline_submit`.

Use the CLI (and Read on PNG paths) when MCP isn't connected, for `video`/`compose`, or when you need
to edit story.yaml text by hand (long folded actions, comments).

## Working alongside the user

- UI edits (bubbles dragged, actions typed, cast saved) write `story.yaml` immediately through a
  round-trip writer that keeps comments. **Re-read story.yaml right before you edit it**, and edit
  only the lines you mean to change.
- Your story.yaml edits show up in the app live (the backend watches the file).
- Never hand-edit `state.json` or `pipeline/state.json` while the server runs; use the CLI/MCP/API.

## The loop

1. `studio feedback <story>` (or `get_feedback`) → what the user asked for, picks, stars.
2. Edit `stories/<story>/story.yaml` (blocks, cast, panel `action`, refs, bubbles), or `update_panel`.
3. `studio prompt` / `prompt_preview` to sanity-check, then `studio gen ... --wait` / `generate`.
4. **Look at the outputs yourself** (Read the printed PNG paths, or `view_image`) and compare against
   the refs. Regenerate if identity/outfit/colors drifted, before telling the user it's ready.
5. `studio resolve` / `resolve_note` the notes you handled, with a one-line reply.

Picks are the user's call. Only `studio pick` yourself when the user asks, or for a
reference panel (`sheet`, `room`, plates) while the user is away and you said which one you chose.

## Pipeline (Mode B: story text to lettered pages)

Six stages: `analysis`, `script`, `layout`, `artwork`, `lettering`, `qa`. Layout, artwork and
lettering are automatic. Analysis, script and QA use the project's provider: `heuristic` (no LLM),
`ollama` (local), or `agent` (you).

With the `agent` provider a stage parks as `awaiting_agent`. Then:
1. `studio pipeline <slug> task` (or `pipeline_task`) → `{stage, instructions, input, schema}`.
2. Do exactly what the instructions say (QA: look at each panel image). Keep every source span covered.
3. Submit the JSON (`pipeline_submit`, or `POST /api/stories/<slug>/pipeline/submit`). Invalid JSON
   gets a 400 with the reason; fix and resubmit. The run continues on its own.
4. Repeat until `studio pipeline <slug> status` shows every stage done. Flagged QA panels need a
   manual fix in Studio (or a copilot pass).

## Consistency rules (why the story.yaml is shaped this way)

- **Star topology, not a chain.** Every story panel's refs are the same anchors (`sheet`, `room`),
  never "the previous panel". Chaining compounds drift (that's what broke the first attempt:
  dad's black sweater became a white shirt by panel 3 and stayed wrong).
- **Verbatim blocks.** Character/style/setting text lives once in `blocks:` or `cast:`; panels list
  them in `use:` / `cast:`. Don't paraphrase a character inside `action`; change the block or cast entry.
- **Exact color words.** "pastel periwinkle-blue", never just "blue" (the model read "blue" as navy).
- **Name the outfit every time.** Clothes are what the model changes first.
- **No text in images.** The style block says no text/bubbles; dialogue goes in `bubbles:` and is
  drawn as vectors on top (app, `compose`, export). Re-rendering text makes the model redraw everything.
- **`avoid:` instead of a negative prompt.** Turbo runs at guidance 1, where negative prompts do
  nothing, so it's appended to the prompt as "Avoid: ...".
- **Prompt refers to refs by position**: the prompt starts "Image 1: <label>. Image 2: <label>."
  generated from each ref's `label`/`ref_label`. Mention "image 1"/"image 2" in actions when useful.
- Fix part of an image ("show her legs", "fix the left hand"): `edit_image` with
  `[{op: mask, id: m, point: [x, y]}, {op: fix, prompt, mask: m}]` (inpaint) or just `{op: fix, prompt}`
  (img2img, strength 0.4/0.6/0.85). Out of frame: `{op: extend, side: down, amount: 0.2, prompt}`.
  Rearrange/erase/crop/flip/adjust are pixel ops on the same call; every edit is a new version with
  `edited_from` in its .json. In the app: Edit image mode (`/` or Cmd+K for the command bar).
- Small tweak on an existing image (expression, a prop): put that image first in `refs` and set
  `strength: 0.6` (the first ref is the source; lower = closer to it), or `copilot` img2img.
  Big pose changes → 1.0.

## story.yaml cheat sheet

```yaml
defaults: {model: qwen-image-2.1-turbo, quantize: 4, width: 864, height: 1152}  # 3:4, multiples of 32
format: {mode: page, direction: rtl, page: {width: 1654, height: 2339}, gutter: 0.018, margin: 0.06}  # mode: page|webtoon
refs:                       # files in stories/<slug>/refs/ + label used in the prompt
  family-ref.png: {label: "style and character reference - ..."}
cast:                       # structured characters, compiled into a block with the same id
  kai: {name: Kai, role: the father, face: ..., hair: ..., outfit: ..., palette: ..., refs: [family-ref.png], sheet: sheet, seed: 10308}
blocks: {style: ..., setting: ...}   # blocks[<cast id>] if present wins over the compiled cast text
avoid: "t-shirt, navy hair, any text"
pages:                      # page mode layout; boxes are fractions of the live area
  - {id: pg1, panels: [{panel: p01, box: [0, 0, 1, 0.32]}, {panel: p02, box: [0, 0.34, 0.49, 0.3], poly: [[0,0],[1,0],[1,0.85],[0,1]]}]}
panels:
  - id: sheet               # reference panel: strip: false, other panels use it via refs: [sheet]
    strip: false
    ref_label: character reference sheet
  - id: p01
    refs: [sheet, room]     # panel id (uses its picked/newest version) or a refs/ filename; max 10
    use: [style, setting]
    cast: [kai]             # adds kai's block (if not in use) and kai's sheet to refs
    action: what happens
    seed: 42                # optional fixed seed
    strength: 1.0           # optional
    crop: {x: 0.5, y: 0.5, scale: 1.0}      # art framing inside a page slot
    layers: {fx: {items: [{type: screentone, density: 0.5, opacity: 0.25, angle: 45}]}}  # screentone|speedlines|focuslines
    protect: [[0.3, 0.2, 0.25, 0.25]]       # faces: auto-lettering keeps bubbles off these boxes
    bubbles:                # coordinates are fractions of the panel
      - {id: b1, text: "Hi!", at: [0.7, 0.1], w: 0.4, tail: [0.62, 0.3], style: speech, vertical: false}   # speech|shout|thought|caption
    sfx:
      - {text: "#", at: [0.2, 0.08], size: 1.5, rotate: -10}
```

Outputs: `stories/<slug>/out/<pid>/NNN-s<seed>.png` + `.json` (full prompt, refs and versions used,
seconds). Picks, stars, notes: `stories/<slug>/state.json`. Pipeline: `source.md`, `pipeline/`,
`source-coverage.json`. Exports: `final/export/`. App settings: `.studio/settings.json`.

## Memory on this Mac (24 GB)

Turbo + `quantize: 4` is the setting that fits. Base model (40 steps) at q4 is ~5× slower; try it for
finals only. If a job dies or the Mac swaps hard, drop size to 768×1024 or close other apps.
`STUDIO_MLX_CACHE_GB` (default 2) caps MLX's buffer cache.
