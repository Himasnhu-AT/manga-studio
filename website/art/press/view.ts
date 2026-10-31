// World layout for the hero figure: a small pen plotter on a bench that turns a story into a page.
// Units are world px; x and y lie on the bench, z points up.
import { fitProjection, iso, type Flat, type Plan, type Point3 } from "../kit/iso-kit";

export const WIDTH = 640;
export const HEIGHT = 372;
export const AZIMUTH = 50;

export const BASE: Plan = { x: -178, y: -128, w: 356, d: 256, r: 10 };
export const BASE_H = 10;
export const FOOT_H = 5;

// Two rails along x carry the gantry.
export const RAIL_Y = 106;
export const RAIL_FROM = -166;
export const RAIL_TO = 166;
export const RAIL_D = 6;
export const RAIL_H = 4;

// The bed in the middle holds the page; trays on either side hold the story and finished pages.
export const PLATEN: Plan = { x: -64, y: -88, w: 128, d: 176, r: 4 };
export const PLATEN_H = 8;
export const PAGE: Plan = { x: -54, y: -76, w: 108, d: 152, r: 0.6 };
export const PAGE_TOP = PLATEN_H + 0.8;

export const TRAY_IN: Plan = { x: -158, y: -46, w: 62, d: 104, r: 3 };
export const TRAY_OUT: Plan = { x: 96, y: -54, w: 62, d: 108, r: 3 };
// A holder with two character reference cards standing in it, behind the story tray.
export const HOLDER_BLOCK: Plan = { x: -156, y: -92, w: 56, d: 12, r: 2 };
export const TRAY_FLOOR = 2;
export const TRAY_WALL = 2;
export const TRAY_H = 8;

// Gantry: a carriage on each rail, an upright on each, a bridge across y, and a pen head on the bridge's near face.
export const CAR: Plan = { x: -13, y: -8, w: 26, d: 16, r: 2 };
export const CAR_H = 7;
export const UPRIGHT: Plan = { x: -6, y: -5, w: 12, d: 10, r: 1.5 };
export const BRIDGE_Z = 58;
export const BRIDGE_H = 10;
export const BRIDGE: Plan = { x: -6, y: -112, w: 12, d: 224, r: 1.5 };
export const RAIL_STRIP: Plan = { x: 6, y: -98, w: 1.6, d: 196, r: 0.4 };

// The pen head rides the strip: a plate, a holder block, and the pen through it. It lifts by LIFT to travel.
export const PEN_DX = 17;
export const PEN_R = 3;
export const NIB = 4;
export const LIFT = 9;
export const PLATE_Z = 46;
export const PLATE_H = 26;
export const HOLDER_Z = 46;
export const HOLDER_H = 9;
export const PEN_TOP = 80;

// Head travel: the pen can reach the in-tray, the page and the out-tray.
export const HEAD_Y = 82;
export const GX_MIN = -146;
export const GX_MAX = 132;

const reach: Point3[] = [];
for (const plan of [BASE]) {
  for (const x of [plan.x, plan.x + plan.w]) for (const y of [plan.y, plan.y + plan.d]) reach.push([x, y, -BASE_H - FOOT_H]);
}
for (const gx of [GX_MIN, GX_MAX]) {
  for (const y of [BRIDGE.y, BRIDGE.y + BRIDGE.d]) reach.push([gx, y, BRIDGE_Z + BRIDGE_H]);
  reach.push([gx + PEN_DX, -HEAD_Y, PEN_TOP + LIFT + 2]);
}

export const P = fitProjection(reach, WIDTH, HEIGHT, { pad: 12, azimuth: AZIMUTH });
export const at = (point: Point3): Flat => iso(point, P);

// Page coordinates: u runs from the reader's left edge to the right edge, v from the top edge to the bottom.
// The page's top edge is the far (-y) edge; seen from the near edge, the reader's right hand is -x.
export const onPage = (u: number, v: number): [number, number] => [PAGE.x + PAGE.w - u * PAGE.w, PAGE.y + v * PAGE.d];
