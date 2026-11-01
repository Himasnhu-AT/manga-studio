"""Turn composed panels (final/<pid>.png) into a vertical mp4: slow zoom on each panel, crossfades.

Each panel is held long enough to read its bubbles (a base time plus time per word), unless the
panel sets `hold: <seconds>` in story.yaml. Needs ffmpeg on PATH.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from studio.story import Story

FPS = 30


def _hold(panel: dict) -> float:
    if "hold" in panel:
        return float(panel["hold"])
    words = sum(len(b.get("text", "").split()) for b in panel.get("bubbles", []) or [])
    return max(3.0, min(6.5, 2.2 + 0.32 * words))


def panel_start(durs: list[float], fade: float, i: int) -> float:
    """Second at which panel i is half faded in (the moment it reads as on screen)."""
    if i == 0:
        return 0.0
    length = durs[0]
    for k in range(1, i + 1):
        off = length - fade
        if k == i:
            return off + fade / 2
        length = off + durs[k]
    return 0.0


def make_video(
    story: Story,
    width: int = 720,
    height: int = 960,
    fade: float = 0.5,
    audio: Path | None = None,
    out: Path | None = None,
    audio_start: float = 0.0,
    hit: tuple[str, float] | None = None,
) -> Path:
    """`audio_start` skips into the song. `hit=(pid, t)` instead starts the song so that its moment at `t`
    seconds (the chorus, the hook) lands the instant panel `pid` appears."""
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found (brew install ffmpeg)")
    panels = [p for p in story.panels if p.get("strip", True) is not False]
    items = [(p, story.dir / "final" / f"{p['id']}.png") for p in panels]
    missing = [p["id"] for p, f in items if not f.exists()]
    if missing:
        raise RuntimeError(f"not composed yet: {', '.join(missing)} (run: studio compose {story.slug})")

    out = out or story.dir / "final" / f"{story.slug}.mp4"
    args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    durs = []
    for i, (p, f) in enumerate(items):
        # first/last panels don't lose time to a fade on their outer side
        d = _hold(p) + (fade if 0 < i < len(items) - 1 else fade / 2) if len(items) > 1 else _hold(p)
        durs.append(d)
        args += ["-loop", "1", "-framerate", str(FPS), "-t", f"{d:.3f}", "-i", str(f)]

    graph = []
    for i, d in enumerate(durs):
        frames = int(d * FPS)
        # upscale first so zoompan's integer cropping doesn't jitter
        graph.append(
            f"[{i}:v]scale={width * 2}:{height * 2}:force_original_aspect_ratio=decrease,"
            f"pad={width * 2}:{height * 2}:(ow-iw)/2:(oh-ih)/2:white,"
            f"zoompan=z='1+0.05*on/{frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={width}x{height}:fps={FPS},"
            f"setsar=1,format=yuv420p[v{i}]"
        )
    last, length = "v0", durs[0]
    for i in range(1, len(durs)):
        off = length - fade
        graph.append(f"[{last}][v{i}]xfade=transition=fade:duration={fade}:offset={off:.3f}[x{i}]")
        last, length = f"x{i}", off + durs[i]

    total = length
    if audio and hit:
        audio_start = max(0.0, hit[1] - panel_start(durs, fade, [p["id"] for p, _ in items].index(hit[0])))
    if audio:
        args += ["-i", str(audio)]
        a = len(durs)
        graph.append(
            f"[{a}:a]atrim=start={audio_start:.3f}:duration={total:.3f},asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d=0.4,afade=t=out:st={max(0, total - 1.5):.3f}:d=1.5[aout]"
        )

    args += ["-filter_complex", ";".join(graph), "-map", f"[{last}]"]
    if audio:
        args += ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k"]
    args += ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", "-t", f"{total:.3f}", str(out)]
    subprocess.run(args, check=True)
    return out
