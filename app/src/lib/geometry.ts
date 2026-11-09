// Lettering geometry. Mirrors studio/compose.py so the SVG you edit is what compose/export draws.
// All numbers are in panel pixels (the raster's natural size, e.g. 864x1152); scale = W / 864.

import { useSyncExternalStore } from "react";
import type { Bubble, Sfx, Vec2 } from "./api";

export const LETTER_FONT = '"Comic Neue", "Geist", sans-serif';
export const INK = "rgb(25,25,30)";
export const PAPER = "rgb(255,255,255)";

// ---- font readiness: re-measure once Comic Neue has loaded ------------------

let fontRev = 0;
const fontListeners = new Set<() => void>();
if (typeof document !== "undefined" && document.fonts) {
  void document.fonts.load('700 28px "Comic Neue"').then(() => {
    fontRev++;
    measureCache.clear();
    fontListeners.forEach((l) => l());
  });
}
export const useFontRev = () =>
  useSyncExternalStore(
    (l) => {
      fontListeners.add(l);
      return () => fontListeners.delete(l);
    },
    () => fontRev,
  );

// ---- text measurement ---------------------------------------------------------

let ctx: CanvasRenderingContext2D | null = null;
const measureCache = new Map<string, { w: number; ascent: number }>();

function measure(text: string, px: number): { w: number; ascent: number } {
  const key = `${px}|${text}`;
  const hit = measureCache.get(key);
  if (hit) return hit;
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  let r = { w: text.length * px * 0.5, ascent: px * 0.8 };
  if (ctx) {
    ctx.font = `700 ${px}px ${LETTER_FONT}`;
    const m = ctx.measureText(text);
    r = { w: m.width, ascent: m.fontBoundingBoxAscent || px * 0.8 };
  }
  measureCache.set(key, r);
  return r;
}

/** Greedy word wrap, identical to compose._wrap. */
export function wrap(text: string, px: number, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const trial = cur ? `${cur} ${word}` : word;
      if (measure(trial, px).w <= maxW || !cur) cur = trial;
      else {
        lines.push(cur);
        cur = word;
      }
    }
    lines.push(cur);
  }
  return lines;
}

// ---- bubble layout --------------------------------------------------------

export interface TextLine {
  text: string;
  x: number; // left edge (horizontal) or column centre (vertical)
  y: number; // baseline (horizontal) or top of first glyph (vertical)
}
export interface Glyph {
  ch: string;
  x: number;
  y: number; // baseline
}

export interface BubbleGeom {
  style: NonNullable<Bubble["style"]>;
  cx: number;
  cy: number;
  rx: number; // half extents of the balloon (caption: of the box)
  ry: number;
  lw: number;
  px: number; // font px
  lines: TextLine[]; // horizontal text
  glyphs: Glyph[]; // vertical text
  vertical: boolean;
  tw: number;
  th: number;
  /** SVG path for the balloon body (no tail). */
  body: string;
  /** Tail polygon (speech/shout) or circles (thought), in panel px. */
  tail: { kind: "poly"; points: Vec2[] } | { kind: "dots"; circles: { x: number; y: number; r: number }[] } | null;
  /** Bounding box incl. tail tip, for hit-testing/selection. */
  bbox: [number, number, number, number];
}

/** Where a bubble without a position shows until Auto-letter (or a drag) places it. */
export const UNPLACED_AT: Vec2 = [0.5, 0.12];

export function bubbleGeom(b: Bubble, W: number, H: number): BubbleGeom {
  const scale = W / 864;
  const style = b.style ?? "speech";
  const px = Math.max(6, Math.floor(28 * scale * (b.size ?? 1)));
  const maxW = Math.floor(W * (b.w ?? 0.42) * 0.72);
  const lh = Math.floor(px * 1.18);
  const lw = Math.max(2, Math.floor(3 * scale));
  const at = b.at ?? UNPLACED_AT; // a line written in the Story editor, not placed yet
  const cx = at[0] * W;
  const cy = at[1] * H;
  const vertical = !!b.vertical;

  let tw: number, th: number;
  const lines: TextLine[] = [];
  const glyphs: Glyph[] = [];

  if (!vertical) {
    const ls = wrap(b.text || " ", px, maxW);
    tw = Math.max(...ls.map((l) => measure(l, px).w), 1);
    th = lh * ls.length;
    let y = cy - th / 2;
    for (const l of ls) {
      const m = measure(l, px);
      lines.push({ text: l, x: cx - m.w / 2, y: y + m.ascent });
      y += lh;
    }
  } else {
    // Vertical (tategaki): columns right to left, each column holds at most maxW of glyph advance.
    const adv = Math.round(px * 1.04);
    const perCol = Math.max(1, Math.floor(maxW / adv));
    const cols: string[][] = [];
    for (const para of (b.text || " ").split("\n")) {
      const chars = [...para.replace(/\s+/g, " ").trim()];
      if (!chars.length) cols.push([]);
      for (let i = 0; i < chars.length; i += perCol) cols.push(chars.slice(i, i + perCol));
    }
    const longest = Math.max(1, ...cols.map((c) => c.length));
    tw = cols.length * lh;
    th = longest * adv;
    const top = cy - th / 2;
    cols.forEach((col, ci) => {
      const colX = cx + tw / 2 - lh / 2 - ci * lh;
      col.forEach((ch, gi) => {
        const m = measure(ch, px);
        glyphs.push({ ch, x: colX - m.w / 2, y: top + gi * adv + m.ascent });
      });
    });
  }

  let rx: number, ry: number, body: string;
  if (style === "caption") {
    const pad = 14 * scale;
    rx = tw / 2 + pad;
    ry = th / 2 + pad;
    body = `M${cx - rx},${cy - ry}H${cx + rx}V${cy + ry}H${cx - rx}Z`;
  } else {
    rx = tw / 2 + 34 * scale;
    ry = th / 2 + 28 * scale;
    if (style === "shout") {
      const n = 22;
      const pts: string[] = [];
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        const k = i % 2 === 0 ? 1.18 : 0.98;
        pts.push(`${(cx + rx * k * Math.cos(a)).toFixed(2)},${(cy + ry * k * Math.sin(a)).toFixed(2)}`);
      }
      body = `M${pts.join("L")}Z`;
    } else {
      body = `M${cx - rx},${cy}a${rx},${ry} 0 1,0 ${2 * rx},0a${rx},${ry} 0 1,0 ${-2 * rx},0Z`;
    }
  }

  let tail: BubbleGeom["tail"] = null;
  if (b.tail && style !== "caption") {
    const tip: Vec2 = [b.tail[0] * W, b.tail[1] * H];
    if (style === "thought") {
      const circles = [0.55, 0.3].map((f, i) => ({
        x: cx + (tip[0] - cx) * (0.75 + 0.2 * i),
        y: cy + (tip[1] - cy) * (0.75 + 0.2 * i),
        r: 12 * scale * f * 2,
      }));
      tail = { kind: "dots", circles };
    } else {
      const ang = Math.atan2(tip[1] - cy, tip[0] - cx);
      const spread = 0.22;
      const base = [ang - spread, ang + spread].map((a) => [cx + rx * 0.82 * Math.cos(a), cy + ry * 0.82 * Math.sin(a)] as Vec2);
      tail = { kind: "poly", points: [base[0], tip, base[1]] };
    }
  }

  const k = style === "shout" ? 1.18 : 1;
  let x0 = cx - rx * k,
    y0 = cy - ry * k,
    x1 = cx + rx * k,
    y1 = cy + ry * k;
  if (b.tail && style !== "caption") {
    x0 = Math.min(x0, b.tail[0] * W);
    x1 = Math.max(x1, b.tail[0] * W);
    y0 = Math.min(y0, b.tail[1] * H);
    y1 = Math.max(y1, b.tail[1] * H);
  }
  return { style, cx, cy, rx, ry, lw, px, lines, glyphs, vertical, tw, th, body, tail, bbox: [x0, y0, x1 - x0, y1 - y0] };
}

export interface SfxGeom {
  x: number;
  y: number;
  px: number;
  rotate: number; // SVG degrees (clockwise); compose/PIL rotates counter-clockwise
  color: string;
  w: number;
}

export function sfxGeom(s: Sfx, W: number, H: number): SfxGeom {
  const px = Math.max(6, Math.floor(30 * (W / 864) * (s.size ?? 1)));
  const color = s.color ?? "rgb(60,60,70)";
  return { x: s.at[0] * W, y: s.at[1] * H, px, rotate: -(s.rotate ?? 0), color, w: measure(s.text || " ", px).w };
}

// ---- small helpers ------------------------------------------------------------

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Nearest protect-box centre within `radius` (fractions), used as a mouth anchor for tails. */
export function snapToProtect(p: Vec2, protect: [number, number, number, number][] | undefined, radius = 0.04): Vec2 {
  if (!protect?.length) return p;
  let best: Vec2 | null = null;
  let bd = radius;
  for (const [x, y, w, h] of protect) {
    // anchor at the lower-middle of a face box: roughly where the mouth is
    const c: Vec2 = [x + w / 2, y + h * 0.72];
    const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best ?? p;
}
