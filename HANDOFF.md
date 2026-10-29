# Handoff: manga-studio (state as of 2026-10-30)

Read `CLAUDE.md` first: it's the operating manual (commands, the feedback loop, consistency rules).
This file covers what has been done and what's left.

## What this project is

The user makes short manga/webtoon stories with **Qwen-Image-2.1** running locally on their Mac.
Claude writes prompts and runs generations through the `studio` CLI. The user reviews results in
the dashboard at http://127.0.0.1:7860 and leaves picks, stars and notes there.

- Self-hosted on purpose, to keep cost down: Apple M5 Pro, 24 GB RAM, model via **mflux 0.24.0** (MLX).
- Default: `qwen-image-2.1-turbo`, 4-bit, 8 steps, 864x1152. About **60-100 s per image**, **7.4 GB peak** memory.
- The model weights are already downloaded into the Hugging Face cache, so there's no download step.
- **User preference: do not use memgate** for heavy commands in this project, even though the global
  `~/.claude/CLAUDE.md` says to. Run `uv run studio serve` directly, in the background.
- No git repo yet (`git init` hasn't been run). Ask before committing anything.

## Layout

| Path | What |
|---|---|
| `studio/story.py` | story.yaml loading, prompt building (refs → blocks → action → avoid), versions, state.json |
| `studio/engine.py` | `MfluxEngine` (keeps the model loaded), `MockEngine` (`STUDIO_ENGINE=mock`) |
| `studio/server.py` | FastAPI: dashboard, one worker thread + job queue, SSE live refresh, file watcher |
| `studio/compose.py` | draws bubbles/sfx with PIL on picked panels → `final/<pid>.png`, `final/strip.png` |
| `studio/video.py` | **new**: composed panels → mp4 (slow zoom + crossfades, hold time scales with word count) |
| `studio/cli.py` | the `studio` command |
| `dashboard/index.html` | single-file vanilla JS dashboard |
| `stories/cheek-squish/` | the sample story (below) |
| `fonts/ComicNeue-Bold.ttf` | bubble font (OFL) |

## The sample story: `stories/cheek-squish/`

A remake of the user's reference video `/Users/himanshu/Downloads/Video-92855.mp4` (720x960, 44 s).
Dad Kai squishes his daughter's cheeks and sends her for candy. Mom Aoi then wants her turn, gets
jealous and pouts, and Kai finally squishes her cheeks ("I'm the winner~").

**Status: done end to end.** All 10 panels are generated, composed and turned into video:

- `final/cheek-squish.mp4`: 43.4 s, 720x960, silent
- `final/cheek-squish-with-audio.mp4`: same video with the reference video's soundtrack, faded out at the end
- `final/strip.png` and `final/p01.png`–`p10.png`

**Picks** (in `state.json`). Claude chose these while the user was away; the user hasn't reviewed them yet:
- `sheet` → 001-s10308.png
- `room` → 002-s41253.png
- `p01` → 002-s61544.png
- `p07` → 002-s72282.png
- Every other panel uses its only version, 001.

**Refs:** `sheet` (character sheet) and `room` (empty living room) are reference panels
(`strip: false`). Every story panel uses `refs: [sheet, room]` (star topology). `p10` uses `[sheet]` only.
Consistency across panels was good on the first pass: outfits, hair colours, flower clip and room all held.

## Known issues / next steps

1. **p08 is weak**: Aoi leans on Kai, but it doesn't read as "Give it to me already!!".
   Rewrite the action (she grabs his sleeve and tugs, or pushes her face up to his hands) and regenerate with `-n 3`.
2. **p02 doesn't match the script.** Aoi stands beside them instead of peeking over the sofa backrest.
3. **p01 and p07 actions in story.yaml are the old wording.** A tightened rewrite failed to apply (the
   YAML `>-` blocks span several lines), so the current picks came from lucky seeds with the old text.
   Before regenerating either panel, strengthen the action. For p01, say Kai's own hands pinch her
   cheeks. For p07, describe the pout exactly: lips pushed out, puffed red cheeks, anger vein.
4. **Bubble tails were tuned by eye** for the current picks: p01, p02, p03's second bubble and p08.
   If a panel is regenerated, the speaker may move, so re-check the tails after `compose`.
5. Optional ideas the user hasn't asked for:
   - A `hold:` per panel to match the reference video's pacing.
   - A dashboard button for `studio video`.

After any change, rebuild:
```bash
uv run studio compose cheek-squish
uv run studio video cheek-squish
uv run studio video cheek-squish --audio /Users/himanshu/Downloads/Video-92855.mp4 --out stories/cheek-squish/final/cheek-squish-with-audio.mp4
```

## Gotchas learned the hard way

- **Look at every output before reporting it.** Read the PNGs, or make a contact sheet with PIL.
  The model often gets identity right but the story beat wrong: who is touching whom, and which
  expression.
- Editing story.yaml: actions are folded `>-` blocks over several lines. Use the Edit tool on the
  exact lines, not a one-line string replace, and **check the edit applied before queuing gens**.
  Chain with `&&` so a failed edit stops the gen.
- `rm` is aliased to `rm -i` on this machine and hangs; use `/bin/rm -f`.
- zsh globs: quote URLs with `?` (`curl -s '127.0.0.1:7860/api/jobs?active=true'`).
- The server isn't running right now (the last session ended). Start it with `uv run studio serve` in
  the background. The first job loads the model (~1-2 min).
- Turbo runs at guidance 1, so negative prompts do nothing; use the `avoid:` line instead.
- Agent-browser screenshots of the dashboard hang (the SSE connection never idles). Check images
  by reading the files instead.

## Relevant user requests (verbatim)

- "make it such that i can drive creation (prompts) with claude code, dashboard acts as place for me to see images visually"
- "self host, to keep cost to minimum"
- "don't use memgate"
- "perform sample run, generate something similar to video (somewhat same story, and give me video)": done
