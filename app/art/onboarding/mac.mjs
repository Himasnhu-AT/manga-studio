// "This Mac": a compact desktop computer on a bench, a dial gauge wired to it reading memory
// (needle at 24 GB on a 0-64 GB scale, the lit part) and a small drive caddy with its drawer out.
import { k, G, WIDTH, HEIGHT, write, halo } from "./common.mjs";

const PLATE = { x: -100, y: -72, w: 196, d: 128, r: 8 };
const PLATE_H = 10;
const FOOT_H = 5;

const BOX = { x: -78, y: -58, w: 92, d: 92, r: 14 };
const BOX_Z = 2.4;
const BOX_TOP = 32;
const FRONT = BOX.y + BOX.d; // +y face
const SIDE = BOX.x + BOX.w; // +x face

const DIAL = [58, -24];
const DIAL_R = 28;
const DIAL_Z = 22;
const DIAL_H = 8;
const DIAL_TOP = DIAL_Z + DIAL_H;
const GB = 24;
const MAX = 64;
const SPAN = Math.PI * 1.5;
const FROM = -SPAN / 2;

const CADDY = { x: -68, y: -46, w: 58, d: 30, r: 2 };
const CADDY_H = 14;
const PULL = 16; // how far the drawer is out
const CZ = BOX_TOP; // the caddy sits on the computer

const P = k.fitProjection(
  [...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0), ...k.boxCorners(BOX, 0, BOX_TOP + 14), [DIAL[0], DIAL[1] - DIAL_R, DIAL_TOP]],
  WIDTH,
  HEIGHT,
  { pad: 22, azimuth: 45 },
);

const at = (p) => k.iso(p, P);
const S = (paths, style = {}) => k.solidSvg(paths, style);
const L = (d, style = {}) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
// Closed outline on a vertical face: x = const (u is y) or y = const (u is x).
const onFaceY = (y, x0, z0, x1, z1, r) => k.pathOf(k.roundedPlan({ x: x0, y: z0, w: x1 - x0, d: z1 - z0, r }, 4).map(([u, z]) => at([u, y, z])), true);
const onFaceX = (x, y0, z0, y1, z1, r) => k.pathOf(k.roundedPlan({ x: y0, y: z0, w: y1 - y0, d: z1 - z0, r }, 4).map(([u, z]) => at([x, u, z])), true);
const circleY = (y, cx, cz, r, steps = 20) => k.pathOf(Array.from({ length: steps }, (_, i) => at([cx + r * Math.cos((i / steps) * Math.PI * 2), y, cz + r * Math.sin((i / steps) * Math.PI * 2)])), true);

const out = [];
const halos = [halo(k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P))];

// --- Bench plate on feet, groove, screws, ruler strip, label plate ------------------------
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
  const strip = { x: -86, y: PLATE.y + PLATE.d - 15, w: 100, d: 7, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 4, 5, strip.y + 0.8, 0.6, [2, 3.6], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(D([at([strip.x + 2, strip.y + 3.5, 0.6]), at([strip.x + strip.w - 2, strip.y + 3.5, 0.6])], { size: 0.45, tone: "mid" }));
  const label = { x: 52, y: 26, w: 30, d: 12, r: 1.2 };
  out.push(S(k.slabOf(label, 0, 0.8, P, 3), { tone: "lo", crease: "none" }));
  out.push(L(k.planOutline(k.insetPlan(label, 1.6), 0.8, P, 3), { tone: "faint" }));
  out.push(L([18, 12, 15].map((w, i) => k.lineOnTop([label.x + 4, label.y + 3.4 + i * 2.6], [label.x + 4 + w, label.y + 3.4 + i * 2.6], 0.8, P)).join(""), { tone: "lo", free: true }));
  out.push(D([at([label.x + label.w - 3, label.y + 3, 0.8]), at([label.x + label.w - 3, label.y + label.d - 3, 0.8])], { size: 0.45, tone: "mid" }));
}

// --- The computer -------------------------------------------------------------------------
{
  const foot = k.insetPlan(BOX, 8);
  out.push(S(k.slabOf(foot, 0, BOX_Z, P, 8), { tone: "lo" }));
  const seam = k.sideSeam(BOX, BOX_TOP - 4, P, 8);
  out.push(S(k.slabOf(BOX, BOX_Z, BOX_TOP - BOX_Z, P, 8, 1.4), { tone: "hi", crease: "lo", inner: L(seam, { tone: "faint" }) }));
  // Top: a shallow engraved ring round the centre (where the lid's logo would sit, left blank).
  const [cx, cy] = [BOX.x + BOX.w / 2, BOX.y + BOX.d / 2];
  out.push(L(k.planOutline(k.insetPlan(BOX, 4), BOX_TOP, P, 8), { tone: "faint" }));
  // Front face: status light, two ports, a card slot.
  out.push(L(onFaceY(FRONT, -42, 12, -34, 15, 1.4) + onFaceY(FRONT, -30, 12, -22, 15, 1.4), { tone: "mid" }));
  out.push(L(circleY(FRONT, -16, 13.5, 1.6), { tone: "mid" }));
  out.push(L(onFaceY(FRONT, -64, 8, -48, 9.4, 0.6), { tone: "lo" }));
  out.push(D([at([2, FRONT, 20])], { size: 0.9, tone: "hi" }));
  // Side face: a row of vent slots and the port the gauge cable plugs into.
  const vents = [];
  for (let y = -44; y <= 4; y += 5) vents.push(onFaceX(SIDE, y, 6, y + 2, 20, 1));
  out.push(L(vents.join(""), { tone: "lo" }));
  out.push(S(k.slabOf({ x: SIDE, y: 12, w: 4, d: 8, r: 1 }, 9, 6, P, 2, 0.4), { tone: "mid" }));
}
// Cable from the side port to the gauge pedestal, lying on the bench.
out.push(k.wireSvg(at([SIDE + 4, 16, 12]), at([DIAL[0] - 8.2, DIAL[1] + 10.5, 1.6]), { via: [at([SIDE + 8, 16, 10.4]), at([SIDE + 10, 16, 0.6]), at([38, 8, 0.6]), at([DIAL[0] - 12, DIAL[1] + 16, 0.6])], tone: "hi", size: 1.1 }));

// --- Dial gauge on a pedestal ---------------------------------------------------------------
{
  const [x, y] = DIAL;
  out.push(S(k.cylinder(x, y, 13, 0, 2.4, P, 40, 0.5), { tone: "mid" }));
  out.push(D([0.6, 2.2, 3.8, 5.4].map((t) => at([x + 10.5 * Math.cos(t), y + 10.5 * Math.sin(t), 2.4])), { size: 0.45, tone: "mid" }));
  out.push(S(k.cylinder(x, y, 9.6, 2.4, 3.2, P, 32), { tone: "mid" }));
  out.push(S(k.cylinder(x, y, 5.2, 5.6, DIAL_Z - 5.6, P, 28), { tone: "mid", crease: "none", inner: L(k.sideArc(x, y, 5.2, 10, P, 16), { tone: "faint" }) }));
  out.push(S(k.cylinder(x, y, DIAL_R, DIAL_Z, DIAL_H, P, 72, 0.8), { tone: "hi", crease: "lo" }));
  out.push(L(k.knurl(x, y, DIAL_R, DIAL_TOP - 3.4, DIAL_TOP, 90, P, 0.3), { tone: "lo" }));
  out.push(L(k.sideArc(x, y, DIAL_R, DIAL_TOP - 3.4, P, 48), { tone: "faint" }));
  out.push(L(k.ring(x, y, DIAL_R - 2.2, DIAL_TOP, P, 72), { tone: "lo" }));
  // 0-64 GB over 270°: a minor tick every 2 GB, a major every 8.
  const t = k.radialTicks(x, y, DIAL_R - 2.2, 32, 4, DIAL_TOP, [1.6, 3.4], P, FROM, SPAN * (32 / 32));
  out.push(L(t.minor, { tone: "lo" }), L(t.major, { tone: "hi" }));
  // Last tick (64) closes the scale.
  const end = FROM + SPAN;
  out.push(L(k.lineOnTop([x + Math.sin(end) * (DIAL_R - 2.2), y - Math.cos(end) * (DIAL_R - 2.2)], [x + Math.sin(end) * (DIAL_R - 5.6), y - Math.cos(end) * (DIAL_R - 5.6)], DIAL_TOP, P), { tone: "hi" }));
  // Inner scale ring the ticks stand on, as an arc over the span.
  const arc = Array.from({ length: 49 }, (_, i) => {
    const a = FROM + (SPAN * i) / 48;
    return [x + Math.sin(a) * (DIAL_R - 5.6), y - Math.cos(a) * (DIAL_R - 5.6)];
  });
  out.push(L(k.onTop(arc, DIAL_TOP, P), { tone: "faint" }));
  // Crown on the +x side.
  out.push(S(k.slabOf({ x: x + DIAL_R - 1, y: y - 2.4, w: 5, d: 4.8, r: 1.2 }, DIAL_Z + 1.6, 4.6, P, 3), { tone: "mid" }));
  out.push(S(k.slabOf({ x: x + DIAL_R + 3.6, y: y - 3.4, w: 2.8, d: 6.8, r: 1.2 }, DIAL_Z + 0.8, 6.4, P, 3), { tone: "mid" }));
  // Needle (lit) and hub.
  const a = FROM + SPAN * (GB / MAX);
  const tail = [x - Math.sin(a) * 5, y + Math.cos(a) * 5];
  const tip = [x + Math.sin(a) * (DIAL_R - 4.4), y - Math.cos(a) * (DIAL_R - 4.4)];
  out.push(L(k.lineOnTop(tail, tip, DIAL_TOP + 0.3, P), { tone: "lit", free: "start" }).replace("<path", `<path style="stroke-width:1.4px"`));
  out.push(S(k.cylinder(x, y, 2, DIAL_TOP, 1.2, P, 20), { tone: "hi", lit: true }));
}

// --- Drive caddy on top of the computer, its drawer out (drawn at z 0, lifted onto the lid) --
{
  const lifted = out.length;
  out.push(S(k.slabOf(CADDY, 0, CADDY_H, P, 3, 0.8), { tone: "mid", inner: L(k.sideSeam(CADDY, 3, P, 3), { tone: "faint" }) }));
  out.push(L(k.planOutline(k.insetPlan(CADDY, 3), CADDY_H, P, 3), { tone: "faint" }));
  out.push(D(k.corners(CADDY, 2.4).map(([x, y]) => at([x, y, CADDY_H])), { size: 0.45, tone: "mid" }));
  const front = CADDY.y + CADDY.d;
  // Bay opening on the front face (the drawer runs out of it).
  out.push(L(onFaceY(front, CADDY.x + 5, 3.4, CADDY.x + CADDY.w - 5, 11, 0.8), { tone: "lo" }));
  // Drawer: floor and side walls out past the face, the drive in it, then its front panel.
  const tray = { x: CADDY.x + 6, y: front, w: CADDY.w - 12, d: PULL, r: 0.4 };
  out.push(S(k.slabOf(tray, 4, 1.2, P, 2), { tone: "lo" }));
  out.push(S(k.slabOf({ x: tray.x, y: front, w: 1.4, d: PULL, r: 0.3 }, 5.2, 4.4, P, 2), { tone: "mid" }));
  const drive = { x: tray.x + 4, y: front, w: tray.w - 8, d: PULL - 3, r: 1 };
  out.push(S(k.slabOf(drive, 5.2, 2.6, P, 3, 0.4), { tone: "hi", crease: "lo" }));
  out.push(L([10, 16, 7].map((w, i) => k.lineOnTop([drive.x + 4, front + 2 + i * 2.6], [drive.x + 4 + w, front + 2 + i * 2.6], 7.8, P)).join(""), { tone: "lo", free: true }));
  out.push(D([at([drive.x + drive.w - 3, front + 2.4, 7.8]), at([drive.x + drive.w - 3, front + PULL - 6, 7.8])], { size: 0.45, tone: "mid" }));
  out.push(S(k.slabOf({ x: tray.x + tray.w - 1.4, y: front, w: 1.4, d: PULL, r: 0.3 }, 5.2, 4.4, P, 2), { tone: "mid" }));
  const panel = { x: CADDY.x + 4.6, y: front + PULL, w: CADDY.w - 9.2, d: 2, r: 0.6 };
  out.push(S(k.slabOf(panel, 3, 8.4, P, 3, 0.4), { tone: "mid" }));
  out.push(S(k.slabOf({ x: panel.x + panel.w / 2 - 7, y: panel.y + 2, w: 14, d: 1.6, r: 0.7 }, 6, 2, P, 3), { tone: "hi", crease: "lo" }));
  out.push(D([at([panel.x + 3, panel.y + 2, 7.2]), at([panel.x + panel.w - 3, panel.y + 2, 7.2])], { size: 0.45, tone: "mid" }));
  // Activity light on the caddy face.
  out.push(D([at([CADDY.x + CADDY.w - 3, front, 12.4])], { size: 0.7, tone: "hi" }));
  const parts = out.splice(lifted);
  out.push(`<g transform="${k.translateAlong(P, [0, 0, CZ])}">${parts.join("")}</g>`);
}

write("mac", {
  seed: 11,
  scale: 1.6,
  label: "A compact desktop computer on a bench, wired to a dial gauge whose needle reads 24 of 64 GB of memory, beside a small drive caddy with its drawer pulled out.",
  halos,
  body: out,
});
