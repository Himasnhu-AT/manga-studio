// The model behind the hero figure. Pure: no DOM.
// The six stages are the real Manga Studio pipeline stages, in order. The page is a right-to-left
// manga page: five panels, read from the top right, with one diagonal gutter, and three bubbles.
import { PAGE, PEN_DX, onPage } from "./view";

export const STAGES = ["analysis", "script", "layout", "artwork", "lettering", "qa"] as const;
export type Stage = (typeof STAGES)[number] | "done";

export type UV = [number, number];

// Panels in page fractions (u, v), listed in reading order (right to left, top to bottom).
export const PANELS: UV[][] = [
  [
    [0.07, 0.06],
    [0.93, 0.06],
    [0.93, 0.31],
    [0.07, 0.31],
  ],
  [
    [0.53, 0.34],
    [0.93, 0.34],
    [0.93, 0.6],
    [0.47, 0.6],
  ],
  [
    [0.07, 0.34],
    [0.5, 0.34],
    [0.44, 0.6],
    [0.07, 0.6],
  ],
  [
    [0.41, 0.63],
    [0.93, 0.63],
    [0.93, 0.94],
    [0.41, 0.94],
  ],
  [
    [0.07, 0.63],
    [0.38, 0.63],
    [0.38, 0.94],
    [0.07, 0.94],
  ],
];

export interface Bubble {
  panel: number;
  at: UV;
  r: UV;
  tail: UV;
}

// Bubbles: centre, radii (in page fractions) and the tip of the tail.
export const BUBBLES: Bubble[] = [
  { panel: 0, at: [0.74, 0.13], r: [0.13, 0.045], tail: [0.66, 0.22] },
  { panel: 1, at: [0.75, 0.42], r: [0.12, 0.04], tail: [0.82, 0.5] },
  { panel: 3, at: [0.6, 0.71], r: [0.13, 0.045], tail: [0.7, 0.8] },
];

export const centreOf = (poly: UV[]): UV => [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];

// Where the gantry has to be so the pen is over a point of the page.
export const headFor = ([u, v]: UV): { gx: number; hy: number } => {
  const [x, y] = onPage(u, v);
  return { gx: x - PEN_DX, hy: y };
};

const IN_TRAY = { gx: -128 - PEN_DX, hy: 0 };
const PARK = { gx: 128 - PEN_DX, hy: 0 };

export interface Pose {
  gx: number;
  hy: number;
  lift: number; // 1 = pen up, 0 = pen down on the paper
  borders: number[];
  art: number[];
  bubbles: number[];
  stage: Stage;
  step: number; // 1-based item within the stage, 0 when it has none
  of: number;
}

// Timeline, in seconds.
const T = {
  analysis: 0,
  script: 2.2,
  layout: 4.6,
  artwork: 7.6,
  lettering: 14.2,
  qa: 17.4,
  done: 20.4,
  fade: 23.6,
  loop: 24.6,
};
export const LOOP = T.loop;
export const DONE_AT = T.done + 1.6;
export const STAGE_STARTS: number[] = [T.analysis, T.script, T.layout, T.artwork, T.lettering, T.qa, T.done];

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const smooth = (t: number) => {
  const u = clamp(t);
  return u * u * (3 - 2 * u);
};
const ramp = (t: number, from: number, length: number) => smooth((t - from) / length);

const ART_EACH = (T.lettering - T.artwork) / PANELS.length;
const BUBBLE_EACH = (T.qa - T.lettering) / BUBBLES.length;
const QA_EACH = (T.done - T.qa) / PANELS.length;
const LAYOUT_EACH = (T.artwork - T.layout) / PANELS.length;

export function poseAt(clock: number): Pose {
  const t = ((clock % LOOP) + LOOP) % LOOP;
  const fadeOut = 1 - ramp(t, T.fade, T.loop - T.fade - 0.2);
  const borders = PANELS.map((_, index) => ramp(t, T.layout + index * LAYOUT_EACH + 0.25, 0.4) * fadeOut);
  const art = PANELS.map((_, index) => ramp(t, T.artwork + index * ART_EACH + 0.5, 0.6) * fadeOut);
  const bubbles = BUBBLES.map((_, index) => ramp(t, T.lettering + index * BUBBLE_EACH + 0.45, 0.35) * fadeOut);
  const base = { borders, art, bubbles };

  if (t < T.script) return { ...base, ...IN_TRAY, lift: 1, stage: "analysis", step: 0, of: 0 };
  if (t < T.layout) {
    const share = (t - T.script) / (T.layout - T.script);
    const hy = -34 + 68 * smooth(share * 1.15);
    return { ...base, gx: IN_TRAY.gx, hy, lift: 1, stage: "script", step: 0, of: 0 };
  }
  if (t < T.artwork) {
    const index = Math.min(PANELS.length - 1, Math.floor((t - T.layout) / LAYOUT_EACH));
    const corner = PANELS[index][1];
    return { ...base, ...headFor(corner), lift: 1, stage: "layout", step: index + 1, of: PANELS.length };
  }
  if (t < T.lettering) {
    const index = Math.min(PANELS.length - 1, Math.floor((t - T.artwork) / ART_EACH));
    const local = t - T.artwork - index * ART_EACH;
    const down = local > 0.42 && local < ART_EACH - 0.2;
    return { ...base, ...headFor(centreOf(PANELS[index])), lift: down ? 0 : 1, stage: "artwork", step: index + 1, of: PANELS.length };
  }
  if (t < T.qa) {
    const index = Math.min(BUBBLES.length - 1, Math.floor((t - T.lettering) / BUBBLE_EACH));
    const local = t - T.lettering - index * BUBBLE_EACH;
    const down = local > 0.38 && local < BUBBLE_EACH - 0.2;
    return { ...base, ...headFor(BUBBLES[index].at), lift: down ? 0 : 1, stage: "lettering", step: index + 1, of: BUBBLES.length };
  }
  if (t < T.done) {
    const index = Math.min(PANELS.length - 1, Math.floor((t - T.qa) / QA_EACH));
    return { ...base, ...headFor(centreOf(PANELS[index])), lift: 1, stage: "qa", step: index + 1, of: PANELS.length };
  }
  return { ...base, ...PARK, lift: 1, stage: "done", step: 0, of: 0 };
}

const WORDS: Record<Stage, string> = {
  analysis: "reading the story",
  script: "writing the script",
  layout: "laying out",
  artwork: "drawing",
  lettering: "lettering",
  qa: "checking",
  done: "page done",
};

export function readoutOf(pose: Pose) {
  if (pose.stage === "done") return `page done · ${PANELS.length} panels, ${BUBBLES.length} bubbles`;
  const unit = pose.stage === "lettering" ? "bubble" : "panel";
  const index = STAGES.indexOf(pose.stage) + 1;
  return `${index}/6 ${pose.stage} · ${pose.of ? `${unit} ${pose.step} of ${pose.of}` : WORDS[pose.stage]}`;
}

export const PAGE_W = PAGE.w;
