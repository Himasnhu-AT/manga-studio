// Shared helpers for the onboarding figures (welcome, mac, model).
// Each figure is a standalone light-theme SVG drawn with the anatomy kit, scoped by its own
// root id (`ob-<name>`) so several can be inlined on one page without touching page CSS.
// Build: `node app/art/onboarding/<name>.mjs` writes app/src/assets/onboarding/<name>.svg.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as G from "./kit/lathe.mjs";

export { k, G };

export const WIDTH = 480;
export const HEIGHT = 360;
export const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../src/assets/onboarding");

// Light kit tokens plus the app's ink and vermilion accent.
const OVERRIDES = "--anatomy-hi:#17171a;--anatomy-lit:#d2452f;--anatomy-dot:#17171a;--anatomy-weight:.69px;";

// ISO_CSS scoped to one root id: theme blocks become the id, drawing rules get the id as a prefix,
// page/plate/legend/swatch/animation rules are dropped.
export function scopedCss(id) {
  const css = k.ISO_CSS.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out = [];
  for (const [, rawSel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = rawSel.trim();
    if (sel === ".iso") {
      out.push(`#${id}{${body}}`);
      continue;
    }
    if (sel === '.iso[data-theme="light"]') {
      out.push(`#${id}{${body}${OVERRIDES}}`);
      continue;
    }
    if (sel.startsWith(".iso[") || sel.startsWith("body") || /iso-(plate|legend|keys|key|swatch|figure|page|caption)/.test(sel)) continue;
    if (/animation/.test(body)) continue;
    const scoped = sel
      .split(",")
      .map((part) => {
        const s = part.trim();
        return s.startsWith(".iso-svg") ? `#${id}${s.slice(".iso-svg".length)}` : `#${id} ${s}`;
      })
      .join(",");
    out.push(`${scoped}{${body}}`);
  }
  return out.join("").replace(/\s+/g, " ");
}

// Plane helper: points given as (a, b) on the plane origin + a·u + b·v.
export function plane(o, u, v) {
  const at3 = (a, b, lift = 0, n = [0, 0, 0]) => [
    o[0] + u[0] * a + v[0] * b + n[0] * lift,
    o[1] + u[1] * a + v[1] * b + n[1] * lift,
    o[2] + u[2] * a + v[2] * b + n[2] * lift,
  ];
  return { o, u, v, at3 };
}

export const ellipse = (cx, cy, rx, ry, steps = 40, from = 0, to = Math.PI * 2) =>
  Array.from({ length: steps + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / steps;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });

export function halo(d) {
  return `<path class="iso-halo" d="${d}"/>`;
}

// Wrap and write the figure. `halos` stay outside the hand-drawn filter; `body` goes inside it.
export function write(name, { seed, scale = 1.6, label, halos = [], body }) {
  const id = `ob-${name}`;
  const filter = `<filter id="hand-${name}" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="${seed}"/><feDisplacementMap in="SourceGraphic" scale="${scale}"/></filter>`;
  // Smaller path data: drop repeated points and the L after a coordinate (implicit lineto).
  const tidy = (d) =>
    d
      .replace(/L(-?[\d.]+) (-?[\d.]+)(?=L\1 \2(?![\d.]))/g, "")
      .replace(/(\d)L/g, "$1 ");
  body = body.map((part) => part.replace(/ d="([^"]*)"/g, (_, d) => ` d="${tidy(d)}"`));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" class="iso-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${label.replace(/"/g, "&quot;")}">` +
    `<style>${scopedCss(id)}#${id} .iso-line{stroke-linecap:round;stroke-linejoin:round}` +
    // Ink silhouettes (pen and ink), the lit part's silhouette in the accent.
    `#${id} .iso-edge[data-tone]{stroke:var(--anatomy-hi)}#${id} .iso-solid[data-lit]>.iso-edge[data-tone]{stroke:var(--anatomy-lit)}` +
    // Halo blur through a user-space filter so small halos aren't clipped to their bbox.
    `#${id} .iso-halo{filter:url(#${id}-soft);transform:none}</style>` +
    `<defs>${filter}<filter id="${id}-soft" filterUnits="userSpaceOnUse" x="-40" y="-40" width="560" height="440"><feGaussianBlur stdDeviation="9"/></filter></defs>` +
    `<g transform="translate(0 3)">${halos.join("")}</g>` +
    `<g filter="url(#hand-${name})">${body.join("")}</g></svg>\n`;
  if (process.env.SIZES) body.map((p, i) => [p.length, i, p.slice(0, 90)]).sort((a, b) => b[0] - a[0]).slice(0, 15).forEach((r) => console.log(r.join(" ")));
  const file = join(OUT, `${name}.svg`);
  writeFileSync(file, svg);
  console.log(`wrote ${file} (${(svg.length / 1024).toFixed(1)} KB)`);
  return svg;
}
