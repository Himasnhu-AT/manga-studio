// The traditional manga production order, one stage per panel (story.yaml `stage`). Colours tell stages
// apart by lightness as well as hue, so the progress bar reads in greyscale too.

import { STAGES, type Panel, type Stage } from "./api";

export const STAGE_META: Record<Stage, { label: string; hint: string; bg: string; fg: string }> = {
  name: { label: "Name", hint: "Thumbnail: layout and flow only", bg: "#e6e6e3", fg: "#55555c" },
  pencils: { label: "Pencils", hint: "Rough or clean pencils", bg: "#dbe9f6", fg: "#24557f" },
  inks: { label: "Inks", hint: "Inked line art", bg: "#3a3a40", fg: "#ffffff" },
  blacks: { label: "Blacks", hint: "Solid black fills done", bg: "#17171a", fg: "#ffffff" },
  tone: { label: "Tone", hint: "Screentone done", bg: "#c9c3d8", fg: "#3d3456" },
  finish: { label: "Finish", hint: "Art finished, white-out and effects done", bg: "#c8dfd1", fg: "#22663f" },
  letters: { label: "Letters", hint: "Lettered: the panel is done", bg: "#2f8a5b", fg: "#ffffff" },
};

export { STAGES };

/** Stage counts over the story's strip panels, in production order, plus panels with no stage set. */
export function stageCounts(panels: Panel[]) {
  const strip = panels.filter((p) => p.strip !== false);
  const counts = STAGES.map((s) => ({ stage: s, n: strip.filter((p) => p.stage === s).length }));
  return { counts, unset: strip.filter((p) => !p.stage).length, total: strip.length };
}

/** Where a Refine preset takes a panel. */
export const REFINE_STAGE: Record<string, Stage> = { clean: "inks", inks: "inks", tone: "tone", color: "finish" };
