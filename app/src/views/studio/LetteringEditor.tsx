// Direct-manipulation lettering on the selected panel. Lives inside PanelView's art frame, so its
// SVG shares the raster's pixel coordinates. Drags are 1:1 with the pointer (grab offset kept,
// pointer capture, 3px hysteresis so a double-click never nudges). Nothing here touches the raster.

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChatCircle, ChatCircleDots, ChatTeardrop, Megaphone, Minus, Plus, Rectangle, TextColumns, Trash } from "@phosphor-icons/react";
import type { Bubble, BubbleStyle, Panel, Sfx, Vec2 } from "../../lib/api";
import { bubbleGeom, clamp, LETTER_FONT, round3, sfxGeom, snapToProtect, useFontRev } from "../../lib/geometry";
import { IconButton, cx } from "../../ui/kit";
import { useCanvasTick } from "./canvasCtx";
import { useStudio } from "./studioState";
import type { LetteringApi } from "./useLettering";

const HANDLE = "#d2452f";

let bid = 0;
const newId = () => `b${Date.now().toString(36)}${(bid++).toString(36)}`;

export function LetteringEditor({ panel, W, H, l }: { panel: Panel; W: number; H: number; l: LetteringApi }) {
  useFontRev();
  const svgRef = useRef<SVGSVGElement>(null);
  const { tool, sel, setSel, editing, setEditing } = useStudio();
  const { bubbles, sfx, updateBubbles, updateSfx, setBusy } = l;
  const s = W / 864;

  const frac = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = svgRef.current!.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
  };

  /** Pointer-captured drag with hysteresis. `move` receives the pointer in panel fractions. */
  const drag = (e: React.PointerEvent<Element>, move: (p: Vec2, start: Vec2) => void, onClick?: () => void) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = frac(e);
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    setBusy(true);
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      move(frac(ev), start);
    };
    const end = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      setBusy(false);
      if (!moved) onClick?.();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const setBubble = (i: number, patch: Partial<Bubble>) => updateBubbles((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const setOneSfx = (i: number, patch: Partial<Sfx>) => updateSfx((ss) => ss.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  // Background: add with the Bubble / SFX tools.
  const onBackground = (e: React.PointerEvent) => {
    if (tool === "bubble") {
      e.stopPropagation();
      e.preventDefault(); // no compatibility mousedown: it would steal focus from the new text box
      const [x, y] = frac(e);
      const b: Bubble = { id: newId(), text: "", at: [round3(x), round3(y)], w: 0.4, tail: [round3(x), round3(clamp(y + 0.14))], style: "speech" };
      updateBubbles((bs) => [...bs, b]);
      const i = bubbles.length;
      setSel({ kind: "bubble", i });
      setEditing(i);
      useStudio.getState().setTool("select"); // one placement per pick, like most design tools
    } else if (tool === "sfx") {
      e.stopPropagation();
      e.preventDefault();
      const [x, y] = frac(e);
      updateSfx((ss) => [...ss, { text: "BAM", at: [round3(x), round3(y)], size: 1.6, rotate: -8 }]);
      setSel({ kind: "sfx", i: sfx.length });
      useStudio.getState().setTool("select");
    } else if (tool === "select") {
      setSel(null);
    }
  };

  // place a Bubble/SFX click that arrived before this editor existed (it selected the panel)
  useEffect(() => {
    const pa = useStudio.getState().pendingAdd;
    if (!pa || pa.pid !== panel.id || !svgRef.current) return;
    useStudio.getState().setPendingAdd(null);
    onBackground({ clientX: pa.x, clientY: pa.y, stopPropagation() {}, preventDefault() {} } as React.PointerEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.id]);

  const geoms = useMemo(() => bubbles.map((b) => bubbleGeom(b, W, H)), [bubbles, W, H]);
  const sg = useMemo(() => sfx.map((x) => sfxGeom(x, W, H)), [sfx, W, H]);
  const interactive = tool !== "pan";

  return (
    <div className="absolute inset-0" style={{ pointerEvents: interactive ? undefined : "none" }}>
      <svg
        ref={svgRef}
        className="absolute inset-0 size-full"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ cursor: tool === "bubble" || tool === "sfx" ? "crosshair" : undefined }}
      >
        <rect width={W} height={H} fill="transparent" pointerEvents={tool === "bubble" || tool === "sfx" ? "all" : "none"} onPointerDown={onBackground} />

        {/* face / no-bubble boxes as faint guides */}
        {(panel.protect ?? []).map(([x, y, w, h], i) => (
          <rect key={`p${i}`} x={x * W} y={y * H} width={w * W} height={h * H} fill="none" stroke={HANDLE} strokeOpacity={0.35} strokeDasharray={`${6 * s} ${5 * s}`} strokeWidth={1.5 * s} pointerEvents="none" />
        ))}

        {sg.map((g, i) => {
          const on = sel?.kind === "sfx" && sel.i === i;
          const hw = g.w / 2 + 6 * s;
          const hh = g.px * 0.6;
          return (
            <g key={`s${i}`} transform={`rotate(${g.rotate} ${g.x} ${g.y})`}>
              <rect
                x={g.x - hw}
                y={g.y - hh}
                width={hw * 2}
                height={hh * 2}
                fill="transparent"
                stroke={on ? HANDLE : "transparent"}
                strokeWidth={1.5 * s}
                strokeDasharray={`${5 * s} ${4 * s}`}
                style={{ cursor: "move" }}
                onPointerDown={(e) => {
                  setSel({ kind: "sfx", i });
                  const at = sfx[i].at;
                  const off: Vec2 = [0, 0];
                  let first = true;
                  drag(e, (p, start) => {
                    if (first) {
                      off[0] = start[0] - at[0];
                      off[1] = start[1] - at[1];
                      first = false;
                    }
                    setOneSfx(i, { at: [round3(clamp(p[0] - off[0])), round3(clamp(p[1] - off[1]))] });
                  });
                }}
              />
              {on && (
                <>
                  <line x1={g.x} y1={g.y - hh} x2={g.x} y2={g.y - hh - 22 * s} stroke={HANDLE} strokeWidth={1.5 * s} />
                  <circle
                    cx={g.x}
                    cy={g.y - hh - 22 * s}
                    r={7 * s}
                    fill="#fff"
                    stroke={HANDLE}
                    strokeWidth={2 * s}
                    style={{ cursor: "grab" }}
                    onPointerDown={(e) =>
                      drag(e, (p) => {
                        // angle from the sfx centre to the pointer; handle sits straight up at 0deg
                        const deg = (Math.atan2(p[1] * H - g.y, p[0] * W - g.x) * 180) / Math.PI + 90;
                        const snapped = Math.abs(deg) < 3 ? 0 : deg;
                        setOneSfx(i, { rotate: Math.round(-snapped) });
                      })
                    }
                  />
                </>
              )}
            </g>
          );
        })}

        {geoms.map((g, i) => {
          const on = sel?.kind === "bubble" && sel.i === i;
          const b = bubbles[i];
          const bodyDrag = (e: React.PointerEvent) => {
            setSel({ kind: "bubble", i });
            const at = b.at;
            const off: Vec2 = [0, 0];
            let first = true;
            drag(e, (p, start) => {
              if (first) {
                off[0] = start[0] - at[0];
                off[1] = start[1] - at[1];
                first = false;
              }
              setBubble(i, { at: [round3(clamp(p[0] - off[0])), round3(clamp(p[1] - off[1]))] });
            });
          };
          return (
            <g key={b.id ?? i} onDoubleClick={(e) => (e.stopPropagation(), setSel({ kind: "bubble", i }), setEditing(i))}>
              {g.tail?.kind === "poly" && <polygon points={g.tail.points.map((p) => p.join(",")).join(" ")} fill="transparent" style={{ cursor: "move" }} onPointerDown={bodyDrag} />}
              <path d={g.body} fill="transparent" style={{ cursor: "move" }} onPointerDown={bodyDrag} />
              {on && (
                <>
                  <rect
                    x={g.bbox[0] - 6 * s}
                    y={g.bbox[1] - 6 * s}
                    width={g.bbox[2] + 12 * s}
                    height={g.bbox[3] + 12 * s}
                    fill="none"
                    stroke={HANDLE}
                    strokeWidth={1.5 * s}
                    strokeDasharray={`${5 * s} ${4 * s}`}
                    pointerEvents="none"
                  />
                  {/* width handle: drag sideways to change how wide the text wraps */}
                  <rect
                    x={g.cx + g.rx - 5 * s}
                    y={g.cy - 12 * s}
                    width={10 * s}
                    height={24 * s}
                    rx={5 * s}
                    fill="#fff"
                    stroke={HANDLE}
                    strokeWidth={2 * s}
                    style={{ cursor: "ew-resize" }}
                    onPointerDown={(e) =>
                      drag(e, (p) => {
                        const half = Math.abs(p[0] * W - g.cx) - (g.style === "caption" ? 14 : 34) * s;
                        setBubble(i, { w: round3(clamp((half * 2) / (0.72 * W), 0.1, 0.95)) });
                      })
                    }
                  />
                  {b.tail && g.style !== "caption" && (
                    <circle
                      cx={b.tail[0] * W}
                      cy={b.tail[1] * H}
                      r={8 * s}
                      fill={HANDLE}
                      stroke="#fff"
                      strokeWidth={2.5 * s}
                      style={{ cursor: "grab" }}
                      onPointerDown={(e) =>
                        drag(e, (p) => {
                          const t = snapToProtect(p, panel.protect);
                          setBubble(i, { tail: [round3(t[0]), round3(t[1])] });
                        })
                      }
                    />
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>

      {editing !== null && bubbles[editing] && geoms[editing] && (
        <InlineText
          key={bubbles[editing].id ?? editing}
          g={geoms[editing]}
          b={bubbles[editing]}
          W={W}
          H={H}
          onChange={(text) => setBubble(editing, { text })}
          onDone={() => {
            const i = editing;
            setEditing(null);
            if (!bubbles[i]?.text.trim()) {
              updateBubbles((bs) => bs.filter((_, j) => j !== i));
              setSel(null);
            }
          }}
        />
      )}

      {sel && <SelectionBar l={l} svgRef={svgRef} W={W} H={H} geoms={geoms} />}
    </div>
  );
}

/** Textarea laid over the bubble. Font size tracks the frame's layout width (zoom is a transform). */
function InlineText({ g, b, W, H, onChange, onDone }: { g: ReturnType<typeof bubbleGeom>; b: Bubble; W: number; H: number; onChange: (t: string) => void; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (host) setK(host.offsetWidth / W);
    const el = ref.current;
    if (el) {
      el.focus();
      // new bubble: nothing to keep; existing text: caret at the end, don't wipe it
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [W]);
  const maxW = W * (b.w ?? 0.42) * 0.72;
  const lh = Math.floor(g.px * 1.18);
  const boxW = g.vertical ? Math.max(g.tw, lh) + 8 : Math.max(maxW, g.tw) + 8;
  const boxH = g.vertical ? Math.max(g.th, g.px) + 8 : Math.max(g.th, lh) + 4;
  return (
    <textarea
      ref={ref}
      value={b.text}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          ref.current?.blur();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      spellCheck={false}
      placeholder="Type dialogue"
      className="selectable absolute resize-none overflow-hidden border-0 bg-transparent p-0 text-center outline-none placeholder:text-ink-3"
      style={{
        left: `${((g.cx - boxW / 2) / W) * 100}%`,
        top: `${((g.cy - boxH / 2) / H) * 100}%`,
        width: `${(boxW / W) * 100}%`,
        height: `${(boxH / H) * 100}%`,
        fontFamily: LETTER_FONT,
        fontWeight: 700,
        fontSize: g.px * k,
        lineHeight: 1.18,
        color: "rgb(25,25,30)",
        writingMode: g.vertical ? "vertical-rl" : undefined,
        caretColor: "#d2452f",
        outline: "none", // the global focus ring would draw a box over the bubble
      }}
    />
  );
}

const STYLES: { v: BubbleStyle; label: string; icon: React.ReactNode }[] = [
  { v: "speech", label: "Speech", icon: <ChatCircle size={15} /> },
  { v: "shout", label: "Shout", icon: <Megaphone size={15} /> },
  { v: "thought", label: "Thought", icon: <ChatCircleDots size={15} /> },
  { v: "caption", label: "Narration box", icon: <Rectangle size={15} /> },
];

/** Floating toolbar above the selection, rendered at screen scale (doesn't shrink with zoom). */
function SelectionBar({ l, svgRef, W, H, geoms }: { l: LetteringApi; svgRef: React.RefObject<SVGSVGElement | null>; W: number; H: number; geoms: ReturnType<typeof bubbleGeom>[] }) {
  useCanvasTick();
  const { sel, setSel, editing } = useStudio();
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById("studio-float")), []);
  const svg = svgRef.current;
  if (!sel || !host || !svg) return null;
  const r = svg.getBoundingClientRect();
  const hr = host.getBoundingClientRect();
  let bx: number, by: number;
  if (sel.kind === "bubble") {
    const g = geoms[sel.i];
    if (!g) return null;
    bx = r.left + ((g.bbox[0] + g.bbox[2] / 2) / W) * r.width;
    by = r.top + (g.bbox[1] / H) * r.height;
  } else {
    const s = l.sfx[sel.i];
    if (!s) return null;
    bx = r.left + s.at[0] * r.width;
    by = r.top + s.at[1] * r.height - 36;
  }
  const left = clamp(bx - hr.left, 150, hr.width - 150);
  const top = Math.max(8, by - hr.top - 48);

  const del = () => {
    if (sel.kind === "bubble") l.updateBubbles((bs) => bs.filter((_, j) => j !== sel.i));
    else l.updateSfx((ss) => ss.filter((_, j) => j !== sel.i));
    setSel(null);
  };

  return createPortal(
    <div
      className="material pointer-events-auto absolute flex -translate-x-1/2 items-center gap-0.5 rounded-[var(--radius-surface)] border border-line p-1 shadow-[var(--shadow-float)]"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {sel.kind === "bubble" && l.bubbles[sel.i] ? (
        <BubbleControls b={l.bubbles[sel.i]} set={(p) => l.updateBubbles((bs) => bs.map((b, j) => (j === sel.i ? { ...b, ...p } : b)))} editing={editing === sel.i} />
      ) : sel.kind === "sfx" && l.sfx[sel.i] ? (
        <SfxControls s={l.sfx[sel.i]} set={(p) => l.updateSfx((ss) => ss.map((x, j) => (j === sel.i ? { ...x, ...p } : x)))} />
      ) : null}
      <span className="mx-1 h-5 w-px bg-line" />
      <IconButton label="Delete" size="sm" onClick={del}>
        <Trash size={15} />
      </IconButton>
    </div>,
    host,
  );
}

function BubbleControls({ b, set, editing }: { b: Bubble; set: (p: Partial<Bubble>) => void; editing: boolean }) {
  const style = b.style ?? "speech";
  const size = b.size ?? 1;
  return (
    <>
      {STYLES.map((o) => (
        <IconButton key={o.v} label={o.label} size="sm" active={style === o.v} onClick={() => set({ style: o.v })}>
          {o.icon}
        </IconButton>
      ))}
      <span className="mx-1 h-5 w-px bg-line" />
      <IconButton label="Vertical text" size="sm" active={!!b.vertical} onClick={() => set({ vertical: !b.vertical })}>
        <TextColumns size={15} />
      </IconButton>
      <IconButton label="Smaller text" size="sm" onClick={() => set({ size: Math.max(0.5, Math.round((size - 0.1) * 10) / 10) })}>
        <Minus size={14} />
      </IconButton>
      <span className="num w-8 text-center text-[11.5px] text-ink-2">{Math.round(size * 100)}%</span>
      <IconButton label="Larger text" size="sm" onClick={() => set({ size: Math.min(2.5, Math.round((size + 0.1) * 10) / 10) })}>
        <Plus size={14} />
      </IconButton>
      {style !== "caption" && (
        <IconButton
          label={b.tail ? "Remove tail" : "Add tail"}
          size="sm"
          active={!!b.tail}
          onClick={() => set({ tail: b.tail ? null : [b.at[0], Math.min(1, b.at[1] + 0.14)] })}
        >
          <ChatTeardrop size={15} />
        </IconButton>
      )}
      {editing && <span className="ml-1 whitespace-nowrap pr-1 text-[11.5px] text-ink-2">Esc to finish</span>}
    </>
  );
}

function SfxControls({ s, set }: { s: Sfx; set: (p: Partial<Sfx>) => void }) {
  const size = s.size ?? 1;
  return (
    <>
      <input
        value={s.text}
        onChange={(e) => set({ text: e.target.value })}
        onKeyDown={(e) => e.stopPropagation()}
        className={cx("selectable h-7 w-28 rounded-[var(--radius-control)] border border-line-2 bg-paper px-2 text-[12.5px] outline-none focus:border-ink")}
        style={{ fontFamily: LETTER_FONT, fontWeight: 700 }}
        aria-label="Sound effect text"
      />
      <IconButton label="Smaller" size="sm" onClick={() => set({ size: Math.max(0.5, Math.round((size - 0.2) * 10) / 10) })}>
        <Minus size={14} />
      </IconButton>
      <span className="num w-8 text-center text-[11.5px] text-ink-2">{Math.round(size * 100)}%</span>
      <IconButton label="Larger" size="sm" onClick={() => set({ size: Math.min(5, Math.round((size + 0.2) * 10) / 10) })}>
        <Plus size={14} />
      </IconButton>
      <span className="num ml-1 text-[11.5px] text-ink-2">{Math.round(s.rotate ?? 0)}°</span>
    </>
  );
}
