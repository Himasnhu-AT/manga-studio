// Welcome: the studio itself. A small drafting desk with a tilted board, a manga page clipped on
// (panel borders and one speech bubble, the lit part), a dip pen in its tray, an ink bottle and a
// half-peeled screentone sheet.
import { k, G, WIDTH, HEIGHT, write, plane, ellipse, halo } from "./common.mjs";

// World: x to the right-front, y to the left-front, z up. Floor at z = FLOOR.
const TOP = { x: -80, y: -55, w: 210, d: 110, r: 2 };
const TOP_H = 7;
const FLOOR = -72;
const LEG = 6;
const SHELF_Z = -58;
const APRON = { x: TOP.x + LEG, y: TOP.y + LEG, w: TOP.w - 2 * LEG, d: TOP.d - 2 * LEG, r: 0.6 };
const APRON_Z = -TOP_H - 13;

// Drafting board, tilted T degrees up toward the back (−y).
const T = (22 * Math.PI) / 180;
const BOARD_W = 128;
const BOARD_L = 104;
const BOARD_T = 3;
const N = [0, Math.sin(T), Math.cos(T)]; // board normal
const U = [1, 0, 0];
const V = [0, -Math.cos(T), Math.sin(T)]; // up the board
const B0 = [-64, 44, 4.2]; // front-left corner of the board's top face
const board = plane(B0, U, V);
const on = (a, b, lift = 0) => board.at3(a, b, lift, N);

const P = k.fitProjection(
  [...k.boxCorners(TOP, FLOOR, 0), on(0, BOARD_L, 0), on(BOARD_W, BOARD_L, 0), on(-2, BOARD_L + 2, 2)],
  WIDTH,
  HEIGHT,
  { pad: 22, azimuth: 45 },
);

const at = (p) => k.iso(p, P);
const S = (paths, style = {}) => k.solidSvg(paths, style);
const L = (d, style = {}) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const path3 = (points, closed = false) => k.pathOf(points.map(at), closed);
const depth = ([x, y]) => k.depthOf([x, y, 0], P);
const boardFrame = G.frameOf(B0, N, U, V);
const boardPrism = (poly, s0, s1) => G.prismOf(boardFrame, poly, s0, s1, P);
const rect = (a0, b0, a1, b1) => [[a0, b0], [a1, b0], [a1, b1], [a0, b1]];

const out = [];
const halos = [halo(k.haloOf(TOP, FLOOR, 2, P))];

// --- Legs (lower runs), shelf, legs (upper runs), apron, tabletop ---------------------------
const legs = [
  [TOP.x, TOP.y],
  [TOP.x + TOP.w - LEG, TOP.y],
  [TOP.x, TOP.y + TOP.d - LEG],
  [TOP.x + TOP.w - LEG, TOP.y + TOP.d - LEG],
].sort((a, b) => depth(a) - depth(b));
const legPlan = ([x, y]) => ({ x, y, w: LEG, d: LEG, r: 0.8 });
for (const leg of legs) {
  out.push(S(k.slabOf(k.insetPlan(legPlan(leg), -0.8), FLOOR, 2.4, P, 3, 0.4), { tone: "lo" }));
  out.push(S(k.slabOf(legPlan(leg), FLOOR + 2.4, SHELF_Z - FLOOR - 2.4, P, 3, 0.4), { tone: "mid" }));
}
// Shelf with notches round the legs, and a stack of paper on it.
{
  const x0 = TOP.x, x1 = TOP.x + TOP.w, y0 = TOP.y + 2, y1 = TOP.y + TOP.d - 2;
  const nx0 = x0 + LEG, nx1 = x1 - LEG;
  const ring = [[nx0, y0], [nx1, y0], [nx1, y0 + LEG - 2], [x1, y0 + LEG - 2], [x1, y1 - LEG + 2], [nx1, y1 - LEG + 2], [nx1, y1], [nx0, y1], [nx0, y1 - LEG + 2], [x0, y1 - LEG + 2], [x0, y0 + LEG - 2], [nx0, y0 + LEG - 2]];
  out.push(S(k.extrude(ring, SHELF_Z, 3, P, { convex: false }), { tone: "mid" }));
  const z = SHELF_Z + 3;
  const sheets = [
    { x: -40, y: -34, w: 58, d: 44, r: 0.6 },
    { x: -38, y: -32.5, w: 58, d: 44, r: 0.6 },
    { x: -41, y: -31, w: 58, d: 44, r: 0.6 },
  ];
  sheets.forEach((plan, i) => out.push(S(k.slabOf(plan, z + i * 2.2, 2.2, P, 2), { tone: "lo", crease: "faint" })));
  out.push(L(k.sideSeam(sheets[2], z + 4.4 + 1.1, P, 2), { tone: "faint" }));
  // A closed sketchbook beside the stack.
  const book = { x: 40, y: -26, w: 46, d: 34, r: 1 };
  out.push(S(k.slabOf(book, z, 6, P, 3, 0.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(book, 4), z + 6, P, 3), { tone: "faint" }));
  out.push(S(k.slabOf({ x: book.x + book.w - 10, y: book.y - 0.4, w: 3, d: book.d + 0.8, r: 0.4 }, z + 6, 0.3, P, 2), { tone: "lo", crease: "none" }));
}
// Upper leg runs: the far leg, then the apron it stands behind, then the rest.
const upper = (leg) => S(k.slabOf(legPlan(leg), SHELF_Z + 3, -TOP_H - SHELF_Z - 3, P, 3, 0.4), { tone: "mid" });
out.push(upper(legs[0]));
{
  out.push(S(k.slabOf(APRON, APRON_Z, -TOP_H - APRON_Z, P, 2, 0), { tone: "mid", inner: L(k.sideSeam(APRON, APRON_Z + 2, P, 2), { tone: "faint" }) }));
  const front = APRON.y + APRON.d;
  // Two drawers in the front apron, each with a pull.
  for (const cx of [-12, 70]) {
    const plan = { x: cx - 26, y: front, w: 52, d: 1.2, r: 0.4 };
    out.push(S(k.slabOf(plan, APRON_Z + 3, 8, P, 2, 0.3), { tone: "mid" }));
    out.push(S(k.slabOf({ x: cx - 8, y: front + 1.2, w: 1.6, d: 1.8, r: 0.3 }, APRON_Z + 6.2, 1.6, P, 2), { tone: "mid", crease: "none" }));
    out.push(S(k.slabOf({ x: cx + 6.4, y: front + 1.2, w: 1.6, d: 1.8, r: 0.3 }, APRON_Z + 6.2, 1.6, P, 2), { tone: "mid", crease: "none" }));
    out.push(S(k.slabOf({ x: cx - 9, y: front + 3, w: 18, d: 1.6, r: 0.7 }, APRON_Z + 6, 2, P, 3), { tone: "hi", crease: "lo" }));
    out.push(D([at([cx - 22, front + 1.2, APRON_Z + 7]), at([cx + 22, front + 1.2, APRON_Z + 7])], { size: 0.45, tone: "mid" }));
  }
}
for (const leg of legs.slice(1)) out.push(upper(leg));
out.push(S(k.slabOf(TOP, -TOP_H, TOP_H, P, 3, 1.2), { tone: "mid", inner: L(k.sideSeam(TOP, -TOP_H + 2.2, P, 3), { tone: "faint" }) }));
// Corner screws on the top.
out.push(D(k.corners(TOP, 3).map(([x, y]) => at([x, y, 0])), { size: 0.45, tone: "mid" }));

// --- Drafting board: side cheeks, board, page, clips, rule --------------------------------
{
  const under = (b) => on(0, b, -BOARD_T);
  const yz = (b) => [under(b)[1], under(b)[2]];
  const [ya, za] = yz(6);
  const [yb, zb] = yz(96);
  const cheek = [[ya, 0], [yb, 0], [yb, zb], [ya, za]];
  for (const x of [-60, 52]) {
    const F = G.frameOf([x, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
    out.push(S(G.prismOf(F, cheek, 0, 8, P), { tone: "mid" }));
    out.push(D([at([x + 8, (ya + yb) / 2 + 12, 4]), at([x + 8, yb + 6, 4])], { size: 0.45, tone: "mid" }));
  }
  // Brace between the cheeks at the back.
  out.push(S(k.slabOf({ x: -52, y: yb, w: 104, d: 4, r: 0.4 }, 0, 10, P, 2, 0.3), { tone: "mid" }));
}
out.push(S(boardPrism(rect(0, 0, BOARD_W, BOARD_L), -BOARD_T, 0), { tone: "mid" }));
// Hinge knuckles along the board's front edge.
for (const a of [14, BOARD_W - 22]) {
  const F = G.frameAlong(on(a, 1.4, -BOARD_T - 1.2), [1, 0, 0]);
  out.push(S(G.disc(0, 8, 1.6, F, P), { tone: "mid" }));
  out.push(L(G.arcOf(F, 4, 1.6, P), { tone: "faint" }));
}
// Page (a manga page, about 0.7 wide to tall).
const PAGE = { a0: 34, a1: 94, b0: 12, b1: 96 };
out.push(S(boardPrism(rect(PAGE.a0, PAGE.b0, PAGE.a1, PAGE.b1), 0, 0.5), { tone: "hi", crease: "faint" }));
const pg = (a, b) => at(on(a, b, 0.55));
const poly = (pts, closed = true) => k.pathOf(pts.map(([a, b]) => pg(a, b)), closed);
{
  const m = 4.5;
  const A0 = PAGE.a0 + m, A1 = PAGE.a1 - m, Bt = PAGE.b1 - m, Bb = PAGE.b0 + m;
  const g = 2.4; // gutter
  const tier1 = Bt - 26;
  const tier2 = tier1 - g - 24;
  const panels = [
    rect(A0, tier1, A1, Bt),
    [[A0, tier2], [A0 + 32, tier2], [A0 + 26, tier1 - g], [A0, tier1 - g]],
    [[A0 + 32 + g, tier2], [A1, tier2], [A1, tier1 - g], [A0 + 26 + g, tier1 - g]],
    rect(A0, Bb, A0 + 21, tier2 - g),
    rect(A0 + 21 + g, Bb, A1, tier2 - g),
  ];
  out.push(L(panels.map((p) => poly(p)).join(""), { tone: "hi" }));
  // Pencil roughs inside the panels; each runs from border to border.
  const sky = [[A0, tier1 + 6], [A0 + 6, tier1 + 6], [A0 + 6, tier1 + 12], [A0 + 11, tier1 + 12], [A0 + 11, tier1 + 9], [A0 + 15, tier1 + 9], [A0 + 15, tier1 + 15], [A0 + 19, tier1 + 15], [A0 + 19, tier1 + 7], [A0 + 25, tier1 + 7], [A0 + 25, tier1 + 4], [A1, tier1 + 4]];
  out.push(L(poly(sky, false), { tone: "lo" }));
  // A figure in the left middle panel: head and shoulders standing on the panel's bottom border.
  const hx = A0 + 13, hz = tier2 + 13;
  out.push(L(poly(ellipse(hx, hz, 3.6, 4.2, 24), true), { tone: "mid" }));
  out.push(L(poly([[hx - 9, tier2], [hx - 8, tier2 + 4], [hx - 4, tier2 + 7], [hx + 4, tier2 + 7], [hx + 8, tier2 + 4], [hx + 9, tier2]], false), { tone: "mid" }));
  // Speed lines in the right middle panel, each spanning the panel corner to corner.
  const sp = [];
  for (let i = 1; i <= 4; i++) sp.push(poly([[A0 + 32 + g + 2.5 * i - 1, tier2], [A0 + 26 + g + 6 * i, tier1 - g]], false));
  out.push(L(sp.join(""), { tone: "lo" }));
  // Bottom-right: a window frame (cross) in the panel.
  const wx0 = A0 + 21 + g, wx1 = A1;
  out.push(L(poly([[wx0, Bb + 12], [wx1, Bb + 12]], false) + poly([[wx0 + 14, Bb], [wx0 + 14, tier2 - g]], false), { tone: "faint" }));
  // Bottom-left: hatched shadow corner.
  const hatch = [];
  for (let i = 1; i <= 5; i++) hatch.push(poly([[A0, Bb + 3 * i], [A0 + 3 * i, Bb]], false));
  out.push(L(hatch.join(""), { tone: "lo" }));
  // The speech bubble: the lit part.
  const cx = A0 + 37, cb = tier1 + 15, rx = 10, ry = 5.4;
  const t0 = Math.PI * 1.12, t1 = Math.PI * 1.32;
  const arc = ellipse(cx, cb, rx, ry, 44, t1, t0 + Math.PI * 2);
  const tip = [cx - 10.5, tier1 + 3.4];
  const bubble = poly([...arc, tip]);
  out.push(`<path d="${bubble}" style="fill:#ffffff;stroke:none"/>`);
  out.push(L(bubble, { tone: "lit" }).replace("<path", `<path style="stroke-width:1.15px"`));
  // Two text rules in the bubble (stand for lettering).
  out.push(L(poly([[cx - 5.5, cb + 1.4], [cx + 5.5, cb + 1.4]], false) + poly([[cx - 3.5, cb - 1.4], [cx + 3.5, cb - 1.4]], false), { tone: "mid", free: true }));
}
// A set square on the board left of the page (its cut-out drawn as an inner outline), and an
// eraser to the right.
{
  const tri = [[6, 18], [30, 18], [6, 60]];
  out.push(S(boardPrism(tri, 0, 0.9), { tone: "hi", crease: "faint" }));
  const hole = [[11, 23], [21.5, 23], [11, 41.5]];
  out.push(L(k.pathOf(hole.map(([a, b]) => at(on(a, b, 0.9))), true), { tone: "mid" }));
  out.push(S(boardPrism(rect(104, 34, 116, 40), 0, 3.4), { tone: "hi", crease: "lo" }));
  out.push(L(k.pathOf([at(on(108, 34, 3.4)), at(on(108, 40, 3.4))]), { tone: "faint" }));
}
// Bulldog clips at the top of the page.
for (const a of [PAGE.a0 + 10, PAGE.a1 - 10]) {
  out.push(S(boardPrism(rect(a - 5, PAGE.b1 - 6, a + 5, PAGE.b1 + 2), 0, 2.6), { tone: "mid" }));
  out.push(S(boardPrism(rect(a - 5.4, PAGE.b1 + 1.6, a + 5.4, PAGE.b1 + 2.4), 0, 3), { tone: "mid", crease: "none" }));
  const lever = (s) => [on(a + s * 3.4, PAGE.b1 + 2.4, 2.6), on(a + s * 3.4, PAGE.b1 + 6.4, 4.6)];
  const [l0, l1] = lever(-1), [r0, r1] = lever(1);
  out.push(L(path3([l0, l1, r1, r0]), { tone: "hi" }));
}
// Parallel rule across the board below the page, with its ticks hanging from its top edge.
{
  const R0 = 2, R1 = 9;
  out.push(S(boardPrism(rect(2, R0, BOARD_W - 2, R1), 0, 1.6), { tone: "hi", crease: "lo" }));
  const ticks = [], major = [];
  for (let a = 6, i = 0; a <= BOARD_W - 6; a += 3, i++) (i % 5 ? ticks : major).push(path3([on(a, R1, 1.6), on(a, R1 - (i % 5 ? 1.6 : 3), 1.6)]));
  out.push(L(ticks.join(""), { tone: "lo" }), L(major.join(""), { tone: "mid" }));
  // Its wire runs up the board edges to pulleys at the top corners.
  for (const a of [1, BOARD_W - 1]) {
    out.push(L(path3([on(a, R1 - 2, 0.9), on(a, BOARD_L - 3, 0.9)]), { tone: "lo" }));
    const F = G.frameOf(on(a, BOARD_L - 3, 0), N, U, V);
    out.push(S(G.disc(0, 1.4, 2.2, F, P), { tone: "mid" }));
  }
}
// Pencil ledge on the front edge, with a pencil in it.
{
  const ledge = { x: -66, y: 44.4, w: 132, d: 6, r: 0.8 };
  out.push(S(k.slabOf(ledge, 0, 6.2, P, 3, 0.5), { tone: "mid" }));
  out.push(L(k.lineOnTop([ledge.x, ledge.y + 3], [ledge.x + ledge.w, ledge.y + 3], 6.2, P), { tone: "faint" }));
  const F = G.frameAlong([-30, 47.4, 7.4], [1, 0, 0]);
  out.push(S(G.solidOf([[0, 1.2], [36, 1.2], [36, 1.15], [42, 0.35], [43, 0]], F, P, { steps: 20 }), { tone: "hi", crease: "lo" }));
  out.push(S(G.disc(-3, 0, 1.25, F, P), { tone: "mid" }));
}

// --- Right side of the desk: ink bottle, pen tray with dip pen, screentone sheet ----------
{
  // Ink bottle (far right).
  const bx = 100, by = -36;
  const F = G.frameOf([bx, by, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]);
  halos.push(halo(k.haloOf({ x: bx - 10, y: by - 10, w: 20, d: 20, r: 10 }, 0, 1, P)));
  out.push(S(G.solidOf([[0, 10], [11, 10], [12.5, 9.4, 1], [14, 7.6, 1], [15, 5.2, 1], [15.6, 4.4], [17.5, 4.4]], F, P, { steps: 40 }), { tone: "hi", crease: "lo", inner: L(G.arcOf(F, 3, 10, P) + G.arcOf(F, 9, 10, P), { tone: "faint" }) }));
  out.push(S(k.cylinder(bx, by, 5.4, 17.5, 6, P, 32, 0.4), { tone: "mid" }));
  out.push(L(k.knurl(bx, by, 5.4, 18.1, 23.1, 30, P), { tone: "lo" }));
  // Label band between the two seams: three text rules.
  out.push(L([5, 6, 7].map((z) => G.arcOf(F, z, 10, P, { from: Math.PI * 0.05, to: Math.PI * 0.45 })).join(""), { tone: "lo", free: true }));

  // Pen tray.
  const tray = { x: 72, y: -14, w: 52, d: 15, r: 3 };
  out.push(S(k.slabOf(tray, 0, 3.6, P, 4, 0.5), { tone: "mid" }));
  const well = k.insetPlan(tray, 2.2);
  out.push(`<path class="iso-shade" data-shade="0" d="${k.pathOf(k.roundedPlan(well, 4).map(([x, y]) => at([x, y, 3.6])), true)}"/>`);
  out.push(L(k.planOutline(well, 3.6, P, 4), { tone: "lo" }));
  // Dip pen lying in the tray: holder, grip, ferrule, nib.
  const PF = G.frameAlong([76, -6.5, 4.6], [1, 0.04, 0]);
  out.push(S(G.solidOf([[0, 1.1], [1.5, 1.5], [26, 1.7], [27, 2.1], [33, 2.1], [34, 1.6]], PF, P, { steps: 28 }), { tone: "mid" }));
  out.push(L(G.ribsOf(PF, 27.4, 32.6, 2.1, 14, P), { tone: "lo" }));
  out.push(S(G.solidOf([[34, 1.6], [37.5, 1.4], [38, 1.0]], PF, P), { tone: "hi", crease: "lo" }));
  out.push(S(G.solidOf([[38, 1.0], [41, 0.7, 1], [44, 0.18, 1], [44.6, 0]], PF, P, { steps: 24 }), { tone: "hi", crease: "lo" }));

  // Screentone sheet: backing paper with a dotted film, the near corner peeled and curling up.
  const sheet = { x: 72, y: 8, w: 52, d: 40, r: 0.4 };
  out.push(S(k.slabOf(sheet, 0, 0.6, P, 2), { tone: "hi", crease: "faint" }));
  const cx = sheet.x + sheet.w, cy = sheet.y + sheet.d; // near corner
  const f1 = [cx - 28, cy], f2 = [cx, cy - 22]; // fold line
  const film = [[sheet.x + 2, sheet.y + 2], [cx - 2, sheet.y + 2], [cx - 2, f2[1]], [f1[0], cy - 2], [sheet.x + 2, cy - 2]];
  out.push(`<path class="iso-top" d="${k.pathOf(film.map(([x, y]) => at([x, y, 0.8])), true)}"/>`);
  out.push(L(k.pathOf(film.map(([x, y]) => at([x, y, 0.8])), true), { tone: "mid" }));
  const inside = ([x, y]) => (x - f1[0]) * (f2[1] - f1[1]) - (y - f1[1]) * (f2[0] - f1[0]) > 1.2;
  const dots = [];
  for (let x = sheet.x + 4; x < cx - 3; x += 2.6) for (let y = sheet.y + 4; y < cy - 3; y += 2.6) if (inside([x, y])) dots.push(at([x, y, 0.8]));
  out.push(`<path d="${dots.map(([x, y]) => `M${x.toFixed(1)} ${y.toFixed(1)}h0`).join("")}" style="fill:none;stroke:#17171a;stroke-opacity:.55;stroke-width:1.05;stroke-linecap:round;vector-effect:none"/>`);
  // Curl: points beyond the fold roll up round a cylinder of radius R lying on the fold.
  const fl = Math.hypot(f2[0] - f1[0], f2[1] - f1[1]);
  const t = [(f2[0] - f1[0]) / fl, (f2[1] - f1[1]) / fl];
  const n = [-t[1], t[0]]; // outward, toward the corner
  const R = 8;
  const curl = ([x, y]) => {
    const d = (x - f1[0]) * n[0] + (y - f1[1]) * n[1];
    const s = (x - f1[0]) * t[0] + (y - f1[1]) * t[1];
    const th = d / R;
    const r = R * Math.sin(th);
    return [f1[0] + t[0] * s + n[0] * r, f1[1] + t[1] * s + n[1] * r, 0.8 + R * (1 - Math.cos(th))];
  };
  const corner = [cx - 2, cy - 2];
  const edge = (a, b, steps = 16) => Array.from({ length: steps + 1 }, (_, i) => curl([a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]));
  const g1 = [f1[0], cy - 2], g2 = [cx - 2, f2[1]];
  const flap = [...edge(g1, corner), ...edge(corner, g2)];
  const flapD = k.pathOf(flap.map(at), true);
  // Backing paper bared under the peel, then the curled film showing its plain back.
  const bare = k.pathOf([g1, corner, g2].map(([x, y]) => at([x, y, 0.62])), true);
  out.push(`<path class="iso-shade" data-shade="1" d="${bare}"/>`);
  out.push(L(bare, { tone: "faint" }));
  out.push(`<path class="iso-top" d="${flapD}"/>`);
  out.push(L(flapD, { tone: "hi" }));
}

write("welcome", {
  seed: 7,
  scale: 1.6,
  label: "A small drafting desk: a manga page with panel borders and a speech bubble clipped to a tilted board, a dip pen in its tray, an ink bottle and a half-peeled screentone sheet.",
  halos,
  body: out,
});
