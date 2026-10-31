// Shared helpers for the onboarding figures drawn by art-b (ai, project).
// Each figure is a standalone light-theme SVG whose styles are scoped to its own
// root id, so several can be inlined on one page without clashing and without
// depending on page CSS.
import { writeFileSync } from "node:fs";
import * as k from "./kit/iso-kit.mjs";

export const WIDTH = 480;
export const HEIGHT = 360;
export const PAD = 20;
export const INK = "#17171a";
export const ACCENT = "#d2452f";

// Light kit tones, with the app's ink and accent, and lines 1.15× the kit default.
const TOKENS = [
  "--anatomy-paper:#fbfbfa", "--anatomy-face:#ffffff", "--anatomy-top:#ffffff",
  "--anatomy-shade-0:#dcdcd9", "--anatomy-shade-1:#e5e5e2", "--anatomy-shade-2:#ededea", "--anatomy-shade-3:#f4f4f1",
  "--anatomy-lit-top:#ffffff", "--anatomy-lit-shade:#eeeeeb",
  `--anatomy-hi:${INK}`, "--anatomy-mid:#8a8a8f", "--anatomy-lo:#b4b4b8", "--anatomy-faint:#d4d4d6", `--anatomy-lit:${ACCENT}`,
  "--anatomy-halo:#8a8a80", "--anatomy-halo-opacity:.32", `--anatomy-dot:${INK}`,
  "--anatomy-red:#e5484d", "--anatomy-green:#30a46c", "--anatomy-blue:#3e63dd",
  "--anatomy-weight:.69px",
  "--anatomy-mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace",
].join(";");

/** The kit's figure rules, every selector scoped to `#id`. */
function scopedCss(id) {
  const rules = k.ISO_CSS.replace(/\s+/g, " ").match(/[^{}]+\{[^{}]*\}/g) ?? [];
  const keep = rules
    .map((rule) => rule.trim())
    .filter((rule) => !/^(\.iso\{|\.iso\[data-theme|\.iso-(figure|plate|legend|keys|key|swatch|svg\{)|@|.*iso-flow|.*iso-pulse|\.iso-line\[data-flow\])/.test(rule))
    .filter((rule) => !rule.startsWith("to{") && !/^\d/.test(rule));
  const scoped = keep.map((rule) => {
    const at = rule.indexOf("{");
    const selectors = rule.slice(0, at).split(",").map((s) => `#${id} ${s.trim()}`).join(",");
    return selectors + rule.slice(at);
  });
  return [
    `#${id}{${TOKENS};display:block;overflow:visible}`,
    `#${id} path,#${id} circle{vector-effect:non-scaling-stroke}`,
    `#${id} .iso-line,#${id} .iso-wire-end{stroke-linecap:round;stroke-linejoin:round}`,
    `#${id} .iso-halo{filter:url(#${id}-soft);transform:none}`,
    ...scoped.filter((rule) => !rule.includes(".iso-halo{")),
    // Ink outlines on every solid, like a pen drawing; the lit part keeps the accent.
    `#${id} .iso-edge[data-tone]{stroke:var(--anatomy-hi)}`,
    `#${id} .iso-solid[data-lit]>.iso-edge[data-tone]{stroke:var(--anatomy-lit)}`,
    // A black part (binder clip): darker paper and shades, lines stay ink.
    `#${id} .ob-dark{--anatomy-paper:#3a3a3f;--anatomy-top:#5a5a60;--anatomy-shade-0:#232326;--anatomy-shade-1:#2c2c30;--anatomy-shade-2:#35353a;--anatomy-shade-3:#414147;--anatomy-lo:#77777d;--anatomy-mid:#8f8f95}`,
    // A lit tube (class ob-lit on its group) is filled with the accent.
    `#${id} .ob-lit .tb-body{fill:${ACCENT}}#${id} .ob-lit .tb-shine{fill:#ec8a76}#${id} .ob-lit .tb-shade{fill:#a9351f}`,
  ].join("");
}

/**
 * Wrap the drawing: halo outside the hand filter, everything else inside it.
 * `name` makes the ids unique (ob-<name>, hand-<name>).
 */
export function figure({ name, label, halo, body, seed = 3, wobble = 1.6 }) {
  const id = `ob-${name}`;
  const defs = [
    `<filter id="hand-${name}" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="${seed}"/><feDisplacementMap in="SourceGraphic" scale="${wobble}"/></filter>`,
    `<filter id="${id}-soft" filterUnits="userSpaceOnUse" x="-40" y="-40" width="${WIDTH + 80}" height="${HEIGHT + 80}"><feGaussianBlur stdDeviation="9"/></filter>`,
  ].join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" class="iso-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${label}">`,
    `<style>${scopedCss(id)}</style>`,
    `<defs>${defs}</defs>`,
    `<g transform="translate(0 3)">${halo}</g>`,
    `<g filter="url(#hand-${name})">${Array.isArray(body) ? body.join("") : body}</g>`,
    `</svg>`,
  ].join("");
  // Coordinates to 1 decimal (path data and dot centres only).
  return svg.replace(/ (d|cx|cy)="([^"]*)"/g, (_, key, value) => ` ${key}="${value.replace(/-?\d*\.\d{2,}/g, (m) => String(Math.round(Number(m) * 10) / 10))}"`);
}

export function write(path, svg) {
  writeFileSync(path, svg);
  console.log(`wrote ${path} (${(svg.length / 1024).toFixed(1)} KB)`);
}

// Drawing shorthands.
export const S = (paths, style) => k.solidSvg(paths, style);
export const L = (d, style) => k.lineSvg(d, style);
export const D = (points, style) => k.dotsSvg(points, style);
