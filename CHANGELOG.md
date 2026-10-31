# Changelog

Release notes for the macOS app. `scripts/release-mac.sh --publish` uses the section whose heading
matches the version in `app/src-tauri/tauri.conf.json`.

## [0.2.0] - 2026-10-31

The first desktop release: Manga Studio as a Tauri app for Apple Silicon Macs, signed with a
Developer ID and notarized by Apple.

### Desktop app
- Tauri shell that starts the Python backend with the app and stops its whole process group on
  restart and quit.
- Onboarding in a small borderless window: checks the Mac, downloads Qwen-Image-2.1 Turbo if it
  isn't cached (about 32 GB, once), connects an AI and creates a first project.
- Library, settings, pipeline view and export sheet.

### Studio
- Page layouts (right-to-left or left-to-right grids, diagonal gutters) or a vertical webtoon scroll,
  with a layout editor and reader.
- Panel layers: background, art, screentone and FX, and an SVG lettering layer.
- Vector lettering: speech, shout, thought and caption bubbles, horizontal or vertical text.
- Cast studio: each character's face, hair, outfit, palette, reference images and identity seed.
- Panel copilot for text to image, image to image and inpainting, with the cast's reference sheets.
- Inspector and versions viewer; reorder panels from the rail.

### Pipeline
- Six stages from story text to lettered pages: analysis, script, layout, artwork, lettering, QA.
- Auto-lettering places bubbles in low-detail areas away from faces, and never overrides a bubble
  you moved.
- QA retries a panel up to 3 times, then flags it for a manual fix.
- A coverage map ties every span of the source to panels.
- Language stages run on your agent, a local Ollama model or a no-LLM heuristic.

### Agents
- MCP bridge (`studio mcp`) with 24 tools for Claude Code, Codex or any MCP client.

### Export
- Print PDF (B5 or A5 with bleed and margins, or digital), layered SVG per page, PNG pages or
  webtoon slices, and mp4 video with slow zooms and crossfades.

### Fixes
- Story slugs that escape `stories/` are rejected (a `/files/%2E%2E/...` request served the repo).
- `story.yaml` writes keep comments and quote strings PyYAML would retype.
- Debounced saves flush on unmount and on leaving a view instead of being dropped.

### Requirements
- An Apple Silicon Mac with macOS 14 or later; 24 GB of memory recommended.
- `uv` installed (the app runs its Python backend with it).
