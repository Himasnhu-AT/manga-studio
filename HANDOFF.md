# Handoff: manga-studio (state as of 2026-10-30, evening)

Read `CLAUDE.md` first: it's the operating manual (commands, MCP tools, the loop, consistency
rules). `docs/ARCHITECTURE.md` is the contract (story.yaml v0.2, HTTP API, MCP). This file covers
what has been done and what's left.

## What this project is

A local manga/webtoon studio. The user writes or pastes a story; **Qwen-Image-2.1** draws the panels
on their Mac; vector bubbles letter them; they read and export the result. Claude (or Codex, or a
local Ollama model) drives it through the `studio` CLI or the MCP bridge; the user works in the app.

- Self-hosted on purpose, to keep cost down: Apple M5 Pro, 24 GB RAM, model via **mflux 0.24.0** (MLX).
- Default: `qwen-image-2.1-turbo`, 4-bit, 8 steps, 864x1152. About **60-100 s per image**, **7.4 GB peak**.
- The Turbo weights are already in the Hugging Face cache; onboarding detects that and skips the download.

**v0.1 (Oct 27-29):** Python CLI + FastAPI server + single-file dashboard; sample story done end to end.
**v0.2 (Oct 30):** migration to a Tauri + Vite + React desktop app over the same Python backend, with:
- Mode A, Studio: page layouts (RTL/LTR, templates, draggable gutters, diagonal slices) or a webtoon
  scroll; per-panel layers (background, art, tone/FX, SVG lettering); a lettering editor (drag bubbles
  and tails 1:1, inline text, vertical text); Cast studio; Inspector; panel Copilot (txt2img, img2img,
  masked inpaint) that injects the cast's reference sheets.
- Mode B, Pipeline: six stages (analysis, script, layout, artwork, lettering, QA gate with up to 3
  regenerations then a flag), source coverage tracker, manual overrides; providers agent / ollama /
  heuristic. Results open in Studio.
- Reader (paged spreads in reading order, continuous scroll) and export (print PDF with bleed,
  layered SVG, PNG pages, webtoon slices).
- Onboarding: Mac check, model cache/download, connect Claude Code / Codex / Ollama, first project.
- MCP bridge `studio mcp` (24 tools) so agents drive the same backend the app uses.

## Run it

```bash
uv sync && (cd app && pnpm install)
cd app && pnpm tauri dev          # desktop app; starts `uv run studio serve` if nothing is on :7860
uv run studio serve --mock        # backend with placeholder images (UI work without the model)
uv run pytest -q tests/           # backend tests (mock engine, scratch stories dir)
```

## Layout

| Path | What |
|---|---|
| `app/src-tauri/` | Tauri shell: spawns/stops the backend it owns, `backend_status`/`restart_backend` commands, log at `.studio/backend.log` |
| `app/src/App.tsx`, `lib/`, `ui/` | shell, typed API client (`lib/api.ts`), live SSE hook (`lib/live.ts`), store, design kit, shared `PanelView` renderer, bubble geometry (`lib/geometry.ts`, mirrors compose.py) |
| `app/src/views/studio/` | Studio: canvas, rail, toolbar, lettering editor, inspector, copilot, versions, cast studio |
| `app/src/views/` | Library, Pipeline, Reader, Settings, Onboarding, NewProject, ExportSheet |
| `studio/story.py` | story.yaml loading, cast compile/injection, prompt building, versions, state.json |
| `studio/project.py` | round-trip story.yaml writes (ruamel; keeps comments and hand-wrapped lines) |
| `studio/server.py` | FastAPI: v0.1 endpoints + editing, copilot, lettering, export, app endpoints; serves `app/dist` |
| `studio/engine.py` | `MfluxEngine` (keeps the model loaded), `MockEngine` (`STUDIO_ENGINE=mock`) |
| `studio/compose.py` | PIL compositor: layers, crop, bubbles (incl. vertical), sfx; `bubble_geometry()` is the single source of bubble shape |
| `studio/lettering.py` | auto-lettering in low-detail areas away from `protect` boxes; overlap checks |
| `studio/export.py` | pages/webtoon render, PDF, layered SVG, PNG; `auto_pages()` |
| `studio/appsvc.py` | settings (`.studio/settings.json`), system info, model cache/download, agent integrations |
| `studio/pipeline/` | `core.py` stages + runner, `coverage.py`, `routes.py` |
| `studio/llm.py` | stage schemas, validator, agent/ollama/heuristic providers |
| `studio/mcp_server.py` | MCP bridge (mcp 2.3 `MCPServer`) |
| `studio/cli.py`, `studio/video.py` | the `studio` command; mp4 from composed panels |
| `dashboard/index.html` | v0.1 dashboard, now at `/legacy` |
| `stories/cheek-squish/` | the sample story |

## Verified

- Backend: `tests/test_core.py` (11) and `tests/test_pipeline.py` (6) pass with the mock engine.
  cheek-squish prompts are byte-identical to v0.1 (`tests/cheek_squish_prompts.json`); v0.1 panels
  compose pixel-identically.
- UI: every view was exercised in a headless browser against a mock backend on a scratch copy of the
  stories: onboarding, library, studio canvas and lettering edits (checked through the API), cast
  studio writes, mock inpaint end to end, pipeline heuristic run to done, reader spreads/scroll, export.
- `pnpm exec tsc -b` and `vite build` pass; `cargo check` of the Tauri shell passes.

## Not verified yet

- Inpaint and img2img with the real model (only the mock engine).
- A real model download from onboarding (download path only tested with a mock).
- The Ollama provider against a live Ollama (it wasn't running).
- The Claude/Codex "Connect" buttons (they register the MCP server for the user; not clicked).
- `pnpm tauri dev` window opened and used by a human; pinch/ctrl+wheel zoom.

## Known gaps

- No undo in Studio.
- Crop can be panned in the UI but not zoomed (`crop.scale` is honoured if set in yaml).
- Panel reorder in the rail calls `PUT /api/stories/{slug}/panels/order`, which is being added on a
  separate branch; until it lands, reordering shows an error toast.
- Export should use the same default crop as the canvas for panels without `crop` (canvas frames to
  keep lettering visible), or exported pages can cut bubbles the canvas shows.
- Webtoon export width is fixed at 800 px. Deleting a panel keeps its images in `out/<pid>/`.
- Heuristic pipeline cast looks are placeholders the user is expected to edit in Cast studio.

## The sample story: `stories/cheek-squish/`

A remake of the user's reference video `/Users/himanshu/Downloads/Video-92855.mp4` (720x960, 44 s).
All 10 panels are generated, composed and turned into video (`final/cheek-squish.mp4`,
`final/cheek-squish-with-audio.mp4`, `final/strip.png`). Picks for `sheet`, `room`, `p01`, `p07` were
chosen by Claude while the user was away; the user hasn't reviewed them. It has no `pages:` yet
(use "Lay out pages" in Studio, or `POST /pages/auto`).

Still-open issues from v0.1:
1. **p08 is weak**: Aoi leans on Kai, but it doesn't read as "Give it to me already!!". Rewrite the
   action (she grabs his sleeve and tugs, or pushes her face up to his hands) and regenerate with `-n 3`.
2. **p02 doesn't match the script.** Aoi stands beside them instead of peeking over the sofa backrest.
3. **p01 and p07 actions are the old wording**; the current picks came from lucky seeds. Before
   regenerating, strengthen them: p01, Kai's own hands pinch her cheeks; p07, the exact pout (lips
   pushed out, puffed red cheeks, anger vein).
4. Bubble tails were tuned by eye for the current picks (p01, p02, p03's second bubble, p08); re-check
   after a regeneration (drag them in Studio now).

## User preferences

- **No memgate** for this project, even though the global `~/.claude/CLAUDE.md` says to. Run
  `uv run studio serve` directly, in the background.
- **pnpm** only for the app.
- **Commit often** (the user asked for frequent, progressive commits). History: v0.1 is Oct 27-29,
  the v0.2 migration is Oct 30. Parallel work goes on separate git worktrees/branches, merged back.
- UI direction: light, minimal, to the point (design-taste-frontend), smooth motion per apple-design
  and animate: springs without bounce by default, no motion on high-frequency actions, reduced motion
  respected. One accent (vermilion), Geist, Phosphor icons, no em dashes in UI copy.

## Gotchas learned the hard way

- **Look at every output before reporting it.** The model often gets identity right but the story beat
  wrong: who is touching whom, and which expression.
- story.yaml actions are folded `>-` blocks over several lines. Edit the exact lines and **check the
  edit applied before queuing gens**; chain with `&&`. Re-read first: the app may have just written it.
- `rm` and `cp` are aliased to interactive versions here and hang; use `/bin/rm -f`, `/bin/cp -f`.
- zsh globs: quote URLs with `?` (`curl -s '127.0.0.1:7860/api/jobs?active=true'`).
- Turbo runs at guidance 1, so negative prompts do nothing; use `avoid:`.
- Browser screenshots of the app: the SSE stream never idles, so wait on selectors or timeouts, not
  network idle.
- `/api/integrations` shells out to `claude`/`codex mcp list` (seconds); it's cached and warmed at startup.
