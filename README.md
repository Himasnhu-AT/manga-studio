# manga-studio

Make consistent manga/webtoon panels with **Qwen-Image-2.1 running locally** on Apple Silicon
(mflux / MLX). You direct, Claude Code writes prompts and runs generations, the dashboard shows results.

```bash
uv sync
uv run studio serve          # http://127.0.0.1:7860  (first job downloads ~32 GB once, then loads the model)
```

Then in Claude Code (from this folder): *"generate the character sheet for cheek-squish, 4 seeds"*.

- **Dashboard**: every panel with its versions, refs, exact prompt. Click a version for the
  viewer: ←/→ browse, `p` use it, `s` star, `c` compare with the one in use. Write notes under a
  panel; Claude reads them with `studio feedback`.
- **Strip** tab + **Compose strip**: bubbles drawn on the picked panels → `stories/<slug>/final/strip.png`.
- How it stays consistent and every CLI command: see `CLAUDE.md`.

Model license: Qwen-Image-2.1 is under the Qwen Research License (research/evaluation use).
Font: Comic Neue (SIL OFL, `fonts/OFL.txt`).
