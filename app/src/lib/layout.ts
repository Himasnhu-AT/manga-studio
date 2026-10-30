// Page layout math: templates, reading order, gutters, art framing.
// Slot boxes are fractions of the page's live area (inside the margins), per docs/ARCHITECTURE.md.

import type { Box, Format, Page, PageSlot, Panel, StoryDetail, Vec2 } from "./api";

export const DEFAULT_PAGE = { width: 1654, height: 2339 };

export function pageDims(f: Format | undefined) {
  const page = f?.page ?? DEFAULT_PAGE;
  const margin = f?.margin ?? 0.06;
  const gutter = f?.gutter ?? 0.018;
  const m = margin * page.width; // margin in page px, same on every side
  const live = { x: m, y: m, w: page.width - 2 * m, h: page.height - 2 * m };
  return { page, margin, gutter, live };
}

/** Gutter as fractions of the live area, horizontally and vertically. */
export function gutterFrac(f: Format | undefined) {
  const { gutter, page, live } = pageDims(f);
  const g = gutter * page.width;
  return { gx: g / live.w, gy: g / live.h };
}

// ---- templates ----------------------------------------------------------------

export type TemplateId = "one" | "rows2" | "rows3" | "grid4" | "big2" | "tier3";

export const TEMPLATES: { id: TemplateId; label: string; slots: number }[] = [
  { id: "one", label: "Splash", slots: 1 },
  { id: "rows2", label: "2 rows", slots: 2 },
  { id: "rows3", label: "3 rows", slots: 3 },
  { id: "grid4", label: "2 x 2", slots: 4 },
  { id: "big2", label: "Big + 2", slots: 3 },
  { id: "tier3", label: "3 tier, slanted", slots: 4 },
];

const r = (v: number) => Math.round(v * 10000) / 10000;
const box = (x: number, y: number, w: number, h: number): Box => [r(x), r(y), r(w), r(h)];

/** Slots of a template, in reading order for LTR. `rtl` mirrors them horizontally. */
export function templateSlots(id: TemplateId, f: Format | undefined): { box: Box; poly?: Vec2[] }[] {
  const { gx, gy } = gutterFrac(f);
  const rows = (n: number) => {
    const h = (1 - gy * (n - 1)) / n;
    return Array.from({ length: n }, (_, i) => ({ box: box(0, i * (h + gy), 1, h) }));
  };
  let out: { box: Box; poly?: Vec2[] }[];
  switch (id) {
    case "one":
      out = [{ box: box(0, 0, 1, 1) }];
      break;
    case "rows2":
      out = rows(2);
      break;
    case "rows3":
      out = rows(3);
      break;
    case "grid4": {
      const w = (1 - gx) / 2;
      const h = (1 - gy) / 2;
      out = [
        { box: box(0, 0, w, h) },
        { box: box(w + gx, 0, w, h) },
        { box: box(0, h + gy, w, h) },
        { box: box(w + gx, h + gy, w, h) },
      ];
      break;
    }
    case "big2": {
      const h1 = 0.58;
      const h2 = 1 - h1 - gy;
      const w = (1 - gx) / 2;
      out = [{ box: box(0, 0, 1, h1) }, { box: box(0, h1 + gy, w, h2) }, { box: box(w + gx, h1 + gy, w, h2) }];
      break;
    }
    case "tier3": {
      const h = (1 - 2 * gy) / 3;
      const y = h + gy;
      out = [{ box: box(0, 0, 1, h) }, ...diagonalPair(y, h, gx, 0.6, 0.12), { box: box(0, 2 * (h + gy), 1, h) }];
      break;
    }
  }
  return f?.direction === "rtl" ? out.map(mirror) : out;
}

/**
 * Two slots side by side, split by a slanted gutter. The split runs from x = split + slant at the top
 * to x = split - slant at the bottom (fractions of the live width).
 */
function diagonalPair(y: number, h: number, gx: number, split: number, slant: number) {
  const topX = split + slant / 2;
  const botX = split - slant / 2;
  const lw = topX; // left box spans 0..topX
  const rx = botX + gx; // right box spans botX+gx..1
  const rw = 1 - rx;
  const left = { box: box(0, y, lw, h), poly: [[0, 0], [1, 0], [r(botX / lw), 1], [0, 1]] as Vec2[] };
  const right = { box: box(rx, y, rw, h), poly: [[r((topX + gx - rx) / rw), 0], [1, 0], [1, 1], [0, 1]] as Vec2[] };
  return [left, right];
}

function mirror(s: { box: Box; poly?: Vec2[] }) {
  const [x, y, w, h] = s.box;
  return { box: box(1 - x - w, y, w, h), poly: s.poly?.map(([px, py]) => [r(1 - px), py] as Vec2) };
}

/** Apply a template to a page, keeping the panels already on it (in order), then unplaced panels. */
export function applyTemplate(page: Page, id: TemplateId, f: Format | undefined, unplaced: string[]): Page {
  const slots = templateSlots(id, f);
  const current = orderSlots(page.panels, f?.direction ?? "ltr").map((s) => s.panel).filter(Boolean);
  const pool = [...current, ...unplaced.filter((p) => !current.includes(p))];
  return { ...page, panels: slots.map((s, i) => ({ panel: pool[i] ?? "", box: s.box, ...(s.poly ? { poly: s.poly } : {}) })) };
}

/** Client-side fallback for display when a story has no `pages` yet. */
export function autoPages(panels: Panel[], f: Format | undefined, perPage = 4): Page[] {
  const ids = panels.filter((p) => p.strip !== false).map((p) => p.id);
  const pages: Page[] = [];
  for (let i = 0; i < ids.length; i += perPage) {
    const chunk = ids.slice(i, i + perPage);
    const tpl: TemplateId = chunk.length === 1 ? "one" : chunk.length === 2 ? "rows2" : chunk.length === 3 ? "big2" : "grid4";
    const slots = templateSlots(tpl, f);
    pages.push({ id: `pg${pages.length + 1}`, panels: slots.map((s, j) => ({ panel: chunk[j] ?? "", box: s.box, ...(s.poly ? { poly: s.poly } : {}) })) });
  }
  return pages;
}

/** Reading order: top-to-bottom rows, then right-to-left (rtl) or left-to-right within a row. */
export function orderSlots<T extends { box: Box }>(slots: T[], dir: "rtl" | "ltr"): T[] {
  return [...slots].sort((a, b) => {
    const [ax, ay, aw, ah] = a.box;
    const [bx, by, bw, bh] = b.box;
    const overlapY = Math.min(ay + ah, by + bh) - Math.max(ay, by);
    if (overlapY > Math.min(ah, bh) * 0.4) {
      const acx = ax + aw / 2;
      const bcx = bx + bw / 2;
      return dir === "rtl" ? bcx - acx : acx - bcx;
    }
    return ay - by;
  });
}

export function storyPages(story: StoryDetail): Page[] {
  return story.pages?.length ? story.pages : autoPages(story.panels, story.format);
}

export function stripPanels(story: StoryDetail): Panel[] {
  return story.panels.filter((p) => p.strip !== false);
}

// ---- gutters (drag to resize adjacent slots) ------------------------------------

export interface Gutter {
  axis: "x" | "y"; // x: vertical line you drag left/right
  pos: number; // fraction of the live area (the before-edge)
  span: [number, number]; // extent along the other axis
  before: number[]; // slot indices whose right/bottom edge is at pos
  after: number[]; // slot indices whose left/top edge is at pos + gutter
}

const EPS = 0.004;

/** Find draggable gutter lines between adjacent axis-aligned slot edges. */
export function findGutters(slots: PageSlot[], f: Format | undefined): Gutter[] {
  const { gx, gy } = gutterFrac(f);
  const out: Gutter[] = [];
  const consider = (axis: "x" | "y") => {
    const g = axis === "x" ? gx : gy;
    const pairs: Gutter[] = [];
    slots.forEach((a, i) =>
      slots.forEach((b, j) => {
        if (i === j) return;
        const [ax, ay, aw, ah] = a.box;
        const [bx, by, bw, bh] = b.box;
        if (axis === "x") {
          const edge = ax + aw;
          if (Math.abs(bx - (edge + g)) > EPS * 3 || a.poly || b.poly) return;
          const lo = Math.max(ay, by);
          const hi = Math.min(ay + ah, by + bh);
          if (hi - lo > EPS) pairs.push({ axis, pos: edge, span: [lo, hi], before: [i], after: [j] });
        } else {
          const edge = ay + ah;
          if (Math.abs(by - (edge + g)) > EPS * 3) return;
          const lo = Math.max(ax, bx);
          const hi = Math.min(ax + aw, bx + bw);
          if (hi - lo > EPS) pairs.push({ axis, pos: edge, span: [lo, hi], before: [i], after: [j] });
        }
      }),
    );
    // merge pairs on the same line whose spans touch
    for (const p of pairs) {
      const tol = g + 0.015; // gutters from other tools round a little differently
      const m = out.find((o) => o.axis === axis && Math.abs(o.pos - p.pos) < EPS && p.span[0] <= o.span[1] + tol && p.span[1] >= o.span[0] - tol);
      if (m) {
        m.span = [Math.min(m.span[0], p.span[0]), Math.max(m.span[1], p.span[1])];
        for (const i of p.before) if (!m.before.includes(i)) m.before.push(i);
        for (const j of p.after) if (!m.after.includes(j)) m.after.push(j);
      } else out.push({ ...p, before: [...p.before], after: [...p.after] });
    }
  };
  consider("x");
  consider("y");
  return out;
}

/** Move a gutter to `pos`; adjacent boxes grow/shrink. Keeps every slot at least 6% big. */
export function moveGutter(slots: PageSlot[], gut: Gutter, pos: number, f: Format | undefined): PageSlot[] {
  const { gx, gy } = gutterFrac(f);
  const g = gut.axis === "x" ? gx : gy;
  const k = gut.axis === "x" ? 0 : 1;
  const min = 0.06;
  let lo = -Infinity;
  let hi = Infinity;
  for (const i of gut.before) lo = Math.max(lo, slots[i].box[k] + min);
  for (const j of gut.after) hi = Math.min(hi, slots[j].box[k] + slots[j].box[k + 2] - g - min);
  const p = Math.min(hi, Math.max(lo, pos));
  return slots.map((s, idx) => {
    const b = [...s.box] as Box;
    if (gut.before.includes(idx)) b[k + 2] = r(p - b[k]);
    if (gut.after.includes(idx)) {
      const end = b[k] + b[k + 2];
      b[k] = r(p + g);
      b[k + 2] = r(end - b[k]);
    }
    return { ...s, box: b };
  });
}

// ---- slicing ---------------------------------------------------------------------

export const SLANT_POLY: Vec2[] = [
  [0, 0],
  [1, 0],
  [1, 0.86],
  [0, 1],
];

export const polyClip = (poly?: Vec2[]) => (poly?.length ? `polygon(${poly.map(([x, y]) => `${x * 100}% ${y * 100}%`).join(",")})` : undefined);

// ---- art framing ---------------------------------------------------------------------

/**
 * Where the art frame sits inside its slot (CSS percentages of the slot), for `cover` fit plus the
 * panel's crop (focal x/y in 0..1 and zoom >= 1). Lettering lives in the same frame, so bubbles stay
 * glued to the art when a slot crops it.
 */
export function artFrame(imgAspect: number, slotAspect: number, crop?: { x: number; y: number; scale: number }) {
  const s = Math.max(1, crop?.scale ?? 1);
  let w = 100 * s;
  let h = 100 * s;
  if (imgAspect > slotAspect) w = (imgAspect / slotAspect) * 100 * s;
  else h = (slotAspect / imgAspect) * 100 * s;
  const fx = crop?.x ?? 0.5;
  const fy = crop?.y ?? 0.5;
  return { left: (100 - w) * fx, top: (100 - h) * fy, width: w, height: h };
}

/**
 * Default framing when a panel has no explicit crop: keep its lettering in view. Bubbles usually sit
 * near the top, and a centred cover crop of a wide slot would cut them off.
 */
export function autoCrop(p: Panel, imgAspect: number, slotAspect: number): { x: number; y: number; scale: number } | undefined {
  if (p.crop) return p.crop;
  const items = [...(p.bubbles ?? []).map((b) => b.at), ...(p.sfx ?? []).map((s) => s.at)];
  if (!items.length || imgAspect >= slotAspect) return undefined; // only vertical overflow needs help
  const visible = imgAspect / slotAspect; // fraction of the image height that fits
  const top = Math.max(0, Math.min(...items.map((a) => a[1])) - 0.09);
  const y = Math.min(1, Math.max(0, top / Math.max(0.0001, 1 - visible)));
  return { x: 0.5, y: Math.min(y, 0.5), scale: 1 };
}

/** Pixel size of a panel's raster: picked version meta, then panel/story settings, then 864x1152. */
export function panelSize(p: Panel, story?: StoryDetail): { W: number; H: number } {
  const v = p.versions.find((x) => x.file === p.pick);
  const sw = Number(story?.settings?.width) || 864;
  const sh = Number(story?.settings?.height) || 1152;
  const W = Number(v?.width) || p.width || sw;
  const H = Number(v?.height) || p.height || sh;
  return { W, H };
}
