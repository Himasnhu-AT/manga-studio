// "First project": a stack of blank manga pages on a desk with a cutting mat. The top page
// carries a panel grid with one diagonal gutter; a black binder clip holds the stack, and a
// pencil and an eraser lie beside it. Lit part: the first panel's outline.
//   node app/art/onboarding/project.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as G from "./kit/lathe.mjs";
import { tubePieces, tubeSvg } from "./kit/tube.mjs";
import { WIDTH, HEIGHT, PAD, figure, write, S, L, D } from "./common-b.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../../src/assets/onboarding/project.svg");

const DESK = { x: -48, y: -57, w: 116, d: 134, r: 6 };
const DESK_H = 9;
const MAT = { x: -44, y: -53, w: 108, d: 126, r: 3 };
const MAT_H = 0.8;

const PAGE = { x: -38, y: -49, w: 66, d: 92 };
const SHEET_H = 1.1;
const TURNS = [-3, 1.6, -1.2, 2.2, -2, 1, -0.6, 0]; // degrees, bottom to top
const SHIFTS = [[1.2, -0.8], [-1, 0.6], [0.8, 1], [-0.6, -0.4], [0.9, -0.6], [-0.5, 0.4], [0.3, 0.5], [0, 0]];
const ZT = MAT_H + SHEET_H * TURNS.length;

const P = k.fitProjection([...k.boxCorners(DESK, -DESK_H - 4, 0), [PAGE.x, PAGE.y, ZT + 6]], WIDTH, HEIGHT, { pad: PAD, azimuth: 45 });
const at = (p) => k.iso(p, P);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));

const rotRect = ({ x, y, w, d }, deg, [dx, dy] = [0, 0], r = 0.8) => {
  const cx = x + w / 2, cy = y + d / 2, a = (deg * Math.PI) / 180;
  return k.roundedPlan({ x: -w / 2, y: -d / 2, w, d, r }, 2).map(([px, py]) => [cx + dx + px * Math.cos(a) - py * Math.sin(a), cy + dy + px * Math.sin(a) + py * Math.cos(a)]);
};

// ---------- desk and cutting mat ----------
function desk() {
  const out = [];
  for (const [x, y] of byDepth(k.corners(DESK, 12))) {
    out.push(S(k.cylinder(x, y, 5, -DESK_H - 4, 1.4, P, 24), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 3.8, -DESK_H - 2.6, 2.6, P, 24), { tone: "mid" }));
  }
  out.push(S(k.slabOf(DESK, -DESK_H, DESK_H, P, 8, 1.4), { tone: "mid", inner: L(k.sideSeam(DESK, -DESK_H + 3, P, 8), { tone: "faint" }) }));
  // cutting mat with a grid, ruler ticks on two edges
  out.push(S(k.slabOf(MAT, 0, MAT_H, P, 3, 0.4), { tone: "lo", crease: "faint" }));
  const grid = [];
  for (let x = MAT.x + 10; x < MAT.x + MAT.w - 4; x += 10) grid.push(k.lineOnTop([x, MAT.y + 5], [x, MAT.y + MAT.d], MAT_H, P));
  for (let y = MAT.y + 10; y < MAT.y + MAT.d - 4; y += 10) grid.push(k.lineOnTop([MAT.x + 5, y], [MAT.x + MAT.w, y], MAT_H, P));
  out.push(L(grid.join(""), { tone: "faint" }));
  out.push(L(k.lineOnTop([MAT.x + 5, MAT.y], [MAT.x + 5, MAT.y + MAT.d], MAT_H, P) + k.lineOnTop([MAT.x, MAT.y + 5], [MAT.x + MAT.w, MAT.y + 5], MAT_H, P), { tone: "lo" }));
  const tx = k.topTicks(MAT.x + 5, MAT.x + MAT.w - 2, 2, 5, MAT.y, MAT_H, [1.6, 3.2], P, "x");
  const ty = k.topTicks(MAT.y + 5, MAT.y + MAT.d - 2, 2, 5, MAT.x, MAT_H, [1.6, 3.2], P, "y");
  out.push(L(tx.minor + ty.minor, { tone: "lo", free: "end" }), L(tx.major + ty.major, { tone: "mid", free: "end" }));
  return out.join("");
}

// ---------- the page stack and the top page's grid ----------
function stack() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PAGE, MAT_H, 0.1, P)}" style="opacity:.6"/>`];
  TURNS.forEach((deg, i) => {
    const ring = rotRect(PAGE, deg, SHIFTS[i]);
    out.push(S(k.extrude(ring, MAT_H + i * SHEET_H, SHEET_H, P), { tone: i === TURNS.length - 1 ? "hi" : "mid", crease: "faint" }));
  });
  // manuscript trim frame
  out.push(L(k.planOutline({ x: PAGE.x + 3, y: PAGE.y + 3, w: PAGE.w - 6, d: PAGE.d - 6, r: 0 }, ZT, P, 1), { tone: "faint" }));
  // panel grid inside the inner frame
  const X0 = PAGE.x + 6, Y0 = PAGE.y + 8, W = PAGE.w - 12, H = PAGE.d - 16, g = 2.4;
  const poly = (pts) => k.onTop(pts.map(([u, v]) => [X0 + u, Y0 + v]), ZT, P, true);
  const r1 = 26, r2 = 56;
  const panels = [
    [[0, r1 + g], [34, r1 + g], [24, r2], [0, r2]],
    [[34 + g, r1 + g], [W, r1 + g], [W, r2], [24 + g, r2]],
    [[0, r2 + g], [22, r2 + g], [22, H], [0, H]],
    [[22 + g, r2 + g], [W, r2 + g], [W, H], [22 + g, H]],
  ];
  out.push(L(panels.map(poly).join(""), { tone: "hi" }));
  // a few faint pencil roughs in the lower panels (blue-line style sketch guides)
  out.push(L(k.onTop([[X0 + 30, Y0 + r2 + 10], [X0 + 46, Y0 + r2 + 8]], ZT, P) + k.onTop([[X0 + 6, Y0 + r1 + 12], [X0 + 18, Y0 + r1 + 18]], ZT, P), { tone: "faint", free: true }));
  // the lit first panel
  out.push(`<path class="iso-line" data-tone="lit" style="stroke-width:1.3px" d="${poly([[0, 0], [W, 0], [W, r1], [0, r1]])}"/>`);
  return out.join("");
}

// ---------- binder clip on the +x edge ----------
const CLIP_X = PAGE.x + PAGE.w;
const CLIP_Y = PAGE.y + 26;
const CLIP_HALF = 8;
function clip() {
  const F = G.frameOf([CLIP_X, CLIP_Y, 0], [0, 1, 0], [1, 0, 0], [0, 0, 1]);
  const out = [];
  // jaw lip on top of the stack
  out.push(S(G.prismOf(F, [[-6, ZT], [0, ZT], [0, ZT + 1.1], [-6, ZT + 0.6]], -CLIP_HALF, CLIP_HALF, P), { tone: "hi", crease: "lo" }));
  // body: trapezoid from the paper edge to the spine
  out.push(S(G.prismOf(F, [[0, MAT_H], [7.5, MAT_H], [7.5, ZT + 4.6], [0, ZT + 1.1]], -CLIP_HALF, CLIP_HALF, P), { tone: "hi", crease: "lo" }));
  out.push(L(k.segment([CLIP_X + 7.5, CLIP_Y + CLIP_HALF, MAT_H + 1.2], [CLIP_X + 7.5, CLIP_Y - CLIP_HALF, MAT_H + 1.2], P), { tone: "mid" }));
  return `<g class="ob-dark">${out.join("")}</g>`;
}
function handles() {
  const out = [];
  const pivot = ZT + 3.9, u = 6.8;
  const route = G.fillet([
    [CLIP_X + u, CLIP_Y - CLIP_HALF - 0.5, pivot],
    [CLIP_X + u + 3, CLIP_Y - CLIP_HALF - 0.5, pivot - 0.4],
    [CLIP_X + 20, CLIP_Y - CLIP_HALF + 1.5, MAT_H + 0.5],
    [CLIP_X + 20, CLIP_Y + CLIP_HALF - 1.5, MAT_H + 0.5],
    [CLIP_X + u + 3, CLIP_Y + CLIP_HALF + 0.5, pivot - 0.4],
    [CLIP_X + u, CLIP_Y + CLIP_HALF + 0.5, pivot],
  ], 2.2, 8);
  // far leg behind the clip body, the rest in front
  const pieces = tubePieces(route, 0.5, P, { maxLength: 6 });
  const svgOf = (list) => list.sort((a, b) => k.depthOf(a.mid, P) - k.depthOf(b.mid, P)).map((piece) => tubeSvg(piece, { tone: "hi" })).join("");
  const behind = (piece) => piece.mid[1] < CLIP_Y - CLIP_HALF + 1 && piece.mid[0] < CLIP_X + 9;
  return { back: svgOf(pieces.filter(behind)), front: svgOf(pieces.filter((piece) => !behind(piece))) };
}

// ---------- pencil ----------
function pencil() {
  const a = (-7 * Math.PI) / 180;
  const axis = [Math.cos(a), Math.sin(a), 0];
  const r = 2.4;
  const centreZ = MAT_H + r * Math.cos(Math.PI / 6);
  const F = G.frameOf([-34, 62, centreZ], axis, G.unit3(G.cross3([0, 0, 1], axis)), [0, 0, 1]);
  const hex = Array.from({ length: 6 }, (_, i) => { const t = (i / 6) * Math.PI * 2; return [Math.cos(t) * r, Math.sin(t) * r]; });
  const out = [];
  // sharpened end: wood cone and graphite tip (axis points from tip to eraser)
  out.push(S(G.solidOf([[-14, 0], [-11.5, 0.8], [0, r * 0.98]], F, P), { tone: "mid", crease: "none" }));
  out.push(S(G.solidOf([[-14.2, 0], [-11.5, 0.82]], F, P), { tone: "hi" }));
  out.push(S(G.prismOf(F, hex, 0, 56, P), { tone: "hi", crease: "lo" }));
  // ferrule with crimp rings, and the eraser
  out.push(S(G.disc(56, 62, r * 1.04, F, P), { tone: "mid" }));
  out.push(L(G.arcOf(F, 57.4, r * 1.04, P) + G.arcOf(F, 60.6, r * 1.04, P), { tone: "lo" }));
  out.push(S(G.solidOf([[62, r * 0.95], [66.4, r * 0.95], [67, r * 0.7]], F, P), { tone: "mid" }));
  return out.join("");
}

// ---------- eraser ----------
function eraser() {
  const E = { x: 40, y: 30, w: 22, d: 11 };
  const out = [`<path class="iso-halo" style="opacity:.6" d="${k.haloOf({ ...E, r: 2 }, MAT_H, 0.1, P)}"/>`];
  out.push(S(k.extrude(rotRect(E, 24, [0, 0], 2), MAT_H, 6, P, { bevel: 0.5 }), { tone: "mid" }));
  out.push(S(k.extrude(rotRect({ x: E.x + 8, y: E.y - 0.3, w: 12.5, d: E.d + 0.6 }, 24, [0.6, 0.3], 0.5), MAT_H, 6.3, P), { tone: "hi", crease: "lo" }));
  // crumbs
  out.push(D([[36, 48, MAT_H], [38.5, 51, MAT_H], [33.5, 46.5, MAT_H], [41, 52.5, MAT_H], [44.5, 50, MAT_H]].map(at), { size: 0.7, tone: "mid" }));
  return out.join("");
}

// ---------- ink bottle ----------
function ink() {
  const [x, y] = [50, -44];
  const F = G.frameOf([x, y, MAT_H], [0, 0, 1], [1, 0, 0], [0, 1, 0]);
  const out = [`<path class="iso-halo" style="opacity:.6" d="${k.haloOf({ x: x - 8, y: y - 8, w: 16, d: 16, r: 8 }, MAT_H, 0.1, P)}"/>`];
  out.push(S(G.solidOf([[0, 7.2], [10, 7.2], [11.5, 6.6, 1], [13, 5, 1], [14, 3.8], [15.2, 3.8]], F, P), { tone: "mid", crease: "faint", inner: L(G.arcOf(F, 1.2, 7.2, P), { tone: "faint" }) }));
  // label band on the glass
  out.push(L(G.arcOf(F, 3.4, 7.2, P) + G.arcOf(F, 8.2, 7.2, P), { tone: "lo" }));
  // cap with knurl
  out.push(S(G.disc(15.2, 21, 4.4, F, P), { tone: "hi", crease: "lo" }));
  out.push(k.fadedSvg(G.ribsOf(F, 15.2, 21, 4.4, 30, P, { fade: [0.1, 0.55] }), { tone: "lo" }));
  out.push(L(G.circleOf(F, 21, 3.2, P), { tone: "faint" }));
  return out.join("");
}

const H = handles();
const body = [desk(), stack(), ink(), H.back, clip(), H.front, eraser(), pencil()];

const svg = figure({
  name: "project",
  seed: 11,
  label: "A stack of blank manga pages on a desk: the top page has a panel grid with one diagonal gutter, a binder clip holds the stack, and a pencil and an eraser lie beside it.",
  halo: `<path class="iso-halo" d="${k.haloOf(DESK, -DESK_H - 4, DESK_H, P)}"/>`,
  body,
});
write(OUT, svg);
