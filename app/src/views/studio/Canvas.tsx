// The Studio canvas: an infinite surface with pan/zoom held in motion values (no React render per
// frame). Page mode draws one page with its slots; webtoon mode draws a vertical strip.
// Zoom toward the cursor with ctrl/cmd+wheel or trackpad pinch; plain wheel pans; space+drag or the
// Pan tool drags the surface.

import { animate, motion, useMotionValue } from "motion/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ImageSquare, Sparkle } from "@phosphor-icons/react";
import { Api, type Page, type PageSlot, type Panel, type SlotSubject, type StoryDetail, type Vec2 } from "../../lib/api";
import { attempt, useApp } from "../../lib/store";
import { artFrame, autoCrop, borderFrac, clampBox, findGutters, moveGutter, orderSlots, pageDims, panelSize, polyClip, slotRect, stripPanels, type Gutter } from "../../lib/layout";
import { PageBackground, PanelView } from "../../ui/PanelView";
import { Button, cx, spring } from "../../ui/kit";
import { CanvasCtx } from "./canvasCtx";
import { LetteringEditor } from "./LetteringEditor";
import { useStudio } from "./studioState";
import type { LetteringApi } from "./useLettering";

export const PAGE_BASE = 720; // CSS px width of a page at 100%
export const COLUMN = 640; // CSS px width of the webtoon column at 100%
const PAD = 56;

export interface CanvasHandle {
  fit: (animated?: boolean) => void;
  zoomTo: (z: number, animated?: boolean) => void;
  zoomBy: (f: number) => void;
  revealPanel: (pid: string) => void;
}

interface Props {
  story: StoryDetail;
  pages: Page[];
  pageIdx: number;
  onPagesChange: (pages: Page[]) => void;
  lettering: LetteringApi;
  onZoom: (z: number) => void;
}

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas({ story, pages, pageIdx, onPagesChange, lettering, onZoom }, ref) {
  const vp = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const z = useMotionValue(1);
  const transform = useMemo(() => ({ x, y, z }), [x, y, z]);
  const { tool, spaceHeld } = useStudio();
  const selected = useApp((s) => s.panel);
  const mode = story.format?.mode ?? "page";
  const selPanel = story.panels.find((p) => p.id === selected);
  const standalone = selPanel && selPanel.strip === false ? selPanel : null; // reference sheets render alone
  const page = pages[pageIdx];
  const { page: pdim } = pageDims(story.format);

  useEffect(() => {
    onZoom(z.get());
    return z.on("change", onZoom);
  }, [z, onZoom]);

  const contentSize = useCallback(() => {
    const el = content.current;
    return { w: el?.offsetWidth ?? PAGE_BASE, h: el?.offsetHeight ?? PAGE_BASE };
  }, []);

  const setView = (nx: number, ny: number, nz: number, animated: boolean) => {
    if (animated) {
      animate(x, nx, spring);
      animate(y, ny, spring);
      animate(z, nz, spring);
    } else {
      x.jump(nx);
      y.jump(ny);
      z.jump(nz);
    }
  };

  const fit = useCallback(
    (animated = true) => {
      const v = vp.current;
      if (!v) return;
      const { w, h } = contentSize();
      const vw = v.clientWidth;
      const vh = v.clientHeight;
      if (mode === "webtoon" && !standalone) {
        const nz = Math.min(1, (vw - PAD * 2) / w);
        setView((vw - w * nz) / 2, PAD, nz, animated);
      } else {
        const nz = Math.min(2, (vw - PAD * 2) / w, (vh - PAD * 2) / h);
        setView((vw - w * nz) / 2, (vh - h * nz) / 2, nz, animated);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, standalone, contentSize],
  );

  const zoomAt = (nz: number, px: number, py: number, animated: boolean) => {
    nz = Math.min(4, Math.max(0.2, nz));
    const cz = z.get();
    const cx0 = (px - x.get()) / cz;
    const cy0 = (py - y.get()) / cz;
    setView(px - cx0 * nz, py - cy0 * nz, nz, animated);
  };

  useImperativeHandle(ref, () => ({
    fit,
    zoomTo: (nz, animated = true) => {
      const v = vp.current!;
      zoomAt(nz, v.clientWidth / 2, v.clientHeight / 2, animated);
    },
    zoomBy: (f) => {
      const v = vp.current!;
      zoomAt(z.get() * f, v.clientWidth / 2, v.clientHeight / 2, false);
    },
    revealPanel: (pid) => {
      if (mode !== "webtoon") return;
      const el = content.current?.querySelector<HTMLElement>(`[data-pid="${CSS.escape(pid)}"]`);
      if (!el) return;
      animate(y, PAD - el.offsetTop * z.get(), spring);
    },
  }));

  // Fit on first layout and whenever what we show changes shape.
  const fitKey = `${mode}|${standalone?.id ?? ""}|${mode === "page" ? pageIdx : ""}|${pdim.width}x${pdim.height}`;
  useLayoutEffect(() => {
    fit(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  // Wheel: ctrl/cmd = zoom toward cursor (also trackpad pinch in Chromium), otherwise pan.
  useEffect(() => {
    const v = vp.current;
    if (!v) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = v.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(z.get() * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top, false);
      } else {
        x.jump(x.get() - e.deltaX);
        y.jump(y.get() - e.deltaY);
      }
    };
    // Safari / WKWebView pinch
    let startZ = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      startZ = z.get();
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const ge = e as Event & { scale: number; clientX: number; clientY: number };
      const r = v.getBoundingClientRect();
      zoomAt(startZ * ge.scale, ge.clientX - r.left, ge.clientY - r.top, false);
    };
    v.addEventListener("wheel", onWheel, { passive: false });
    v.addEventListener("gesturestart", onGestureStart);
    v.addEventListener("gesturechange", onGestureChange);
    return () => {
      v.removeEventListener("wheel", onWheel);
      v.removeEventListener("gesturestart", onGestureStart);
      v.removeEventListener("gesturechange", onGestureChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refit when the viewport resizes (inspector toggled, window resized).
  useEffect(() => {
    const v = vp.current;
    if (!v) return;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      fit(false);
    });
    ro.observe(v);
    return () => ro.disconnect();
  }, [fit]);

  const panning = tool === "pan" || spaceHeld;
  const [grabbing, setGrabbing] = useState(false);
  const onPanDown = (e: React.PointerEvent) => {
    const middle = e.button === 1;
    if (!panning && !middle) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX - x.get();
    const sy = e.clientY - y.get();
    setGrabbing(true);
    const move = (ev: PointerEvent) => {
      x.jump(ev.clientX - sx);
      y.jump(ev.clientY - sy);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setGrabbing(false);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <CanvasCtx.Provider value={transform}>
      <div
        ref={vp}
        className={cx("canvas-bg absolute inset-0 overflow-hidden", panning && (grabbing ? "cursor-grabbing" : "cursor-grab"))}
        onPointerDownCapture={onPanDown}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) useStudio.getState().setSel(null);
        }}
      >
        <motion.div ref={content} className="absolute top-0 left-0 origin-top-left" style={{ x, y, scale: z }}>
          {standalone ? (
            <StandalonePanel story={story} panel={standalone} lettering={lettering} />
          ) : mode === "webtoon" ? (
            <Webtoon story={story} lettering={lettering} />
          ) : page ? (
            <PageSurface story={story} page={page} lettering={lettering} onChange={(pg) => onPagesChange(pages.map((p, i) => (i === pageIdx ? pg : p)))} />
          ) : (
            <div style={{ width: PAGE_BASE, height: (PAGE_BASE * pdim.height) / pdim.width }} />
          )}
        </motion.div>
        <div id="studio-float" className="pointer-events-none absolute inset-0" />
      </div>
    </CanvasCtx.Provider>
  );
});

// ---- one panel, wired for selection + lettering ---------------------------------

function EditablePanel({
  story,
  panel,
  lettering,
  slotAspect,
  poly,
  className,
  borderPx,
  subjectMode,
}: {
  story: StoryDetail;
  panel: Panel;
  lettering: LetteringApi;
  slotAspect?: number;
  poly?: [number, number][];
  className?: string;
  borderPx?: number;
  subjectMode?: SlotSubject;
}) {
  const selected = useApp((s) => s.panel) === panel.id;
  const { layers, editing, layoutMode, tool } = useStudio();
  const { W, H } = panelSize(panel, story);
  const select = (e: React.PointerEvent) => {
    if (tool === "pan") return;
    if (!selected) {
      useApp.getState().selectPanel(panel.id);
      useStudio.getState().setSel(null);
      // one click with the Bubble/SFX tool selects the panel and places the item
      if ((tool === "bubble" || tool === "sfx") && panel.pick) {
        e.preventDefault(); // keep focus for the text box the editor opens on mount
        useStudio.getState().setPendingAdd({ pid: panel.id, x: e.clientX, y: e.clientY });
      }
    }
  };
  return (
    <div className={cx("relative size-full", className)} onPointerDown={select}>
      <PanelView
        slug={story.slug}
        panel={panel}
        story={story}
        slotAspect={slotAspect}
        poly={poly}
        borderPx={borderPx}
        subjectMode={subjectMode}
        layers={layers}
        bubbles={selected ? lettering.bubbles : undefined}
        sfx={selected ? lettering.sfx : undefined}
        hideText={selected ? editing : null}
        className={slotAspect ? "size-full" : "w-full"}
        overlay={selected && !layoutMode ? <LetteringEditor panel={panel} W={W} H={H} l={lettering} /> : undefined}
        empty={<NotDrawn story={story} panel={panel} />}
      />
    </div>
  );
}

function NotDrawn({ story, panel }: { story: StoryDetail; panel: Panel }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-[#f7f7f5] text-center">
      <ImageSquare size={22} className="text-ink-3" />
      <p className="text-[12.5px] text-ink-2">Not drawn yet</p>
      {panel.plan_error ? (
        <p className="max-w-[80%] text-[11.5px] text-warn">{panel.plan_error}</p>
      ) : (
        <Button
          size="sm"
          icon={<Sparkle size={13} />}
          loading={busy}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={async () => {
            setBusy(true);
            await attempt(() => Api.generate(story.slug, panel.id), `Queued ${panel.id}`);
            setBusy(false);
          }}
        >
          Generate
        </Button>
      )}
    </div>
  );
}

function SelectionRing({ poly, on }: { poly?: [number, number][]; on: boolean }) {
  if (!on) return null;
  if (poly?.length)
    return (
      <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polygon points={poly.map(([a, b]) => `${a * 100},${b * 100}`).join(" ")} fill="none" stroke="var(--color-accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
    );
  return <div className="pointer-events-none absolute -inset-px rounded-[1px] ring-2 ring-accent" />;
}

// ---- standalone (reference sheet / room plate) ----------------------------------------

function StandalonePanel({ story, panel, lettering }: { story: StoryDetail; panel: Panel; lettering: LetteringApi }) {
  const { W, H } = panelSize(panel, story);
  const w = W >= H ? 900 : PAGE_BASE * 0.85;
  return (
    <div style={{ width: w }} className="flex flex-col gap-2">
      <p className="type-label">Reference panel, not in the story</p>
      <div className="relative bg-paper shadow-[var(--shadow-page)]">
        <EditablePanel story={story} panel={panel} lettering={lettering} />
        <SelectionRing on />
      </div>
    </div>
  );
}

// ---- webtoon ------------------------------------------------------------------------

function Webtoon({ story, lettering }: { story: StoryDetail; lettering: LetteringApi }) {
  const selected = useApp((s) => s.panel);
  const panels = stripPanels(story);
  const gap = Math.round((story.format?.gutter ?? 0.018) * COLUMN * 2.2);
  if (!panels.length) return <div style={{ width: COLUMN, height: 400 }} />;
  return (
    <div className="flex flex-col bg-paper shadow-[var(--shadow-page)]" style={{ width: COLUMN, gap, paddingBlock: gap }}>
      {panels.map((p) => (
        <div key={p.id} data-pid={p.id} className="relative">
          <EditablePanel story={story} panel={p} lettering={lettering} />
          <SelectionRing on={selected === p.id} />
        </div>
      ))}
    </div>
  );
}

// ---- page -------------------------------------------------------------------------------

function PageSurface({ story, page, lettering, onChange }: { story: StoryDetail; page: Page; lettering: LetteringApi; onChange: (p: Page) => void }) {
  const { page: pd, live } = pageDims(story.format);
  const height = (PAGE_BASE * pd.height) / pd.width;
  const { layoutMode, slotSel, pickSubject, setSlotSel, setPickSubject } = useStudio();
  const selected = useApp((s) => s.panel);
  const liveRef = useRef<HTMLDivElement>(null);
  const dir = story.format?.direction ?? "rtl";
  const order = orderSlots(page.panels.map((s, i) => ({ ...s, i })), dir);
  const orderOf = new Map(order.map((s, n) => [s.i, n + 1]));
  const gutters = useMemo(() => (layoutMode ? findGutters(page.panels, story.format) : []), [layoutMode, page.panels, story.format]);
  const [cropOver, setCropOver] = useState<Record<string, NonNullable<Panel["crop"]>>>({});
  // drop local reframes once the server's copy has caught up (or another page is shown)
  const serverCrops = JSON.stringify(story.panels.map((p) => p.crop ?? null));
  useEffect(() => setCropOver({}), [serverCrops, page.id]);
  useEffect(() => setSlotSel(null), [page.id, setSlotSel]);
  const byId = new Map(story.panels.map((p) => [p.id, cropOver[p.id] ? { ...p, crop: cropOver[p.id] } : p]));
  const [dropAt, setDropAt] = useState<number | null>(null);
  const setSlot = (i: number, s: PageSlot) => onChange({ ...page, panels: page.panels.map((x, j) => (j === i ? s : x)) });

  /** Layout mode: drag the art inside its slot to move the crop's focal point (1:1 with the pointer). */
  const reframe = (e: React.PointerEvent, p: Panel, slotAspect: number) => {
    if (!layoutMode || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const { W, H } = panelSize(p, story);
    const base = autoCrop(p, W / H, slotAspect) ?? { x: 0.5, y: 0.5, scale: 1 };
    const f = artFrame(W / H, slotAspect, base);
    const overX = ((f.width - 100) / 100) * r.width; // px of art hidden horizontally
    const overY = ((f.height - 100) / 100) * r.height;
    const start = { x: e.clientX, y: e.clientY, fx: base.x, fy: base.y, scale: base.scale };
    let last = base;
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      const fx = overX > 0.5 ? Math.min(1, Math.max(0, start.fx - (ev.clientX - start.x) / overX)) : start.fx;
      const fy = overY > 0.5 ? Math.min(1, Math.max(0, start.fy - (ev.clientY - start.y) / overY)) : start.fy;
      last = { x: Math.round(fx * 1000) / 1000, y: Math.round(fy * 1000) / 1000, scale: start.scale };
      setCropOver((c) => ({ ...c, [p.id]: last }));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (moved) void attempt(() => Api.patchPanel(story.slug, p.id, { crop: last }));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  /** Waiting for a click on the character: turn the click into a point on the art and cut it out. */
  const cutOut = async (e: React.PointerEvent, i: number, p: Panel, slotAspect: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const { W, H } = panelSize(p, story);
    const cutout = page.panels[i].subject === "cutout" && !!p.subject;
    const f = cutout ? artFrame(W / H, slotAspect, p.crop, "contain") : artFrame(W / H, slotAspect, autoCrop(p, W / H, slotAspect));
    const sx = ((e.clientX - r.left) / r.width) * 100;
    const sy = ((e.clientY - r.top) / r.height) * 100;
    const point: Vec2 = [Math.min(1, Math.max(0, (sx - f.left) / f.width)), Math.min(1, Math.max(0, (sy - f.top) / f.height))];
    setPickSubject(null);
    const res = await attempt(() => Api.subject(story.slug, p.id, { point }), "Character cut out");
    if (res) setSlot(i, { ...page.panels[i], subject: page.panels[i].subject ?? "pop" });
  };

  const onSlotDown = (e: React.PointerEvent, i: number, p: Panel | undefined, slotAspect: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    if (pickSubject === i && p) {
      e.stopPropagation();
      void cutOut(e, i, p, slotAspect);
      return;
    }
    setSlotSel(i);
    if (p) reframe(e, p, slotAspect);
    else e.stopPropagation();
  };

  const assign = (slotIdx: number, pid: string) => {
    const slots = page.panels.map((s) => ({ ...s }));
    const from = slots.findIndex((s) => s.panel === pid);
    if (from >= 0 && from !== slotIdx) slots[from].panel = slots[slotIdx].panel; // swap
    slots[slotIdx].panel = pid;
    onChange({ ...page, panels: slots });
  };

  const black = page.paper === "black";
  const sel = layoutMode && slotSel !== null ? page.panels[slotSel] : undefined;

  return (
    <div className="relative overflow-hidden shadow-[var(--shadow-page)]" style={{ width: PAGE_BASE, height, background: black ? "#0c0c0e" : "var(--color-paper)" }}>
      <PageBackground story={story} page={page} />
      <div
        ref={liveRef}
        className="absolute"
        style={{ left: `${(live.x / pd.width) * 100}%`, top: `${(live.y / pd.height) * 100}%`, width: `${(live.w / pd.width) * 100}%`, height: `${(live.h / pd.height) * 100}%` }}
      >
        {layoutMode && <div className="pointer-events-none absolute -inset-px border border-dashed border-line-2" />}
        {page.panels.map((slot, i) => {
          const p = slot.panel ? byId.get(slot.panel) : undefined;
          const [bx, by, bw, bh] = slotRect(slot, story.format);
          const slotAspect = (bw * live.w) / (bh * live.h);
          const mode = slot.subject && p?.subject && p.pick ? slot.subject : undefined;
          const picking = pickSubject === i;
          return (
            <div
              key={i}
              className="absolute"
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("application/x-panel")) {
                  e.preventDefault();
                  setDropAt(i);
                }
              }}
              onDragLeave={() => setDropAt((d) => (d === i ? null : d))}
              onDrop={(e) => {
                const pid = e.dataTransfer.getData("application/x-panel");
                setDropAt(null);
                if (pid) assign(i, pid);
              }}
              onPointerDownCapture={layoutMode ? (e) => onSlotDown(e, i, p, slotAspect) : undefined}
              style={{ left: `${bx * 100}%`, top: `${by * 100}%`, width: `${bw * 100}%`, height: `${bh * 100}%`, cursor: picking ? "crosshair" : layoutMode && p ? "move" : undefined }}
            >
              {p ? (
                <EditablePanel story={story} panel={p} lettering={lettering} slotAspect={slotAspect} poly={slot.poly} borderPx={mode === "cutout" ? 0 : borderFrac(slot.border) * PAGE_BASE} subjectMode={mode} />
              ) : (
                <div className="flex size-full items-center justify-center border border-dashed border-line-2 bg-[#f7f7f5] text-[12px] text-ink-3" style={{ clipPath: polyClip(slot.poly) }}>
                  {slot.panel ? `Missing panel ${slot.panel}` : "Drop a panel here"}
                </div>
              )}
              <SelectionRing poly={slot.poly} on={layoutMode ? slotSel === i : !!p && selected === p.id} />
              {picking && (
                <div className="pointer-events-none absolute inset-0 flex items-start justify-center bg-accent/10 pt-2 ring-2 ring-accent ring-inset">
                  <span className="rounded-full bg-ink px-2.5 py-1 text-[11.5px] font-medium text-paper shadow-[var(--shadow-float)]">Click the character</span>
                </div>
              )}
              {dropAt === i && <div className="pointer-events-none absolute inset-0 bg-accent/10 ring-2 ring-accent ring-inset" style={{ clipPath: polyClip(slot.poly) }} />}
              <span
                className={cx(
                  "num pointer-events-none absolute top-1.5 flex size-5 items-center justify-center rounded-full bg-paper/90 text-[10.5px] font-semibold text-ink-2 shadow-[0_0_0_0.5px_rgb(23_23_26/0.15)]",
                  dir === "rtl" ? "right-1.5" : "left-1.5",
                )}
              >
                {orderOf.get(i)}
              </span>
            </div>
          );
        })}
        {gutters.map((g, gi) => (
          <GutterHandle key={gi} g={g} liveRef={liveRef} onMove={(pos) => onChange({ ...page, panels: moveGutter(page.panels, g, pos, story.format) })} format={story.format} />
        ))}
        {sel && slotSel !== null && <SlotHandles slot={sel} rect={slotRect(sel, story.format)} liveRef={liveRef} onChange={(s) => setSlot(slotSel, s)} />}
      </div>
    </div>
  );
}

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGES: { k: Edge; x: number; y: number; cursor: string }[] = [
  { k: "nw", x: 0, y: 0, cursor: "nwse-resize" },
  { k: "n", x: 0.5, y: 0, cursor: "ns-resize" },
  { k: "ne", x: 1, y: 0, cursor: "nesw-resize" },
  { k: "e", x: 1, y: 0.5, cursor: "ew-resize" },
  { k: "se", x: 1, y: 1, cursor: "nwse-resize" },
  { k: "s", x: 0.5, y: 1, cursor: "ns-resize" },
  { k: "sw", x: 0, y: 1, cursor: "nesw-resize" },
  { k: "w", x: 0, y: 0.5, cursor: "ew-resize" },
];

/**
 * Free editing of the selected slot: drag the grip to move it, the square handles to resize it, and the
 * round handles to move the corners of a custom shape. Overlapping slots are fine: later ones draw on top.
 */
function SlotHandles({ slot, rect, liveRef, onChange }: { slot: PageSlot; rect: [number, number, number, number]; liveRef: React.RefObject<HTMLDivElement | null>; onChange: (s: PageSlot) => void }) {
  const [rx, ry, rw, rh] = rect;
  const drag = (e: React.PointerEvent, apply: (dx: number, dy: number) => PageSlot) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = liveRef.current!.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) => onChange(apply((ev.clientX - sx) / r.width, (ev.clientY - sy) / r.height));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const [x, y, w, h] = slot.box;
  const resize = (k: Edge) => (dx: number, dy: number): PageSlot => {
    let x0 = x;
    let y0 = y;
    let x1 = x + w;
    let y1 = y + h;
    if (k.includes("w")) x0 = Math.min(x1 - 0.04, x0 + dx);
    if (k.includes("e")) x1 = Math.max(x0 + 0.04, x1 + dx);
    if (k.includes("n")) y0 = Math.min(y1 - 0.04, y0 + dy);
    if (k.includes("s")) y1 = Math.max(y0 + 0.04, y1 + dy);
    return { ...slot, box: clampBox([x0, y0, x1 - x0, y1 - y0]) };
  };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return (
    <div className="pointer-events-none absolute z-20" style={{ left: `${rx * 100}%`, top: `${ry * 100}%`, width: `${rw * 100}%`, height: `${rh * 100}%` }}>
      <button
        type="button"
        aria-label="Move panel"
        className="pointer-events-auto absolute -top-7 left-1/2 flex h-5 -translate-x-1/2 cursor-move items-center gap-1 rounded-full bg-accent px-2 text-[10.5px] font-semibold text-white shadow-[var(--shadow-float)]"
        onPointerDown={(e) => drag(e, (dx, dy) => ({ ...slot, box: clampBox([x + dx, y + dy, w, h]) }))}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M8 1v14M1 8h14M8 1 5.5 3.5M8 1l2.5 2.5M8 15l-2.5-2.5M8 15l2.5-2.5M1 8l2.5-2.5M1 8l2.5 2.5M15 8l-2.5-2.5M15 8l-2.5 2.5" />
        </svg>
        Move
      </button>
      {EDGES.map((d) => (
        <span
          key={d.k}
          role="presentation"
          className="pointer-events-auto absolute size-2.5 -translate-x-1/2 -translate-y-1/2 border-[1.5px] border-accent bg-white"
          style={{ left: `${d.x * 100}%`, top: `${d.y * 100}%`, cursor: d.cursor }}
          onPointerDown={(e) => drag(e, resize(d.k))}
        />
      ))}
      {slot.poly?.map(([px, py], vi) => (
        <span
          key={`v${vi}`}
          role="presentation"
          title="Drag the corner"
          className="pointer-events-auto absolute size-3.5 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-white bg-accent shadow-[0_0_0_1px_rgb(23_23_26/0.3)]"
          style={{ left: `${px * 100}%`, top: `${py * 100}%` }}
          onPointerDown={(e) =>
            drag(e, (dx, dy) => ({
              ...slot,
              poly: slot.poly!.map((q, qi) => (qi === vi ? ([r3(Math.min(1, Math.max(0, px + dx / rw))), r3(Math.min(1, Math.max(0, py + dy / rh)))] as Vec2) : q)),
            }))
          }
        />
      ))}
    </div>
  );
}

function GutterHandle({ g, liveRef, onMove, format }: { g: Gutter; liveRef: React.RefObject<HTMLDivElement | null>; onMove: (pos: number) => void; format: StoryDetail["format"] }) {
  const { gutter, page, live } = pageDims(format);
  const gw = (gutter * page.width) / (g.axis === "x" ? live.w : live.h); // gutter thickness in live fractions
  const style: React.CSSProperties =
    g.axis === "x"
      ? { left: `${(g.pos + gw / 2) * 100}%`, top: `${g.span[0] * 100}%`, height: `${(g.span[1] - g.span[0]) * 100}%`, width: 14, marginLeft: -7, cursor: "col-resize" }
      : { top: `${(g.pos + gw / 2) * 100}%`, left: `${g.span[0] * 100}%`, width: `${(g.span[1] - g.span[0]) * 100}%`, height: 14, marginTop: -7, cursor: "row-resize" };
  return (
    <div
      className="group absolute z-10 flex items-center justify-center"
      style={style}
      onPointerDown={(e) => {
        e.stopPropagation();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const r = liveRef.current!.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          const f = g.axis === "x" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
          onMove(f - gw / 2);
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    >
      <span className={cx("rounded-full bg-accent opacity-60 transition-opacity duration-150 group-hover:opacity-100", g.axis === "x" ? "h-8 w-[3px]" : "h-[3px] w-8")} />
    </div>
  );
}
