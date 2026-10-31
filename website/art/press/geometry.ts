// Every static path of the hero figure, computed once at module load (on the server).
import {
  corners,
  cylinder,
  haloOf,
  insetPlan,
  iso,
  knurl,
  lineOnTop,
  onTop,
  pathOf,
  planOutline,
  ring,
  sideArc,
  slabOf,
  topMatrix,
  topTicks,
  type Flat,
  type Plan,
  type SolidPaths,
} from "../kit/iso-kit";
import { BUBBLES, PANELS, type UV } from "./model";
import {
  BASE,
  BASE_H,
  BRIDGE,
  BRIDGE_H,
  BRIDGE_Z,
  CAR,
  CAR_H,
  FOOT_H,
  HOLDER_H,
  HOLDER_Z,
  NIB,
  P,
  PAGE,
  PAGE_TOP,
  PEN_DX,
  PEN_R,
  PEN_TOP,
  PLATEN,
  PLATEN_H,
  PLATE_H,
  PLATE_Z,
  RAIL_D,
  RAIL_FROM,
  RAIL_H,
  RAIL_STRIP,
  RAIL_TO,
  RAIL_Y,
  TRAY_FLOOR,
  TRAY_H,
  TRAY_IN,
  TRAY_OUT,
  TRAY_WALL,
  UPRIGHT,
  at,
  onPage,
} from "./view";

const move = (plan: Plan, dx: number, dy: number): Plan => ({ ...plan, x: plan.x + dx, y: plan.y + dy });
const centreOf = (plan: Plan): [number, number] => [plan.x + plan.w / 2, plan.y + plan.d / 2];

// ---------------------------------------------------------------- base
const feet = corners(BASE, 24)
  .sort((a, b) => a[0] + a[1] - (b[0] + b[1]))
  .map(([x, y]) => [cylinder(x, y, 8, -BASE_H - FOOT_H, 1.6, P, 28), cylinder(x, y, 6.2, -BASE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28)]);
const screwsAt = corners(BASE, 11);
const RULER: Plan = { x: -150, y: BASE.y + BASE.d - 11, w: 300, d: 7, r: 1 };
const rulerTicks = topTicks(RULER.x + 4, RULER.x + RULER.w - 4, 5, 5, RULER.y + 0.8, 0.6, [2, 3.8], P);
const LABEL: Plan = { x: BASE.x + BASE.w - 15, y: -42, w: 10, d: 84, r: 1.2 };

export const BASE_ART = {
  halo: haloOf(BASE, -BASE_H - FOOT_H, BASE_H, P),
  feet,
  slab: slabOf(BASE, -BASE_H, BASE_H, P, 8, 1.8),
  groove: planOutline(insetPlan(BASE, 5), 0, P),
  screwRings: screwsAt.map(([x, y]) => ring(x, y, 2.4, 0, P, 16)).join(""),
  screws: screwsAt.map(([x, y]) => at([x, y, 0])),
  ruler: slabOf(RULER, 0, 0.6, P, 3),
  rulerMinor: rulerTicks.minor,
  rulerMajor: rulerTicks.major,
  rulerScrews: [at([RULER.x + 2, RULER.y + 3.5, 0.6]), at([RULER.x + RULER.w - 2, RULER.y + 3.5, 0.6])],
  label: slabOf(LABEL, 0, 0.8, P, 3),
  labelText: topMatrix([LABEL.x + LABEL.w / 2 + 1.4, LABEL.y + LABEL.d / 2], 0.8, P, "y"),
  labelScrews: [at([LABEL.x + LABEL.w / 2, LABEL.y + 3, 0.8]), at([LABEL.x + LABEL.w / 2, LABEL.y + LABEL.d - 3, 0.8])],
};

// ---------------------------------------------------------------- rails (far rail is drawn early, near rail with the base too)
function railOf(y: number) {
  const plan: Plan = { x: RAIL_FROM, y: y - RAIL_D / 2, w: RAIL_TO - RAIL_FROM, d: RAIL_D, r: 1 };
  const stops = [RAIL_FROM - 6, RAIL_TO].map((x) => slabOf({ x, y: y - 7, w: 6, d: 14, r: 1.2 }, 0, 9, P, 3, 0.5));
  const screws = [-120, -60, 0, 60, 120].map((x) => at([x, y, RAIL_H]));
  const stopScrews = [RAIL_FROM - 3, RAIL_TO + 3].flatMap((x) => [at([x, y - 4, 9]), at([x, y + 4, 9])]);
  return { rail: slabOf(plan, 0, RAIL_H, P, 3, 0.4), stops, screws, stopScrews, groove: lineOnTop([RAIL_FROM, y], [RAIL_TO, y], RAIL_H, P) };
}
export const RAILS = { far: railOf(-RAIL_Y), near: railOf(RAIL_Y) };

// ---------------------------------------------------------------- bed: platen, page, clips
const clipPlans: Plan[] = corners(PAGE, 0).map(([x, y]) => ({ x: x - 4, y: y - 4, w: 8, d: 8, r: 1 }));
export const BED = {
  halo: haloOf(insetPlan(PLATEN, 2), 0, 1, P),
  platen: slabOf(PLATEN, 0, PLATEN_H, P, 6, 1),
  groove: planOutline(insetPlan(PLATEN, 3.5), PLATEN_H, P, 6),
  screws: corners(PLATEN, 4.5).map(([x, y]) => at([x, y, PLATEN_H])),
  page: slabOf(PAGE, PLATEN_H, PAGE_TOP - PLATEN_H, P, 2),
  clips: clipPlans
    .sort((a, b) => a.x + a.y - (b.x + b.y))
    .map((plan) => ({ body: slabOf(plan, PAGE_TOP, 1.6, P, 3, 0.3), screw: at([plan.x + 4, plan.y + 4, PAGE_TOP + 1.6]) })),
  pins: [-30, 30].map((x) => [cylinder(x, PAGE.y - 4, 2.2, PLATEN_H, 3, P, 18), x] as const).map(([paths]) => paths),
};

// ---------------------------------------------------------------- page art (panels, tone, lines, bubbles)
const PAGE_Z = PAGE_TOP + 0.05;
const uvAt = ([u, v]: UV): Flat => {
  const [x, y] = onPage(u, v);
  return iso([x, y, PAGE_Z], P);
};
const polyPath = (poly: UV[]) => pathOf(poly.map(uvAt), true);

// The part of the line p + t·d inside a convex polygon (Cyrus-Beck), or null.
function chord(poly: UV[], p: UV, d: UV): [UV, UV] | null {
  let lo = -Infinity;
  let hi = Infinity;
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const normal: UV = [sign * (b[1] - a[1]), -sign * (b[0] - a[0])]; // outward
    const num = normal[0] * (p[0] - a[0]) + normal[1] * (p[1] - a[1]);
    const den = normal[0] * d[0] + normal[1] * d[1];
    if (Math.abs(den) < 1e-12) {
      if (num > 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) hi = Math.min(hi, t);
    else lo = Math.max(lo, t);
  }
  if (lo >= hi) return null;
  return [
    [p[0] + d[0] * lo, p[1] + d[1] * lo],
    [p[0] + d[0] * hi, p[1] + d[1] * hi],
  ];
}

function inside(poly: UV[], q: UV) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

const chordPath = (poly: UV[], p: UV, d: UV) => {
  const c = chord(poly, p, d);
  return c ? pathOf([uvAt(c[0]), uvAt(c[1])]) : "";
};

// Screentone: dots on a grid in page space, kept where they fall inside the panel (with a margin).
function toneOf(poly: UV[], gap: number, keep: (q: UV) => boolean = () => true): Flat[] {
  const shrunk = shrink(poly, 0.012);
  const out: Flat[] = [];
  const stepV = gap * (PAGE.w / PAGE.d);
  for (let v = 0; v <= 1; v += stepV) {
    const row = Math.round(v / stepV);
    for (let u = (row % 2) * gap * 0.5; u <= 1; u += gap) {
      const q: UV = [u, v];
      if (inside(shrunk, q) && keep(q)) out.push(uvAt(q));
    }
  }
  return out;
}

function shrink(poly: UV[], by: number): UV[] {
  const [cu, cv] = [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  return poly.map(([u, v]) => {
    const du = u - cu;
    const dv = v - cv;
    return [u - Math.sign(du) * by, v - Math.sign(dv) * by * (PAGE.w / PAGE.d)];
  });
}

// A head-and-shoulders figure: a ring for the head, and shoulders whose ends land on the panel's bottom border.
function figureOf(poly: UV[], cu: number, headV: number, size: number) {
  const bottom = Math.max(...poly.map((p) => p[1]));
  const aspect = PAGE.w / PAGE.d;
  const head: UV[] = Array.from({ length: 28 }, (_, i) => {
    const a = (i / 28) * Math.PI * 2;
    return [cu + Math.cos(a) * size, headV + Math.sin(a) * size * aspect];
  });
  const neck = headV + size * aspect * 1.25;
  const shoulders: UV[] = [];
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = Math.PI * (1 - t);
    const u = cu + Math.cos(a) * size * 2.2;
    const v = neck + (1 - Math.sin(a)) * (bottom - neck) * 0.92;
    shoulders.push([u, i === 0 || i === steps ? bottom : v]);
  }
  return { head: pathOf(head.map(uvAt), true), shoulders: pathOf(shoulders.map(uvAt)), headPoly: head };
}

function skyline(poly: UV[], baseV: number) {
  const left = chord(poly, [0, baseV], [1, 0]);
  if (!left) return "";
  const [a, b] = left;
  const pts: UV[] = [a];
  const n = 9;
  for (let i = 1; i < n; i++) {
    const u = a[0] + ((b[0] - a[0]) * i) / n;
    const lift = [0.03, 0.06, 0.02, 0.08, 0.05, 0.035, 0.07, 0.025][i - 1];
    pts.push([u, baseV - lift]);
  }
  pts.push(b);
  return pathOf(pts.map(uvAt));
}

const [P1, P2, P3, P4, P5] = PANELS;
const fig2 = figureOf(P2, 0.68, 0.45, 0.06);
const fig4 = figureOf(P4, 0.78, 0.76, 0.065);
const outsideHead = (head: UV[]) => (q: UV) => !inside(head, q);
const below = (v0: number) => (q: UV) => q[1] > v0;

export const PANEL_ART = [
  {
    border: polyPath(P1),
    lines: [skyline(P1, 0.25), chordPath(P1, [0, 0.27], [1, 0])].join(""),
    tone: toneOf(P1, 0.028, below(0.275)),
  },
  {
    border: polyPath(P2),
    lines: [fig2.head, fig2.shoulders].join(""),
    tone: toneOf(P2, 0.03, (q) => q[0] > 0.74 || q[0] < 0.6 ? q[1] < 0.5 : false),
  },
  {
    border: polyPath(P3),
    lines: Array.from({ length: 7 }, (_, i) => chordPath(P3, [0.07, 0.36 + i * 0.045], [1, 0.42])).join(""),
    tone: [] as Flat[],
  },
  {
    border: polyPath(P4),
    lines: [fig4.head, fig4.shoulders].join(""),
    tone: toneOf(P4, 0.026, outsideHead(fig4.headPoly)).filter((_, i) => i % 1 === 0),
  },
  {
    border: polyPath(P5),
    lines: Array.from({ length: 6 }, (_, i) => chordPath(P5, [0.07, 0.68 + i * 0.045], [1, -0.08])).join(""),
    tone: [] as Flat[],
  },
];

// Bubbles: an ellipse with a tail, drawn as one closed outline so no line ends in the air.
function bubbleOf({ at: [cu, cv], r: [ru, rv], tail }: (typeof BUBBLES)[number]) {
  const aspect = PAGE.w / PAGE.d;
  const ry = rv;
  const tailAngle = Math.atan2((tail[1] - cv) / ry, (tail[0] - cu) / ru);
  const spread = 0.28;
  const pts: UV[] = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const a = tailAngle + spread + (i / n) * (Math.PI * 2 - spread * 2);
    pts.push([cu + Math.cos(a) * ru, cv + Math.sin(a) * ry]);
  }
  pts.push(tail);
  void aspect;
  const textLines = [-0.35, 0.05, 0.45].map((k, i) => {
    const half = ru * (i === 2 ? 0.42 : 0.6) * Math.sqrt(1 - k * k);
    return pathOf([uvAt([cu - half, cv + k * ry]), uvAt([cu + half, cv + k * ry])]);
  });
  return { outline: pathOf(pts.map(uvAt), true), text: textLines.join("") };
}
export const BUBBLE_ART = BUBBLES.map(bubbleOf);

// ---------------------------------------------------------------- trays
function trayOf(plan: Plan, sheets: number) {
  const z0 = 0;
  const floor = slabOf(plan, z0, TRAY_FLOOR, P, 4, 0.4);
  const w = TRAY_WALL;
  const back: Plan[] = [
    { x: plan.x, y: plan.y, w: plan.w, d: w, r: 0.6 },
    { x: plan.x, y: plan.y + w, w, d: plan.d - w * 2, r: 0.6 },
  ];
  const front: Plan[] = [
    { x: plan.x + plan.w - w, y: plan.y + w, w, d: plan.d - w * 2, r: 0.6 },
    { x: plan.x, y: plan.y + plan.d - w, w: plan.w, d: w, r: 0.6 },
  ];
  const sheetPlans = Array.from({ length: sheets }, (_, i) => ({ x: plan.x + 6 + i * 0.8, y: plan.y + 6 - i * 0.6, w: plan.w - 13, d: plan.d - 12, r: 0.4 }));
  const sheetPaths = sheetPlans.map((sheet, i) => slabOf(sheet, TRAY_FLOOR + i * 0.7, 0.7, P, 2));
  const top = sheetPlans[sheetPlans.length - 1];
  const topZ = TRAY_FLOOR + sheets * 0.7;
  return {
    halo: haloOf(insetPlan(plan, 2), 0, 1, P),
    floor,
    back: back.map((p) => slabOf(p, TRAY_FLOOR, TRAY_H - TRAY_FLOOR, P, 3, 0.3)),
    front: front.map((p) => slabOf(p, TRAY_FLOOR, TRAY_H - TRAY_FLOOR, P, 3, 0.3)),
    sheets: sheetPaths,
    top,
    topZ,
    screws: corners(plan, 1).map(([x, y]) => at([x, y, TRAY_H])),
  };
}

const trayIn = trayOf(TRAY_IN, 3);
const trayOut = trayOf(TRAY_OUT, 2);

// The story: printed lines across the top script sheet (rule lines standing for text end free).
const textLines = (() => {
  const s = trayIn.top;
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const y = s.y + 7 + i * 4.6;
    if (y > s.y + s.d - 5) break;
    const short = i % 4 === 3 ? 0.55 : i % 3 === 1 ? 0.85 : 0.95;
    out.push(lineOnTop([s.x + s.w - 5, y], [s.x + s.w - 5 - (s.w - 10) * short, y], trayIn.topZ, P));
  }
  return out.join("");
})();

// A finished page: a small panel grid on the top sheet of the out-tray.
const finishedGrid = (() => {
  const s = trayOut.top;
  const page = (u: number, v: number): [number, number] => [s.x + s.w - u * s.w, s.y + v * s.d];
  return PANELS.map((poly) => onTop(poly.map(([u, v]) => page(u, v)), trayOut.topZ, P, true)).join("");
})();

export const TRAYS = {
  in: { ...trayIn, text: textLines },
  out: { ...trayOut, grid: finishedGrid },
};

// ---------------------------------------------------------------- gantry (built at gx = 0, moved with a transform)
const RIDE = RAIL_H;
function carriageOf(y: number, knob: boolean) {
  const plan = move(CAR, 0, y);
  const bush = [-9, 9].map((dx) => slabOf({ x: dx - 3.5, y: y - 9.5, w: 7, d: 19, r: 1 }, RIDE - 1.2, 1.4, P, 3, 0.3));
  return {
    halo: haloOf(insetPlan(plan, 2), RIDE, 0.2, P),
    bush,
    body: slabOf(plan, RIDE, CAR_H, P, 4, 0.6),
    seam: lineOnTop([plan.x + 4, plan.y], [plan.x + 4, plan.y + plan.d], RIDE + CAR_H, P) + lineOnTop([plan.x + plan.w - 4, plan.y], [plan.x + plan.w - 4, plan.y + plan.d], RIDE + CAR_H, P),
    screws: corners(plan, 2.2).map(([x, yy]) => at([x, yy, RIDE + CAR_H])),
    upright: slabOf(move(UPRIGHT, 0, y), RIDE + CAR_H, BRIDGE_Z - RIDE - CAR_H, P, 3, 0.5),
    uprightSlot: lineOnTop([UPRIGHT.x + 3, y], [UPRIGHT.x + UPRIGHT.w - 3, y], BRIDGE_Z, P),
    knob: knob
      ? {
          body: cylinder(8.5, y + 2, 3.2, RIDE + CAR_H, 4.5, P, 24),
          knurl: knurl(8.5, y + 2, 3.2, RIDE + CAR_H, RIDE + CAR_H + 4.5, 22, P),
          mark: lineOnTop([8.5, y + 2], [11.2, y + 2], RIDE + CAR_H + 4.5, P),
        }
      : null,
  };
}

export const GANTRY = {
  far: carriageOf(-RAIL_Y, false),
  near: carriageOf(RAIL_Y, true),
  bridge: slabOf(BRIDGE, BRIDGE_Z, BRIDGE_H, P, 3, 0.8),
  bridgeGroove: lineOnTop([0, BRIDGE.y + 4], [0, BRIDGE.y + BRIDGE.d - 4], BRIDGE_Z + BRIDGE_H, P),
  bridgeScrews: [-100, -50, 0, 50, 100].flatMap((y) => [at([-3, y, BRIDGE_Z + BRIDGE_H]), at([3, y, BRIDGE_Z + BRIDGE_H])]),
  strip: slabOf(RAIL_STRIP, BRIDGE_Z + 2.5, 4, P, 2),
  stripScrews: [-90, -45, 0, 45, 90].map((y) => at([RAIL_STRIP.x + RAIL_STRIP.w, y, BRIDGE_Z + 4.5])),
};

// ---------------------------------------------------------------- pen head (built at hy = 0, pen down)
const PLATE: Plan = { x: RAIL_STRIP.x + RAIL_STRIP.w, y: -11, w: 3.4, d: 22, r: 0.8 };
const HOLDER: Plan = { x: PLATE.x + PLATE.w, y: -6.5, w: PEN_DX - PLATE.x - PLATE.w + 6.5, d: 13, r: 1.6 };
const TIP = PAGE_TOP + 0.3;
const SOLENOID: Plan = { x: PLATE.x + PLATE.w, y: 4, w: 6, d: 6.5, r: 1.2 };
export const HEAD = {
  plate: slabOf(PLATE, PLATE_Z, PLATE_H, P, 3, 0.3),
  plateScrews: [
    at([PLATE.x + PLATE.w, PLATE.y + 2.5, PLATE_Z + PLATE_H - 2.5]),
    at([PLATE.x + PLATE.w, PLATE.y + PLATE.d - 2.5, PLATE_Z + PLATE_H - 2.5]),
  ],
  solenoid: slabOf(SOLENOID, PLATE_Z + 12, 12, P, 3, 0.5),
  solenoidTop: ring(SOLENOID.x + SOLENOID.w / 2, SOLENOID.y + SOLENOID.d / 2, 1.6, PLATE_Z + 24, P, 14),
  nib: cylinder(PEN_DX, 0, 0.9, TIP, NIB, P, 14),
  cone: cylinder(PEN_DX, 0, 1.8, TIP + NIB - 1.2, 1.4, P, 18),
  barrel: cylinder(PEN_DX, 0, PEN_R, TIP + NIB, HOLDER_Z - TIP - NIB, P, 28),
  grip: [TIP + NIB + 4, TIP + NIB + 7, TIP + NIB + 10].map((z) => sideArc(PEN_DX, 0, PEN_R, z, P, 16)).join(""),
  holder: slabOf(HOLDER, HOLDER_Z, HOLDER_H, P, 4, 0.5),
  holderSeam: lineOnTop([HOLDER.x + 2, HOLDER.y], [HOLDER.x + 2, HOLDER.y + HOLDER.d], HOLDER_Z + HOLDER_H, P),
  holderScrews: [at([HOLDER.x + HOLDER.w - 2.2, HOLDER.y + 2.2, HOLDER_Z + HOLDER_H]), at([HOLDER.x + HOLDER.w - 2.2, HOLDER.y + HOLDER.d - 2.2, HOLDER_Z + HOLDER_H])],
  upper: cylinder(PEN_DX, 0, PEN_R, HOLDER_Z + HOLDER_H, PEN_TOP - HOLDER_Z - HOLDER_H - 4, P, 28),
  cap: cylinder(PEN_DX, 0, PEN_R + 0.5, PEN_TOP - 4, 4, P, 28, 0.4),
  capRing: sideArc(PEN_DX, 0, PEN_R + 0.5, PEN_TOP - 2, P, 16),
};

export const BRIDGE_CENTRE = centreOf(BRIDGE);
export type { SolidPaths };
