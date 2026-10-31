# Manga Studio

[![CI](https://github.com/Himasnhu-AT/manga-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/Himasnhu-AT/manga-studio/actions/workflows/ci.yml)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](LICENSE)

**[mangastudio.marlstudio.com](https://mangastudio.marlstudio.com)** ·
[Download for Mac](https://github.com/Himasnhu-AT/manga-studio/releases/latest) (Apple Silicon)

A local manga/webtoon studio for Apple Silicon. Write or paste a story, draw it with
**Qwen-Image-2.1 running on your Mac** (mflux / MLX), letter it with vector bubbles, read it, export it.
Drive it by hand in the desktop app, or let Claude Code, Codex or a local Ollama model drive it
over MCP. Nothing leaves the machine.

```
app/            Tauri + Vite + React desktop app (Studio, Pipeline, Reader, onboarding)
studio/         Python backend: FastAPI + the model worker, story files, pipeline, MCP bridge
stories/<slug>/ story.yaml (source of truth), refs/, out/ (versions), final/ (composed, exports)
docs/ARCHITECTURE.md   data model + HTTP API + MCP tools
```

## Run it

```bash
uv sync                         # Python deps (first image job downloads the model, ~32 GB, once)
cd app && pnpm install
pnpm tauri dev                  # desktop app; it starts `uv run studio serve` for you
```

No Tauri? `uv run studio serve` and open http://127.0.0.1:7860 (serves the built UI after
`pnpm build` in `app/`, the v0.1 dashboard otherwise; the old dashboard stays at `/legacy`).
`uv run studio serve --mock` draws placeholders instead of loading the model.

The first launch walks through setup: checks the Mac, downloads Qwen-Image-2.1 Turbo if it isn't
cached, connects an AI, and creates a first project.

### The downloaded app

The released `Manga Studio.app` carries the backend inside it and needs only
[uv](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`; the app tells
you if it's missing). The first launch installs the Python packages (a minute or two). Where things
live:

```
~/Manga Studio/stories/                       your stories (starts with the sample, cheek-squish)
~/Library/Application Support/Manga Studio/   settings.json, backend.log, the Python venv, MCP launcher
```

`pnpm tauri build` makes the same app from a checkout; a debug build (`pnpm tauri dev`) or
`MANGA_STUDIO_ROOT=<repo>` always runs the checkout's backend and stories instead.

## Two ways to make a story

**Studio (manual).** Page layouts (RTL/LTR grids, diagonal slices) or a vertical webtoon scroll.
Each panel has layers: background, art, screentone/FX, and an SVG lettering layer. Bubbles
(speech, shout, thought, caption, horizontal or vertical text) are vector overlays, so editing
dialogue never touches the artwork. The Cast studio keeps each character's face, hair, outfit,
palette, reference images and identity seed; the panel Copilot (txt2img, img2img, inpaint)
injects the active cast's reference sheets automatically.

**Pipeline (automatic).** Paste a story and run six stages: source analysis, script, storyboard
layout, artwork, auto-lettering (bubbles placed in low-detail areas, away from faces), and a QA
gate that retries a panel up to 3 times before flagging it for a manual fix. A coverage tracker
maps character spans of the source to panels so no beat is skipped. The result opens in Studio.

The language stages run through your agent (Claude Code / Codex over MCP), a local Ollama model,
or a no-LLM heuristic.

## Connect an agent

```bash
uv run studio mcp-install     # once: puts manga-studio-mcp on your PATH (the app's Connect does this too)
claude mcp add --scope user manga-studio -- manga-studio-mcp
codex mcp add manga-studio -- manga-studio-mcp
```

Then ask: *"make the character sheet for cheek-squish, 4 seeds"* or *"run the pipeline task for my-story"*.
The `studio` CLI still works for everything (see `CLAUDE.md`).

## Export

Print PDF (B5/A5 with bleed and margins, or digital), layered SVG per page (raster panels +
vector lettering), PNG pages or webtoon slices, and the v0.1 `studio video` mp4.

## License

Manga Studio is under the [BSD 3-Clause License](LICENSE). The Qwen-Image-2.1 model it downloads is
under its own license, the Qwen Research License (research/evaluation use).

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
Fonts: Comic Neue (SIL OFL, `fonts/OFL.txt`), Geist and Kalam (SIL OFL).
