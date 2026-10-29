# manga-studio: how Claude drives it

The user directs a manga/webtoon story; **Claude writes prompts and runs generations; the user
looks at results in the dashboard** (http://127.0.0.1:7860) and leaves picks, stars and notes there.

Model: Qwen-Image-2.1 (Turbo by default) running locally on Apple Silicon through mflux, kept
loaded inside `studio serve`. Up to 10 reference images per generation.

## Commands (run from this directory)

```bash
uv run studio serve                 # dashboard + worker; keep it running (background). --mock = no model
uv run studio show <story>          # panels, versions, which version is used, broken refs, open notes
uv run studio prompt <story> <pid>  # exact prompt + reference images a panel will send (dry run)
uv run studio gen <story> <pid>... [-n 4] [--seed 42] --wait   # queue + wait; prints output paths
uv run studio feedback <story>      # the user's dashboard notes, picks, stars  <- read this every turn
uv run studio resolve <story> <n> --reply "what I changed"     # close a note (reply shows in dashboard)
uv run studio pick <story> <pid> <file>     # choose the version used as ref + in the strip
uv run studio compose <story>       # draw bubbles/sfx on picked panels -> final/<pid>.png + final/strip.png
uv run studio video <story> [--audio file]  # composed panels -> final/<story>.mp4 (zoom + crossfades)
uv run studio new <slug> --title "..."      # scaffold a story from templates/story.yaml
```

If `gen` says the server isn't running, start `uv run studio serve` in the background (don't
use memgate). The first job loads the model (about 1–2 min); later jobs reuse it.

## The loop

1. `studio feedback <story>` → what the user asked for, which versions they picked/starred.
2. Edit `stories/<story>/story.yaml` (blocks, panel `action`, refs, bubbles).
3. `studio prompt` to sanity-check, then `studio gen ... --wait`.
4. **Look at the outputs yourself** (Read the printed PNG paths) and compare against the refs.
   Regenerate if identity/outfit/colors drifted, before telling the user it's ready.
5. `studio resolve` the notes you handled, with a one-line reply.

Picks are the user's call. Only `studio pick` yourself when the user asks, or for a
reference panel (`sheet`, `room`) while the user is away and you said which one you chose.

## Consistency rules (why the story.yaml is shaped this way)

- **Star topology, not a chain.** Every story panel's refs are the same anchors (`sheet`, `room`),
  never "the previous panel". Chaining compounds drift (that's what broke the first attempt:
  dad's black sweater became a white shirt by panel 3 and stayed wrong).
- **Verbatim blocks.** Character/style/setting text lives once in `blocks:`; panels list them in
  `use:`. Don't paraphrase a character inside `action` — change the block instead.
- **Exact color words.** "pastel periwinkle-blue", never just "blue" (the model read "blue" as navy).
- **Name the outfit every time.** Clothes are what the model changes first.
- **No text in images.** The style block says no text/bubbles; dialogue goes in `bubbles:` and is
  drawn by `studio compose`. Re-rendering text makes the model redraw everything.
- **`avoid:` instead of a negative prompt.** Turbo runs at guidance 1, where negative prompts do
  nothing, so it's appended to the prompt as "Avoid: ...".
- **Prompt refers to refs by position**: the prompt starts "Image 1: <label>. Image 2: <label>."
  generated from each ref's `label`/`ref_label`. Mention "image 1"/"image 2" in actions when useful.
- Small tweak on an existing image (expression, a prop): put that image first in `refs` and set
  `strength: 0.6` (the first ref is the source; lower = closer to it). Big pose changes → 1.0.

## story.yaml cheat sheet

```yaml
defaults: {model: qwen-image-2.1-turbo, quantize: 4, width: 864, height: 1152}  # 3:4, multiples of 32
refs:                       # files in stories/<slug>/refs/ + label used in the prompt
  family-ref.png: {label: "style and character reference - ..."}
blocks: {style: ..., kai: ..., setting: ...}
avoid: "t-shirt, navy hair, any text"
panels:
  - id: sheet               # reference panel: strip: false, other panels use it via refs: [sheet]
    strip: false
    ref_label: character reference sheet
  - id: p01
    refs: [sheet, room]     # panel id (uses its picked/newest version) or a refs/ filename; max 10
    use: [style, kai, setting]
    action: what happens
    seed: 42                # optional fixed seed
    strength: 1.0           # optional
    bubbles:                # coordinates are fractions of the panel
      - {text: "Hi!", at: [0.7, 0.1], w: 0.4, tail: [0.62, 0.3], style: speech}   # speech|shout|thought|caption
    sfx:
      - {text: "#", at: [0.2, 0.08], size: 1.5, rotate: -10}
```

Outputs: `stories/<slug>/out/<pid>/NNN-s<seed>.png` + `.json` (full prompt, refs and versions used,
seconds). Dashboard state (picks, stars, notes): `stories/<slug>/state.json`; don't hand-edit it while
the server runs, use the CLI.

## Memory on this Mac (24 GB)

Turbo + `quantize: 4` is the setting that fits. Base model (40 steps) at q4 is ~5× slower; try it for
finals only. If a job dies or the Mac swaps hard, drop size to 768×1024 or close other apps.
`STUDIO_MLX_CACHE_GB` (default 2) caps MLX's buffer cache.
