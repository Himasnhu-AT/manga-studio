// Shared panel renderer (Studio + Reader). Layer stack, bottom to top:
//   background colour -> art raster (picked version) -> tone/FX (SVG) -> border -> lettering (SVG).
// Page devices (mirrors studio/export.py render_page): `subject: "pop"` draws the cut-out character again
// over the border so it breaks out of the frame; `"cutout"` drops the frame: only the character floats.
// The art frame keeps the raster's aspect; FX, lettering and editor overlays share its coordinates,
// so bubbles stay glued to the art when a page slot crops it.

import { memo, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Bubble, FxItem, Page, Panel, Sfx, SlotSubject, StoryDetail } from "../lib/api";
import { subjectUrl, versionUrl } from "../lib/api";
import { bubbleGeom, INK, LETTER_FONT, PAPER, sfxGeom, useFontRev } from "../lib/geometry";
import { artFrame, autoCrop, pageDims, panelSize, polyClip } from "../lib/layout";
import { cx } from "./kit";
import "./panel.css";

export interface LayerToggles {
  background: boolean;
  art: boolean;
  fx: boolean;
  lettering: boolean;
}
/** How far a popped-out character may leave its frame, as a fraction of the slot (export.POP_REACH). */
export const POP_REACH = 0.2;
export const ALL_LAYERS: LayerToggles = { background: true, art: true, fx: true, lettering: true };

export interface PanelViewProps {
  slug: string;
  panel: Panel;
  story?: StoryDetail;
  /** width / height of the slot. Omit to size the slot to the art (webtoon, reader scroll). */
  slotAspect?: number;
  poly?: [number, number][];
  layers?: LayerToggles;
  bubbles?: Bubble[];
  sfx?: Sfx[];
  /** Bubble index whose text is hidden (being edited inline). */
  hideText?: number | null;
  /** Rendered inside the art frame, above lettering (editor handles). */
  overlay?: ReactNode;
  /** Shown when the panel has no picked version. */
  empty?: ReactNode;
  className?: string;
  eager?: boolean;
  /** Panel border in CSS px (page slots). 0 / undefined = none. */
  borderPx?: number;
  /** Page device: the cut-out character pops out of the frame, or floats with no frame. Needs `panel.subject`. */
  subjectMode?: SlotSubject;
}

export const PanelView = memo(function PanelView({
  slug,
  panel,
  story,
  slotAspect,
  poly,
  layers = ALL_LAYERS,
  bubbles,
  sfx,
  hideText,
  overlay,
  empty,
  className,
  eager,
  borderPx,
  subjectMode,
}: PanelViewProps) {
  const { W, H } = panelSize(panel, story);
  const imgAspect = W / H;
  const contain = subjectMode === "cutout" && !!panel.subject;
  const frame = slotAspect
    ? contain
      ? artFrame(imgAspect, slotAspect, panel.crop, "contain")
      : artFrame(imgAspect, slotAspect, autoCrop({ ...panel, bubbles: bubbles ?? panel.bubbles, sfx: sfx ?? panel.sfx }, imgAspect, slotAspect))
    : { left: 0, top: 0, width: 100, height: 100 };
  const pl = panel.layers ?? {};
  const show = {
    background: layers.background && pl.background?.visible !== false,
    art: layers.art && pl.art?.visible !== false,
    fx: layers.fx && pl.fx?.visible !== false,
    lettering: layers.lettering && pl.lettering?.visible !== false,
  };
  const src = panel.pick ? versionUrl(slug, panel.id, panel.pick) : null;
  const mask = subjectMode && src ? subjectUrl(slug, panel.subject) : null;
  const frameStyle = { left: `${frame.left}%`, top: `${frame.top}%`, width: `${frame.width}%`, height: `${frame.height}%` };
  const bg = show.background ? (pl.background?.color ?? "#ffffff") : "transparent";
  const lettering = show.lettering && <Lettering bubbles={bubbles ?? panel.bubbles ?? []} sfx={sfx ?? panel.sfx ?? []} W={W} H={H} hideText={hideText} />;

  if (!mask) {
    return (
      <div className={cx("relative overflow-hidden", className)} style={{ aspectRatio: slotAspect ? undefined : `${W} / ${H}`, clipPath: polyClip(poly), background: bg }}>
        <div className="absolute" style={frameStyle}>
          {show.art && src && <Art src={src} eager={eager} />}
          {!src && empty}
          {show.fx && pl.fx?.items?.length ? <FxLayer items={pl.fx.items} W={W} H={H} /> : null}
        </div>
        <Border px={borderPx} poly={poly} />
        <div className="absolute" style={frameStyle}>
          {lettering}
          {overlay}
        </div>
      </div>
    );
  }

  // Cut-out character: the frame is clipped as usual (pop) or left out (cutout); the masked character is
  // drawn unclipped on top, then lettering. The outer box doesn't clip, so the character can leave the slot.
  const pop = subjectMode === "pop";
  const masked = { WebkitMaskImage: `url("${mask}")`, maskImage: `url("${mask}")`, WebkitMaskSize: "100% 100%", maskSize: "100% 100%" } as React.CSSProperties;
  return (
    <div className={cx("relative", className)} style={{ aspectRatio: slotAspect ? undefined : `${W} / ${H}` }}>
      {pop && (
        <div className="absolute inset-0 overflow-hidden" style={{ clipPath: polyClip(poly), background: bg }}>
          <div className="absolute" style={frameStyle}>
            {show.art && <Art src={src!} eager={eager} />}
            {show.fx && pl.fx?.items?.length ? <FxLayer items={pl.fx.items} W={W} H={H} /> : null}
          </div>
          <Border px={borderPx} poly={poly} />
        </div>
      )}
      {show.art && (
        // a pop-out reaches at most POP_REACH past the frame: a head or an arm, not the whole hidden picture
        <div className="pointer-events-none absolute inset-0" style={pop ? { clipPath: `inset(-${POP_REACH * 100}%)` } : undefined}>
          <div className="absolute" style={{ ...frameStyle, ...masked }}>
            <img src={src!} alt="" draggable={false} className="absolute inset-0 size-full object-fill" />
          </div>
        </div>
      )}
      <div className={cx("absolute inset-0", pop && "overflow-hidden")} style={pop ? { clipPath: polyClip(poly) } : undefined}>
        <div className="absolute" style={frameStyle}>
          {lettering}
          {overlay}
        </div>
      </div>
    </div>
  );
});

const BG_LAYERS: LayerToggles = { background: true, art: true, fx: true, lettering: false };

/**
 * A page's full-bleed background art (`page.background`): drawn behind every panel at the page's own
 * shape, faded by `opacity`. The classic giant face behind a row of small panels.
 */
export function PageBackground({ story, page, eager }: { story: StoryDetail; page: Page; eager?: boolean }) {
  const bg = page.background;
  const p = bg ? story.panels.find((x) => x.id === bg.panel) : undefined;
  if (!bg || !p?.pick) return null;
  const { page: pd } = pageDims(story.format);
  return (
    <div className="pointer-events-none absolute inset-0" style={{ opacity: bg.opacity ?? 0.35 }}>
      <PanelView slug={story.slug} panel={{ ...p, crop: bg.crop ?? { x: 0.5, y: 0.5, scale: 1 }, bubbles: [], sfx: [] }} story={story} slotAspect={pd.width / pd.height} layers={BG_LAYERS} className="size-full" eager={eager} />
    </div>
  );
}

/** Panel frame line, drawn inside the slot (the slot clips the outer half, like the export's inward stroke). */
function Border({ px, poly }: { px?: number; poly?: [number, number][] }) {
  if (!px) return null;
  const pts = (poly?.length ? poly : [[0, 0], [1, 0], [1, 1], [0, 1]]).map(([x, y]) => `${x * 100},${y * 100}`).join(" ");
  return (
    <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <polygon points={pts} fill="none" stroke={INK} strokeWidth={px * 2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Raster with a crossfade when the picked version changes (old stays until the new one decoded). */
function Art({ src, eager }: { src: string; eager?: boolean }) {
  const [shown, setShown] = useState(src);
  const [prev, setPrev] = useState<string | null>(null);
  useEffect(() => {
    if (src === shown) return;
    let alive = true;
    const img = new Image();
    img.src = src;
    img
      .decode()
      .catch(() => undefined)
      .then(() => {
        if (!alive) return;
        setPrev(shown);
        setShown(src);
      });
    return () => {
      alive = false;
    };
  }, [src, shown]);
  return (
    <>
      {prev && <img src={prev} alt="" draggable={false} className="absolute inset-0 size-full object-fill" />}
      <img
        key={shown}
        src={shown}
        alt=""
        draggable={false}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        className="absolute inset-0 size-full object-fill"
        style={prev ? { animation: "panel-xfade 240ms var(--ease-out) both" } : undefined}
        onAnimationEnd={() => setPrev(null)}
      />
    </>
  );
}

// ---- lettering -------------------------------------------------------------------

export function Lettering({ bubbles, sfx, W, H, hideText }: { bubbles: Bubble[]; sfx: Sfx[]; W: number; H: number; hideText?: number | null }) {
  useFontRev();
  return (
    <svg className="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      {sfx.map((s, i) => {
        const g = sfxGeom(s, W, H);
        return (
          <text
            key={`s${i}`}
            x={g.x}
            y={g.y}
            fontSize={g.px}
            fontFamily={LETTER_FONT}
            fontWeight={700}
            fill={g.color}
            textAnchor="middle"
            dominantBaseline="central"
            transform={g.rotate ? `rotate(${g.rotate} ${g.x} ${g.y})` : undefined}
          >
            {s.text}
          </text>
        );
      })}
      {bubbles.map((b, i) => (
        <BubbleShape key={b.id ?? i} b={b} W={W} H={H} hideText={hideText === i} />
      ))}
    </svg>
  );
}

export function BubbleShape({ b, W, H, hideText }: { b: Bubble; W: number; H: number; hideText?: boolean }) {
  const g = useMemo(() => bubbleGeom(b, W, H), [b, W, H]);
  return (
    <g>
      {g.tail?.kind === "poly" && (
        <polygon points={g.tail.points.map((p) => p.join(",")).join(" ")} fill={PAPER} stroke={INK} strokeWidth={g.lw} strokeLinejoin="round" />
      )}
      {g.tail?.kind === "dots" &&
        g.tail.circles.map((c, i) => <circle key={i} cx={c.x} cy={c.y} r={c.r} fill={PAPER} stroke={INK} strokeWidth={g.lw} />)}
      <path d={g.body} fill={PAPER} stroke={INK} strokeWidth={g.lw} strokeLinejoin="round" />
      {!hideText && (
        <g fontFamily={LETTER_FONT} fontWeight={700} fontSize={g.px} fill={INK}>
          {g.vertical
            ? g.glyphs.map((gl, i) => (
                <text key={i} x={gl.x} y={gl.y}>
                  {gl.ch}
                </text>
              ))
            : g.lines.map((l, i) => (
                <text key={i} x={l.x} y={l.y}>
                  {l.text}
                </text>
              ))}
        </g>
      )}
    </g>
  );
}

// ---- tone / FX ---------------------------------------------------------------------

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function FxLayer({ items, W, H }: { items: FxItem[]; W: number; H: number }) {
  const uid = useId().replace(/:/g, "");
  const s = W / 864;
  return (
    <svg className="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        {items.map((it, i) => {
          const [rx, ry, rw, rh] = it.region ?? [0, 0, 1, 1];
          return (
            <clipPath key={i} id={`${uid}-r${i}`}>
              <rect x={rx * W} y={ry * H} width={rw * W} height={rh * H} />
            </clipPath>
          );
        })}
        {items.map((it, i) => {
          if (it.type !== "screentone") return null;
          const d = it.density ?? 0.5;
          const gap = (5 + (1 - d) * 12) * s;
          const rad = gap * (0.18 + d * 0.22);
          return (
            <pattern key={i} id={`${uid}-p${i}`} width={gap} height={gap} patternUnits="userSpaceOnUse" patternTransform={`rotate(${it.angle ?? 45})`}>
              <circle cx={gap / 2} cy={gap / 2} r={rad} fill={INK} />
            </pattern>
          );
        })}
      </defs>
      {items.map((it, i) => {
        const op = it.opacity ?? 0.25;
        const clip = `url(#${uid}-r${i})`;
        if (it.type === "screentone") return <rect key={i} width={W} height={H} fill={`url(#${uid}-p${i})`} opacity={op} clipPath={clip} />;
        if (it.type === "speedlines") return <SpeedLines key={i} it={it} W={W} H={H} op={op} clip={clip} />;
        return <FocusLines key={i} it={it} W={W} H={H} op={op} clip={clip} />;
      })}
    </svg>
  );
}

function SpeedLines({ it, W, H, op, clip }: { it: Extract<FxItem, { type: "speedlines" }>; W: number; H: number; op: number; clip: string }) {
  const lines = useMemo(() => {
    const rand = rng(7);
    const n = Math.round(20 + (it.density ?? 0.5) * 80);
    const diag = Math.hypot(W, H);
    return Array.from({ length: n }, () => {
      const off = (rand() - 0.5) * diag;
      const len = diag * (0.25 + rand() * 0.6);
      const start = (rand() - 0.5) * diag;
      return { off, start, len, w: (0.6 + rand() * 2.4) * (W / 864) };
    });
  }, [it.density, W, H]);
  const a = it.angle ?? 0;
  return (
    <g clipPath={clip} opacity={op} transform={`rotate(${a} ${W / 2} ${H / 2})`}>
      {lines.map((l, i) => (
        <line key={i} x1={W / 2 + l.start} y1={H / 2 + l.off} x2={W / 2 + l.start + l.len} y2={H / 2 + l.off} stroke={INK} strokeWidth={l.w} strokeLinecap="round" />
      ))}
    </g>
  );
}

function FocusLines({ it, W, H, op, clip }: { it: Extract<FxItem, { type: "focuslines" }>; W: number; H: number; op: number; clip: string }) {
  const tris = useMemo(() => {
    const rand = rng(11);
    const n = Math.round(40 + (it.density ?? 0.5) * 120);
    const [cxF, cyF] = it.center ?? [0.5, 0.5];
    const cx = cxF * W;
    const cy = cyF * H;
    const R = Math.hypot(W, H);
    const clear = Math.min(W, H) * 0.28;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + rand() * 0.03;
      const inner = clear * (0.9 + rand() * 0.6);
      const half = 0.004 + rand() * 0.01;
      const p = (ang: number, rad: number) => `${cx + Math.cos(ang) * rad},${cy + Math.sin(ang) * rad}`;
      return `${p(a, inner)} ${p(a - half, R)} ${p(a + half, R)}`;
    });
  }, [it.density, it.center, W, H]);
  return (
    <g clipPath={clip} opacity={op}>
      {tris.map((t, i) => (
        <polygon key={i} points={t} fill={INK} />
      ))}
    </g>
  );
}
