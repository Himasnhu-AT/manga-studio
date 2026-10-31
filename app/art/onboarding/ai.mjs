// "Connect an AI": a small patch bay. Three shape-coded jacks on the left
// (Codex hexagon, Claude sunburst, Ollama eared square), one studio socket block
// on the right, and one patch cable (the lit part) from the Claude jack to the studio.
//   node app/art/onboarding/ai.mjs [--audit]
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as G from "./kit/lathe.mjs";
import * as A from "./kit/audit.mjs";
import { tubePieces, tubeSvg } from "./kit/tube.mjs";
import { WIDTH, HEIGHT, PAD, figure, write, S, L, D } from "./common-b.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../../src/assets/onboarding/ai.svg");

// World: x, y on the floor, z up. +x and +y come toward the viewer at azimuth 45.
const PLATE = { x: -40, y: -74, w: 80, d: 142, r: 7 };
const PLATE_H = 8;
const FOOT_H = 4;

const PANEL = { x: -30, y: 28, w: 60, d: 24, r: 3 };
const PANEL_H = 13;
const JACK_Y = PANEL.y + PANEL.d / 2;
const JACKS = [-19, 0, 19]; // Codex, Claude (patched), Ollama
const BEZEL_H = 1.2;
const COLLAR_R = 3.6;
const COLLAR_H = 1.6;

const BOX = { x: -21, y: -62, w: 42, d: 38, r: 4 };
const BOX_Z = 2;
const BOX_TOP = 30;
const SOCKET = [0, BOX.y + BOX.d / 2];

const PLUG = [[0, 2.2], [1.6, 2.2], [1.6, 3.3], [3.4, 3.3], [3.4, 2.9], [12.5, 2.9], [12.5, 2.5], [15, 2.2], [18, 1.6]];
const PLUG_TOP = 18;
const CABLE_R = 1.35;

const jackTop = PANEL_H + BEZEL_H + COLLAR_H;
const socketTop = BOX_TOP + 1.6 + COLLAR_H;
const CABLE_FROM = [0, JACK_Y, jackTop + PLUG_TOP];
const CABLE_TO = [SOCKET[0], SOCKET[1], socketTop + PLUG_TOP];

// A patch cord: leaves each plug straight up, arches over and settles into a soft droop.
function cableRoute() {
  const p0 = CABLE_FROM, p3 = CABLE_TO;
  const p1 = [p0[0], p0[1], p0[2] + 42];
  const p2 = [p3[0], p3[1], p3[2] + 34];
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60, u = 1 - t;
    pts.push([0, 1, 2].map((j) => u * u * u * p0[j] + 3 * u * u * t * p1[j] + 3 * u * t * t * p2[j] + t * t * t * p3[j]));
  }
  return pts;
}
const ROUTE = cableRoute();
const apex = Math.max(...ROUTE.map((p) => p[2]));

const P = k.fitProjection(
  [...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0), [0, JACK_Y, apex + CABLE_R], [0, ROUTE[30][1], apex + 2]],
  WIDTH, HEIGHT, { pad: PAD, azimuth: 45 },
);
const at = (p) => k.iso(p, P);
const R = A.recorder(P);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
const up = (x, y, z) => G.frameOf([x, y, z], [0, 0, 1], [1, 0, 0], [0, 1, 0]);

// ---------- base plate ----------
function base() {
  const out = [];
  for (const [x, y] of byDepth(k.corners(PLATE, 14))) {
    out.push(S(k.cylinder(x, y, 5.6, -PLATE_H - FOOT_H, 1.4, P, 24), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 4.2, -PLATE_H - FOOT_H + 1.4, FOOT_H - 1.4, P, 24), { tone: "mid" }));
  }
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.4), { tone: "mid", inner: L(k.sideSeam(PLATE, -PLATE_H + 2.4, P, 8), { tone: "faint" }) }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 4.5), 0, P), { tone: "lo" }));
  const screws = k.corners(PLATE, 8.5);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 1.9, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
  // label plate with rule lines between the two units
  const label = { x: 2, y: -14, w: 22, d: 32, r: 1.2 };
  out.push(S(k.slabOf(label, 0, 0.8, P, 3), { tone: "lo", crease: "none" }));
  out.push(L(k.planOutline(k.insetPlan(label, 1.6), 0.8, P, 3), { tone: "faint" }));
  out.push(L([22, 14, 18].map((w, i) => k.lineOnTop([label.x + 6 + i * 5, label.y + 5], [label.x + 8 + i * 5, label.y + 5 + w], 0.8, P)).join(""), { tone: "lo", free: true }));
  out.push(D([at([label.x + label.w - 4, label.y + 3.5, 0.8]), at([label.x + label.w - 4, label.y + label.d - 3.5, 0.8])], { size: 0.42 }));
  // ruler strip along the near long edge
  const strip = { x: PLATE.x + PLATE.w - 11, y: PLATE.y + 14, w: 6, d: PLATE.d - 28, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.y + 3, strip.y + strip.d - 3, 4, 5, strip.x, 0.6, [1.8, 3.4], P, "y");
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid", free: "end" }));
  return out.join("");
}

// ---------- jack panel ----------
const star = (cx, cy, rOut, rIn, n) => Array.from({ length: n * 2 }, (_, i) => {
  const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
  const r = i % 2 ? rIn : rOut;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
});
const hexagon = (cx, cy, r) => Array.from({ length: 6 }, (_, i) => {
  const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
});
// rounded square with two rounded ears on the far side: the "llama" jack
function eared(cx, cy, s) {
  const pts = [];
  const arc = (ox, oy, r, a0, a1, n = 6) => { for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; pts.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]); } };
  const h = s, c = 2.2, e = 2.1;
  arc(cx + h - c, cy + h - c, c, 0, Math.PI / 2);          // near corner (+x,+y)
  arc(cx - h + c, cy + h - c, c, Math.PI / 2, Math.PI);    // (-x,+y)
  arc(cx - h + c, cy - h + c, c, Math.PI, Math.PI * 1.25, 3);
  arc(cx - h + 2.6, cy - h - 1.2, e, Math.PI * 1.05, Math.PI * 2.0, 8);   // ear 1 on -y side
  arc(cx + h - 2.6, cy - h - 1.2, e, Math.PI * 1.0, Math.PI * 1.95, 8);   // ear 2
  arc(cx + h - c, cy - h + c, c, Math.PI * 1.75, Math.PI * 2, 3);
  return pts;
}

function jackSocket(x, y, z, plugged) {
  const out = [];
  out.push(S(k.cylinder(x, y, COLLAR_R, z, COLLAR_H, P, 32, 0.4), { tone: "hi", crease: "lo" }));
  const top = z + COLLAR_H;
  // hex nut flats as a faint ring, and the bore
  out.push(L(k.ring(x, y, COLLAR_R - 1, top, P, 32), { tone: "lo" }));
  if (!plugged) {
    out.push(`<path class="iso-shade" data-shade="0" d="${k.ring(x, y, 1.7, top, P, 32)}Z"/>`);
    out.push(L(k.ring(x, y, 1.7, top, P, 32), { tone: "hi" }));
    out.push(`<path class="iso-shade" data-shade="0" style="fill:#17171a;opacity:.55" d="${k.ring(x, y + 0.3, 1.1, top, P, 24)}Z"/>`);
  }
  return out.join("");
}

function panel() {
  const out = [];
  out.push(`<path class="iso-halo" d="${k.haloOf(k.insetPlan(PANEL, -2), 0, 0.1, P)}"/>`);
  // plinth and body
  out.push(S(k.slabOf(k.insetPlan(PANEL, -1.5), 0, 2.4, P, 4, 0.5), { tone: "lo" }));
  out.push(S(k.slabOf(PANEL, 2.4, PANEL_H - 2.4, P, 4, 0.9), { tone: "mid", inner: L(k.sideSeam(PANEL, 6, P, 4), { tone: "faint" }) }));
  // rack ears at both ends, with screws
  for (const x of [PANEL.x - 6, PANEL.x + PANEL.w + 1]) {
    const ear = { x, y: PANEL.y + 3, w: 5, d: PANEL.d - 6, r: 1.2 };
    out.push(S(k.slabOf(ear, 0, 3.2, P, 3, 0.4), { tone: "mid" }));
    out.push(D([at([x + 2.5, ear.y + 4, 3.2]), at([x + 2.5, ear.y + ear.d - 4, 3.2])], { size: 0.5 }));
  }
  out.push(L(k.planOutline(k.insetPlan(PANEL, 2.4), PANEL_H, P, 3), { tone: "faint" }));
  out.push(D([[PANEL.x + 5, PANEL.y + 5], [PANEL.x + 5, PANEL.y + PANEL.d - 5], [PANEL.x + PANEL.w - 5, PANEL.y + 5], [PANEL.x + PANEL.w - 5, PANEL.y + PANEL.d - 5]].map(([x, y]) => at([x, y, PANEL_H])), { size: 0.5 }));
  // shape-coded bezels
  const shapes = [hexagon(JACKS[0], JACK_Y, 7.4), star(JACKS[1], JACK_Y, 8.6, 6.2, 8), eared(JACKS[2], JACK_Y, 6.2)];
  shapes.forEach((ring, i) => {
    out.push(S(k.extrude(ring, PANEL_H, BEZEL_H, P, { convex: i === 0, bevel: 0.3 }), { tone: "hi", crease: "lo" }));
  });
  // Claude sunburst rays engraved on the star bezel
  out.push(L(Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    return k.lineOnTop([JACKS[1] + Math.cos(a) * COLLAR_R, JACK_Y + Math.sin(a) * COLLAR_R], [JACKS[1] + Math.cos(a) * 8.6, JACK_Y + Math.sin(a) * 8.6], PANEL_H + BEZEL_H, P);
  }).join(""), { tone: "lo" }));
  JACKS.forEach((x, i) => out.push(jackSocket(x, JACK_Y, PANEL_H + BEZEL_H, i === 1)));
  return out.join("");
}

// ---------- studio socket block ----------
function box() {
  const out = [];
  out.push(`<path class="iso-halo" d="${k.haloOf(k.insetPlan(BOX, -2), 0, 0.1, P)}"/>`);
  for (const [x, y] of byDepth(k.corners(BOX, 5))) out.push(S(k.cylinder(x, y, 2.6, 0, BOX_Z, P, 20), { tone: "lo" }));
  const lid = 22;
  out.push(S(k.slabOf(BOX, BOX_Z, BOX_TOP - BOX_Z, P, 6, 1.1), { tone: "mid", inner: L(k.sideSeam(BOX, lid, P, 6), { tone: "lo" }) }));
  // vents: closed slots on the +x face
  const side = BOX.x + BOX.w;
  const slot = (y, z0, z1, half = 0.9) => k.pathOf(k.roundedPlan({ x: y - half, y: z0, w: half * 2, d: z1 - z0, r: half }, 4).map(([u, z]) => at([side, u, z])), true);
  out.push(L([0, 1, 2, 3, 4, 5].map((i) => slot(BOX.y + 7 + i * 4, 7, 17)).join(""), { tone: "lo" }));
  // pilot lamp and a jack-label ring on the +y face
  const front = BOX.y + BOX.d;
  const F = G.frameOf([BOX.x + 10, front, 12], [0, 1, 0], [1, 0, 0], [0, 0, 1]);
  out.push(S(G.disc(0, 1.2, 3.2, F, P), { tone: "mid" }));
  out.push(S(G.solidOf([[1.2, 2], [2.4, 2], [3.3, 0.9], [3.3, 0]], F, P), { tone: "hi", crease: "none" }));
  const knob = G.frameOf([BOX.x + 26, front, 12], [0, 1, 0], [1, 0, 0], [0, 0, 1]);
  out.push(S(G.disc(0, 0.8, 4.6, knob, P), { tone: "lo" }));
  out.push(S(G.disc(0.8, 4.2, 3.6, knob, P), { tone: "mid" }));
  out.push(k.fadedSvg(G.ribsOf(knob, 1.2, 3.8, 3.6, 22, P, { fade: [0.1, 0.55] }), { tone: "lo" }));
  out.push(L(G.circleOf(knob, 4.2, 2.6, P), { tone: "faint" }));
  out.push(L(k.segment([BOX.x + 26 + 0.4, front + 4.2, 12 + 1.0], [BOX.x + 26 + 0.4, front + 4.2, 12 + 3.2], P), { tone: "hi" }));
  // lid screws
  out.push(D(k.corners(BOX, 4).map(([x, y]) => at([x, y, BOX_TOP])), { size: 0.5 }));
  out.push(L(k.planOutline(k.insetPlan(BOX, 2.2), BOX_TOP, P, 5), { tone: "faint" }));
  // speech-bubble mark engraved on the lid: the studio
  const bx = BOX.x + 30, by = BOX.y + 9;
  const bubble = [];
  for (let i = 0; i <= 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const p = [bx + Math.cos(a) * 6, by + Math.sin(a) * 4];
    bubble.push(p);
    if (i === 6) bubble.push([bx + 2.4, by + 6.6]);
  }
  out.push(L(k.onTop(bubble, BOX_TOP, P, true), { tone: "mid" }));
  // socket bezel and collar
  out.push(S(k.cylinder(SOCKET[0], SOCKET[1], 7.6, BOX_TOP, 1.6, P, 48, 0.5), { tone: "hi", crease: "lo" }));
  out.push(L(k.ring(SOCKET[0], SOCKET[1], 6, BOX_TOP + 1.6, P, 48), { tone: "lo" }));
  out.push(D(Array.from({ length: 4 }, (_, i) => { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; return at([SOCKET[0] + Math.cos(a) * 6.8, SOCKET[1] + Math.sin(a) * 6.8, BOX_TOP + 1.6]); }), { size: 0.42 }));
  out.push(jackSocket(SOCKET[0], SOCKET[1], BOX_TOP + 1.6, true));
  return out.join("");
}

// ---------- plugs and cable ----------
function plug(x, y, z) {
  const F = up(x, y, z);
  const out = [];
  out.push(S(G.solidOf(PLUG, F, P), { tone: "hi", crease: "lo" }));
  out.push(k.fadedSvg(G.ribsOf(F, 4.4, 11.5, 2.9, 26, P, { fade: [0.1, 0.55] }), { tone: "lo" }));
  out.push(L(G.arcOf(F, 4.4, 2.9, P) + G.arcOf(F, 11.5, 2.9, P), { tone: "faint" }));
  return out.join("");
}

function cable() {
  const pieces = tubePieces(ROUTE, CABLE_R, P, { maxLength: 18, caps: [false, false] });
  R.route("cable", ROUTE, CABLE_R, { limp: true });
  return pieces.sort((a, b) => k.depthOf(a.mid, P) - k.depthOf(b.mid, P)).map((piece) => tubeSvg(piece, { tone: "hi" })).join("").replaceAll('<g class="tb">', '<g class="tb ob-lit">');
}

// audit shapes (static figure, so only clearances, terminals and supports matter)
R.solid(A.slab(PLATE, -PLATE_H, PLATE_H, { name: "stand.plate" }));
R.solid(A.slab(PANEL, 0, PANEL_H, { name: "panel" }));
for (const [x, y] of k.corners(BOX, 5)) R.solid(A.cylinder(x, y, 2.6, 0, BOX_Z, { name: "box.foot" }));
for (const x of JACKS) R.solid(A.cylinder(x, JACK_Y, 6.2, PANEL_H, BEZEL_H, { name: "panel.bezel" }));
R.solid(A.slab(BOX, BOX_Z, BOX_TOP - BOX_Z, { name: "box" }));
R.solid(A.cylinder(SOCKET[0], SOCKET[1], 7.6, BOX_TOP, 1.6, { name: "box.bezel" }));
R.solid(A.cylinder(0, JACK_Y, COLLAR_R, PANEL_H + BEZEL_H, COLLAR_H, { name: "panel.collar" }));
R.solid(A.cylinder(SOCKET[0], SOCKET[1], COLLAR_R, BOX_TOP + 1.6, COLLAR_H, { name: "box.collar" }));
R.solid(A.solid(up(0, JACK_Y, jackTop), PLUG, { name: "plug.jack" }));
R.solid(A.solid(up(SOCKET[0], SOCKET[1], socketTop), PLUG, { name: "plug.studio" }));

const body0 = [
  base(),
  panel(),
  plug(0, JACK_Y, jackTop),
  box(),
  plug(SOCKET[0], SOCKET[1], socketTop),
  cable(),
];


const body = body0;
const svg = figure({
  name: "ai",
  seed: 7,
  label: "A small patch bay: three shape-coded jacks on the left and a studio socket block on the right, joined by one patch cable.",
  halo: `<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`,
  body,
});
write(OUT, svg);
A.auditOrExit(R, P);
