// Model download: tape running from a full supply reel over two guide rollers and a head onto a
// take-up spool (the tape in the run is the lit part), mounted on an upright deck beside a small
// cabinet of drawers, the local cache, with one drawer half open.
import { k, G, WIDTH, HEIGHT, write, halo } from "./common.mjs";

const PLATE = { x: -134, y: -62, w: 254, d: 116, r: 8 };
const PLATE_H = 10;
const FOOT_H = 5;

// Deck: an upright panel facing +y.
const DECK = { x: -122, y: -42, w: 126, d: 10, r: 1.2 };
const DECK_TOP = 112;
const FACE = DECK.y + DECK.d; // front face, y
const TAPE = [5.2, 11.2]; // tape lies between these offsets from the face
const SUPPLY = { c: [-92, 80], R: 25, pack: 21 };
const TAKEUP = { c: [-32, 80], R: 25, pack: 12 };
const ROLLERS = [{ c: [-78, 40], r: 4 }, { c: [-46, 40], r: 4 }];

const CAB = { x: 28, y: -44, w: 78, d: 76, r: 2 };
const CAB_Z = 4;
const CAB_TOP = 62;
const CAB_FRONT = CAB.y + CAB.d;
const OPEN = 26;

const P = k.fitProjection(
  [...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0), ...k.boxCorners(DECK, 0, DECK_TOP), ...k.boxCorners(CAB, 0, CAB_TOP)],
  WIDTH,
  HEIGHT,
  { pad: 22, azimuth: 45 },
);

const at = (p) => k.iso(p, P);
const S = (paths, style = {}) => k.solidSvg(paths, style);
const L = (d, style = {}) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
const frameAt = ([x, z]) => G.frameOf([x, FACE, z], [0, 1, 0], [1, 0, 0], [0, 0, 1]);
const onFaceY = (y, x0, z0, x1, z1, r) => k.pathOf(k.roundedPlan({ x: x0, y: z0, w: x1 - x0, d: z1 - z0, r }, 4).map(([u, z]) => at([u, y, z])), true);

const out = [];
const halos = [halo(k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P))];

// --- Bench plate --------------------------------------------------------------------------
for (const [x, y] of byDepth(k.corners(PLATE, 20))) {
  out.push(S(k.cylinder(x, y, 7, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
  out.push(S(k.cylinder(x, y, 5.4, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }));
}
out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), { tone: "mid" }));
out.push(L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }));
{
  const screws = k.corners(PLATE, 10);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5, tone: "mid" }));
  const strip = { x: -118, y: PLATE.y + PLATE.d - 14, w: 112, d: 7, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 4, 5, strip.y + 0.8, 0.6, [2, 3.6], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(D([at([strip.x + 2, strip.y + 3.5, 0.6]), at([strip.x + strip.w - 2, strip.y + 3.5, 0.6])], { size: 0.45, tone: "mid" }));
}

// --- Deck: foot bar, panel, panel details ---------------------------------------------------
out.push(S(k.slabOf({ x: DECK.x - 4, y: DECK.y - 6, w: DECK.w + 8, d: 26, r: 2 }, 0, 6, P, 3, 0.6), { tone: "mid" }));
out.push(D([[DECK.x, FACE + 9], [DECK.x + DECK.w, FACE + 9]].map(([x, y]) => at([x, y, 6])), { size: 0.5, tone: "mid" }));
out.push(S(k.slabOf(DECK, 6, DECK_TOP - 6, P, 2, 0.8), { tone: "mid" }));
{
  const inset = [DECK.x + 5, 11, DECK.x + DECK.w - 5, DECK_TOP - 5];
  out.push(L(onFaceY(FACE, ...inset, 2), { tone: "faint" }));
  out.push(D([[inset[0] + 3, inset[1] + 3], [inset[2] - 3, inset[1] + 3], [inset[0] + 3, inset[3] - 3], [inset[2] - 3, inset[3] - 3]].map(([x, z]) => at([x, FACE, z])), { size: 0.5, tone: "mid" }));
  // Counter window and three transport keys along the bottom of the panel.
  out.push(L(onFaceY(FACE, DECK.x + 12, 16, DECK.x + 36, 24, 1), { tone: "lo" }));
  out.push(L([0, 1, 2, 3].map((i) => k.pathOf([at([DECK.x + 15.5 + i * 5.5, FACE, 16]), at([DECK.x + 15.5 + i * 5.5, FACE, 24])])).join(""), { tone: "faint" }));
  for (let i = 0; i < 3; i++) {
    const x = DECK.x + 70 + i * 12;
    out.push(S(k.slabOf({ x, y: FACE, w: 9, d: 2.4, r: 0.8 }, 15, 8, P, 3, 0.4), { tone: i === 1 ? "hi" : "mid" }));
  }
}

// --- Reels, rollers, head and the tape run ---------------------------------------------------
function reelBack({ c, R, pack }) {
  const F = frameAt(c);
  return [
    S(G.disc(0, 3.6, 4, F, P), { tone: "mid" }),
    S(G.disc(3.6, TAPE[0], R, F, P, { steps: 36 }), { tone: "mid" }),
    S(G.disc(TAPE[0], TAPE[1], pack, F, P, { steps: 36 }), { tone: "lo" }),
    `<path d="${G.circleOf(F, TAPE[1], pack, P, 36)}" style="fill:#cfcfd2;stroke:none"/>`,
    L(G.circleOf(F, TAPE[1], pack, P, 36) + G.circleOf(F, TAPE[1], pack * 0.72, P, 36) + G.circleOf(F, TAPE[1], pack * 0.45, P, 28), { tone: "lo" }),
  ].join("");
}
function reelFront({ c, R }) {
  const F = frameAt(c);
  // Front flange rim: a flat ring (evenodd), so the tape pack shows between the spokes.
  const outer = G.circleOf(F, TAPE[1] + 1.2, R, P, 48);
  const innerC = G.circleOf(F, TAPE[1] + 1.2, R - 3.4, P, 40);
  const parts = [`<path class="iso-top" fill-rule="evenodd" d="${outer}${innerC}"/>`, L(outer, { tone: "hi" }), L(innerC, { tone: "lo" })];
  for (const a of [Math.PI / 2, Math.PI / 2 + (2 * Math.PI) / 3, Math.PI / 2 + (4 * Math.PI) / 3]) {
    const [ca, sa] = [Math.cos(a), Math.sin(a)];
    const w = 2.2;
    const poly = [[5 * ca - w * sa, 5 * sa + w * ca], [(R - 3) * ca - w * sa, (R - 3) * sa + w * ca], [(R - 3) * ca + w * sa, (R - 3) * sa - w * ca], [5 * ca + w * sa, 5 * sa - w * ca]];
    parts.push(S(G.prismOf(F, poly, TAPE[1], TAPE[1] + 1.2, P), { tone: "mid", crease: "none" }));
  }
  parts.push(S(G.disc(TAPE[1], TAPE[1] + 3, 6, F, P), { tone: "hi", crease: "lo" }));
  parts.push(D(G.dotsOf(F, TAPE[1] + 3, 3.6, 3, P, { all: true, phase: Math.PI / 6 }), { size: 0.55, tone: "hi" }));
  parts.push(L(G.circleOf(F, TAPE[1] + 3, 1.6, P), { tone: "lo" }));
  return parts.join("");
}
const rollerBody = ({ c, r }) => {
  const F = frameAt(c);
  return S(G.disc(0, TAPE[0] - 0.6, 2.2, F, P), { tone: "mid" }) + S(G.disc(TAPE[0] - 0.6, TAPE[0], r + 1.6, F, P), { tone: "mid" }) + S(G.disc(TAPE[0], TAPE[1], r, F, P), { tone: "hi", crease: "lo" });
};
const rollerFront = ({ c, r }) => {
  const F = frameAt(c);
  return S(G.disc(TAPE[1], TAPE[1] + 0.6, r + 1.6, F, P), { tone: "mid" }) + L(G.circleOf(F, TAPE[1] + 0.6, 1.2, P), { tone: "lo" });
};

// Tape route: outer tangents round supply pack → roller → roller → take-up pack (along the bottom).
const circles = [{ c: SUPPLY.c, r: SUPPLY.pack }, ...ROLLERS, { c: TAKEUP.c, r: TAKEUP.pack }];
const mid = circles.reduce((m, { c }) => [m[0] + c[0] / circles.length, m[1] + c[1] / circles.length], [0, 0]);
function tangent(a, b) {
  const d = [b.c[0] - a.c[0], b.c[1] - a.c[1]];
  const len = Math.hypot(...d);
  const u = [d[0] / len, d[1] / len];
  const cos = (a.r - b.r) / len;
  const sin = Math.sqrt(1 - cos * cos);
  const options = [1, -1].map((s) => [u[0] * cos - s * u[1] * sin, u[1] * cos + s * u[0] * sin]);
  const centre = [(a.c[0] + b.c[0]) / 2, (a.c[1] + b.c[1]) / 2];
  const n = options.sort((p, q) => p[0] * (mid[0] - centre[0]) + p[1] * (mid[1] - centre[1]) - (q[0] * (mid[0] - centre[0]) + q[1] * (mid[1] - centre[1])))[0];
  return [[a.c[0] + a.r * n[0], a.c[1] + a.r * n[1]], [b.c[0] + b.r * n[0], b.c[1] + b.r * n[1]]];
}
const legs = circles.slice(1).map((b, i) => tangent(circles[i], b));
const route = [legs[0][0]];
legs.forEach((leg, i) => {
  route.push(leg[1]);
  const next = legs[i + 1];
  if (!next) return;
  // Wrap the roller between leg i's end and leg i+1's start, the short way round under it.
  const { c, r } = circles[i + 1];
  let a0 = Math.atan2(leg[1][1] - c[1], leg[1][0] - c[0]);
  let a1 = Math.atan2(next[0][1] - c[1], next[0][0] - c[0]);
  while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
  while (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
  for (let j = 1; j < 8; j++) {
    const t = a0 + ((a1 - a0) * j) / 8;
    route.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  route.push(next[0]);
});
const tapeEdge = (y) => route.map(([x, z]) => at([x, y, z]));
const ribbon = k.pathOf([...tapeEdge(FACE + TAPE[0] + 0.3), ...tapeEdge(FACE + TAPE[1] - 0.3).reverse()], true);
const ribbonEdge = k.pathOf(tapeEdge(FACE + TAPE[1] - 0.3));

// Head block under the run, between the rollers.
const HEAD = { x: -69, y: FACE, w: 14, d: 15, r: 1.2 };
const tapeLow = ROLLERS[0].c[1] - ROLLERS[0].r;
out.push(S(k.slabOf({ x: HEAD.x - 3, y: FACE, w: HEAD.w + 6, d: 4, r: 0.6 }, tapeLow - 14, 6, P, 2, 0.4), { tone: "mid" }));
out.push(S(k.slabOf(HEAD, tapeLow - 9, 9 - 0.6, P, 3, 0.5), { tone: "hi", crease: "lo" }));
out.push(L(k.lineOnTop([HEAD.x + HEAD.w / 2, HEAD.y], [HEAD.x + HEAD.w / 2, HEAD.y + HEAD.d], tapeLow - 0.6, P), { tone: "lo" }));

out.push(reelBack(SUPPLY), reelBack(TAKEUP));
for (const roller of ROLLERS) out.push(rollerBody(roller));
out.push(`<path d="${ribbon}" style="fill:#d2452f;fill-opacity:.9;stroke:none"/>`);
out.push(L(ribbon, { tone: "lit" }), L(ribbonEdge, { tone: "lit" }));
for (const roller of ROLLERS) out.push(rollerFront(roller));
out.push(reelFront(SUPPLY), reelFront(TAKEUP));

// --- Cabinet of drawers (the cache) ----------------------------------------------------------
{
  out.push(S(k.slabOf(k.insetPlan(CAB, 3), 0, CAB_Z, P, 3), { tone: "lo" }));
  out.push(S(k.slabOf(CAB, CAB_Z, CAB_TOP - CAB_Z, P, 3, 1), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(CAB, 4), CAB_TOP, P, 3), { tone: "faint" }));
  // Side panel: an inset outline on the +x face with four screws, and a carry handle.
  {
    const x = CAB.x + CAB.w;
    const ring = k.roundedPlan({ x: CAB.y + 6, y: CAB_Z + 6, w: CAB.d - 12, d: CAB_TOP - CAB_Z - 12, r: 2 }, 4).map(([u, z]) => at([x, u, z]));
    out.push(L(k.pathOf(ring, true), { tone: "faint" }));
    out.push(D([[CAB.y + 9, CAB_Z + 9], [CAB.y + CAB.d - 9, CAB_Z + 9], [CAB.y + 9, CAB_TOP - 9], [CAB.y + CAB.d - 9, CAB_TOP - 9]].map(([y, z]) => at([x, y, z])), { size: 0.5, tone: "mid" }));
    const hy = CAB.y + CAB.d / 2;
    out.push(S(k.slabOf({ x, y: hy - 11, w: 2, d: 3, r: 0.6 }, CAB_TOP - 20, 4, P, 2), { tone: "mid", crease: "none" }));
    out.push(S(k.slabOf({ x, y: hy + 8, w: 2, d: 3, r: 0.6 }, CAB_TOP - 20, 4, P, 2), { tone: "mid", crease: "none" }));
    out.push(S(k.slabOf({ x: x + 2, y: hy - 11, w: 2.4, d: 22, r: 1 }, CAB_TOP - 20, 4, P, 3), { tone: "hi", crease: "lo" }));
  }
  out.push(D(k.corners(CAB, 2.2).map(([x, y]) => at([x, y, CAB_TOP])), { size: 0.45, tone: "mid" }));
  // A spare reel lying on the cabinet top.
  {
    const [x, y] = [CAB.x + 40, CAB.y + 34];
    out.push(S(k.cylinder(x, y, 17, CAB_TOP, 1, P, 48), { tone: "mid" }));
    out.push(S(k.cylinder(x, y, 13, CAB_TOP + 1, 5, P, 48), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 17, CAB_TOP + 6, 1, P, 48, 0.4), { tone: "mid" }));
    out.push(L(k.ring(x, y, 6, CAB_TOP + 7, P, 32) + k.ring(x, y, 2, CAB_TOP + 7, P, 16), { tone: "lo" }));
    out.push(D([0, 2.1, 4.2].map((t) => at([x + 11 * Math.cos(t), y + 11 * Math.sin(t), CAB_TOP + 7])), { size: 0.6, tone: "mid" }));
  }
  // Drawer grid on the front face: 3 rows × 2 columns.
  const cols = [[CAB.x + 4, CAB.x + 38], [CAB.x + 40, CAB.x + CAB.w - 4]];
  const rows = [[CAB_Z + 4, CAB_Z + 20], [CAB_Z + 22, CAB_Z + 38], [CAB_Z + 40, CAB_TOP - 4]];
  const drawerFront = (x0, x1, z0, z1, y) => {
    const parts = [S(k.slabOf({ x: x0, y, w: x1 - x0, d: 1.6, r: 0.6 }, z0, z1 - z0, P, 2, 0.4), { tone: "mid" })];
    const cx = (x0 + x1) / 2;
    // Label holder (a card in a frame) above the pull.
    parts.push(L(onFaceY(y + 1.6, cx - 7, z1 - 8.4, cx + 7, z1 - 3.4, 0.6), { tone: "lo" }));
    parts.push(L(k.pathOf([at([cx - 4.5, y + 1.6, z1 - 5.9]), at([cx + 3, y + 1.6, z1 - 5.9])]), { tone: "faint", free: true }));
    parts.push(S(k.slabOf({ x: cx - 6, y: y + 1.6, w: 12, d: 2, r: 0.9 }, z0 + 4.4, 2.2, P, 3), { tone: "hi", crease: "lo" }));
    parts.push(D([at([x0 + 2.4, y + 1.6, (z0 + z1) / 2]), at([x1 - 2.4, y + 1.6, (z0 + z1) / 2])], { size: 0.45, tone: "mid" }));
    return parts.join("");
  };
  const open = [1, 1]; // column, row of the half-open drawer
  for (let c = 0; c < 2; c++) for (let r = 0; r < 3; r++) if (!(c === open[0] && r === open[1])) out.push(drawerFront(...cols[c], ...rows[r], CAB_FRONT));
  // The open drawer: dark opening, then its box (floor, walls), the stored cards, the front.
  const [x0, x1] = cols[open[0]];
  const [z0, z1] = rows[open[1]];
  out.push(`<path class="iso-shade" data-shade="0" d="${onFaceY(CAB_FRONT, x0, z0, x1, z1, 0.6)}"/>`);
  out.push(L(onFaceY(CAB_FRONT, x0, z0, x1, z1, 0.6), { tone: "lo" }));
  const box = { x: x0 + 1.6, y: CAB_FRONT, w: x1 - x0 - 3.2, d: OPEN, r: 0.4 };
  out.push(S(k.slabOf(box, z0 + 1, 1.2, P, 2), { tone: "lo" }));
  out.push(S(k.slabOf({ x: box.x, y: box.y, w: 1.2, d: OPEN, r: 0.3 }, z0 + 2.2, 12, P, 2), { tone: "mid" }));
  // Index cards standing in the drawer, one per cached shard, with tabs.
  for (let i = 0; i < 6; i++) {
    const y = CAB_FRONT + 2 + i * 3.6;
    out.push(S(k.slabOf({ x: box.x + 3, y, w: box.w - 6, d: 0.8, r: 0.2 }, z0 + 2.2, 10.4, P, 2), { tone: "hi", crease: "faint" }));
    const tx = box.x + 5 + (i % 3) * 9;
    out.push(S(k.slabOf({ x: tx, y, w: 6, d: 0.8, r: 0.2 }, z0 + 12.6, 2.2, P, 2), { tone: "hi", crease: "none" }));
  }
  out.push(S(k.slabOf({ x: box.x + box.w - 1.2, y: box.y, w: 1.2, d: OPEN, r: 0.3 }, z0 + 2.2, 12, P, 2), { tone: "mid" }));
  out.push(drawerFront(x0, x1, z0, z1, CAB_FRONT + OPEN));
}

write("model", {
  seed: 23,
  scale: 1.6,
  label: "Tape running from a full supply reel over guide rollers onto a take-up spool on an upright deck, beside a small cabinet of drawers with one drawer half open showing stored cards.",
  halos,
  body: out,
});
