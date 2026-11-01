// Draw mode: the selected panel fills the canvas and you draw on it, like a page on the desk.
// Tools follow the manga workflow: blue pencil for the rough, G-pen / maru pen / brush pen for inks, white
// for corrections, and an eraser. Pen pressure (Apple Pencil via Sidecar, Wacom) sets the line weight;
// stabilization smooths the hand. Layers are the panel's `drawing` (studio/drawing.py): each stroke saves
// its layer, and Merge bakes them into a new version for Refine.

import { ArrowUUpLeft, ArrowUUpRight, Eye, EyeSlash, PaintBrush, Pen, PencilSimple, Plus, Stack, Trash, X, Eraser, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Api, layerUrl, versionUrl, type DrawLayer, type Panel, type StoryDetail } from "../../lib/api";
import { useDebounced } from "../../lib/live";
import { panelSize } from "../../lib/layout";
import { attempt, useApp } from "../../lib/store";
import { Button, IconButton, cx } from "../../ui/kit";
import { useStudio } from "./studioState";

type ToolId = "pencil" | "gpen" | "maru" | "brush" | "eraser";
const TOOLS: { id: ToolId; label: string; key: string; hint: string; icon: React.ReactNode }[] = [
  { id: "pencil", label: "Blue pencil", key: "P", hint: "Roughs. Light, drops out of inks", icon: <PencilSimple size={17} /> },
  { id: "gpen", label: "G-pen", key: "G", hint: "Inks with strong thick-thin from pressure", icon: <Pen size={17} /> },
  { id: "maru", label: "Maru pen", key: "M", hint: "Fine even lines: faces, details", icon: <Pen size={17} weight="light" /> },
  { id: "brush", label: "Brush pen", key: "B", hint: "Bold strokes and black fills", icon: <PaintBrush size={17} /> },
  { id: "eraser", label: "Eraser", key: "E", hint: "Erase on the active layer", icon: <Eraser size={17} /> },
];
const INKS = [
  { id: "ink", label: "Ink black", color: "#141416" },
  { id: "blue", label: "Non-photo blue", color: "#5b9bd5" },
  { id: "white", label: "White, for corrections", color: "#ffffff" },
] as const;

/** Line width for one segment: each pen has its own response to pressure (p in 0..1). */
function widthFor(tool: ToolId, size: number, p: number) {
  switch (tool) {
    case "pencil":
      return size * (0.45 + 0.55 * p);
    case "gpen":
      return size * (0.12 + 0.88 * Math.pow(p, 1.3));
    case "maru":
      return size * 0.45 * (0.55 + 0.45 * p);
    case "brush":
      return size * 1.8 * (0.06 + 0.94 * Math.pow(p, 1.7));
    case "eraser":
      return size * 3;
  }
}

const DEFAULT_LAYERS: DrawLayer[] = [
  { id: "rough", name: "Rough", opacity: 0.45 },
  { id: "inks", name: "Inks" },
];
const UNDO_LIMIT = 15;

export function DrawEditor({ story, panel }: { story: StoryDetail; panel: Panel }) {
  const close = () => useStudio.getState().setDraw(false);
  const { W, H } = panelSize(panel, story);
  const [layers, setLayers] = useState<DrawLayer[]>(() => (panel.drawing?.length ? panel.drawing : DEFAULT_LAYERS));
  const [active, setActive] = useState(() => (panel.drawing?.length ? panel.drawing[panel.drawing.length - 1].id : "rough"));
  const [tool, setTool] = useState<ToolId>(() => (panel.drawing?.length ? "gpen" : "pencil"));
  const [ink, setInk] = useState<(typeof INKS)[number]["id"]>(() => (panel.drawing?.length ? "ink" : "blue"));
  const [size, setSize] = useState(6);
  const [stab, setStab] = useState(4);
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [, bumpHistory] = useState(0);

  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const undo = useRef<{ id: string; data: ImageData }[]>([]);
  const redo = useRef<{ id: string; data: ImageData }[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1); // CSS px per canvas px at zoom 1

  // pick the tool's natural ink: pencil draws blue, pens draw black (white stays if chosen on purpose)
  const chooseTool = (t: ToolId) => {
    setTool(t);
    if (t === "pencil") setInk("blue");
    else if (t !== "eraser" && ink === "blue") setInk("ink");
  };

  // ---- persistence ------------------------------------------------------------------
  const listRef = useRef(layers);
  listRef.current = layers;
  const saveList = useDebounced((next: DrawLayer[]) => void attempt(() => Api.patchPanel(story.slug, panel.id, { drawing: next })), 400);
  const updateLayers = (next: DrawLayer[]) => {
    setLayers(next);
    saveList(next);
  };
  const timers = useRef(new Map<string, number>());
  const saveLayer = useCallback(
    (id: string, now = false) => {
      const run = async () => {
        timers.current.delete(id);
        const c = canvases.current.get(id);
        if (!c) return;
        setSaving((n) => n + 1);
        if (!panel.drawing?.length) await attempt(() => Api.patchPanel(story.slug, panel.id, { drawing: listRef.current }));
        await attempt(() => Api.putLayer(story.slug, panel.id, id, c.toDataURL("image/png")));
        setSaving((n) => n - 1);
      };
      window.clearTimeout(timers.current.get(id));
      if (now) return run();
      timers.current.set(id, window.setTimeout(() => void run(), 600));
      return undefined;
    },
    [story.slug, panel.id, panel.drawing?.length],
  );
  const flush = async () => {
    const ids = [...timers.current.keys()];
    await Promise.all(ids.map((id) => saveLayer(id, true)));
  };

  // load existing pixels once per layer canvas
  const loaded = useRef(new Set<string>());
  const bindCanvas = (id: string) => (el: HTMLCanvasElement | null) => {
    if (!el) {
      canvases.current.delete(id);
      return;
    }
    canvases.current.set(id, el);
    if (loaded.current.has(id)) return;
    loaded.current.add(id);
    const v = panel.drawing_files?.[id];
    if (v === undefined) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => el.getContext("2d")!.drawImage(img, 0, 0, W, H);
    img.src = layerUrl(story.slug, panel.id, id, v);
  };

  // fit the sheet to the viewport
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setFit(Math.min((el.clientWidth - 64) / W, (el.clientHeight - 64) / H));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);
  const scale = fit * zoom;

  // ---- strokes ----------------------------------------------------------------------
  const stroke = useRef<{ ctx: CanvasRenderingContext2D; x: number; y: number; sx: number; sy: number; pointer: number } | null>(null);
  const spaceHeld = useRef(false);

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = sheet.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const pressureOf = (e: PointerEvent | React.PointerEvent) => (e.pointerType === "pen" ? Math.max(0.02, e.pressure) : 0.7);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (spaceHeld.current) return pan(e);
    const layer = layers.find((l) => l.id === active);
    const c = canvases.current.get(active);
    if (!c || !layer) return;
    if (layer.visible === false) {
      useApp.getState().toast("This layer is hidden. Show it to draw on it.", "info");
      return;
    }
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const ctx = c.getContext("2d")!;
    undo.current.push({ id: active, data: ctx.getImageData(0, 0, W, H) });
    if (undo.current.length > UNDO_LIMIT) undo.current.shift();
    redo.current = [];
    bumpHistory((n) => n + 1);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = INKS.find((i) => i.id === ink)!.color;
    ctx.globalAlpha = tool === "pencil" ? 0.85 : 1;
    const p = toCanvas(e);
    stroke.current = { ctx, x: p.x, y: p.y, sx: p.x, sy: p.y, pointer: e.pointerId };
    // a tap leaves a dot
    ctx.beginPath();
    ctx.lineWidth = widthFor(tool, size, pressureOf(e));
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y);
    ctx.stroke();
  };

  const onMove = (e: React.PointerEvent) => {
    const p = toCanvas(e);
    setHover(p);
    const s = stroke.current;
    if (!s || s.pointer !== e.pointerId) return;
    const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent];
    const k = Math.min(0.85, stab * 0.085); // how much the line lags behind the hand
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const t = toCanvas(ev);
      s.sx += (t.x - s.sx) * (1 - k);
      s.sy += (t.y - s.sy) * (1 - k);
      s.ctx.beginPath();
      s.ctx.lineWidth = widthFor(tool, size, pressureOf(ev));
      s.ctx.moveTo(s.x, s.y);
      s.ctx.lineTo(s.sx, s.sy);
      s.ctx.stroke();
      s.x = s.sx;
      s.y = s.sy;
    }
  };

  const onUp = () => {
    if (!stroke.current) return;
    stroke.current.ctx.globalCompositeOperation = "source-over";
    stroke.current.ctx.globalAlpha = 1;
    stroke.current = null;
    void saveLayer(active);
  };

  const pan = (e: React.PointerEvent) => {
    const el = scroller.current!;
    const sx = e.clientX + el.scrollLeft;
    const sy = e.clientY + el.scrollTop;
    const move = (ev: PointerEvent) => {
      el.scrollLeft = sx - ev.clientX;
      el.scrollTop = sy - ev.clientY;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const step = (from: typeof undo, to: typeof redo) => {
    const item = from.current.pop();
    if (!item) return;
    const c = canvases.current.get(item.id);
    if (!c) return;
    const ctx = c.getContext("2d")!;
    to.current.push({ id: item.id, data: ctx.getImageData(0, 0, W, H) });
    ctx.putImageData(item.data, 0, 0);
    bumpHistory((n) => n + 1);
    void saveLayer(item.id);
  };

  // ---- keyboard ---------------------------------------------------------------------
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) step(redo, undo);
        else step(undo, redo);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === "Escape") return void flush().then(close);
      if (e.key === " ") {
        e.preventDefault();
        spaceHeld.current = true;
        return;
      }
      if (e.key === "[") setSize((v) => Math.max(1, Math.round(v / 1.25)));
      if (e.key === "]") setSize((v) => Math.min(80, Math.round(v * 1.25 + 1)));
      const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (t) chooseTool(t.id);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") spaceHeld.current = false;
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  });

  // save anything pending when leaving
  useEffect(() => () => void flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- layers -----------------------------------------------------------------------
  const addLayer = () => {
    const n = layers.length + 1;
    let id = `layer${n}`;
    while (layers.some((l) => l.id === id)) id = `layer${Math.floor(Math.random() * 9000 + 1000)}`;
    updateLayers([...layers, { id, name: `Layer ${n}` }]);
    setActive(id);
  };
  const removeLayer = (id: string) => {
    if (layers.length <= 1) return;
    const next = layers.filter((l) => l.id !== id);
    updateLayers(next);
    if (active === id) setActive(next[next.length - 1].id);
    void attempt(() => Api.deleteLayer(story.slug, panel.id, id));
  };
  const patchLayer = (id: string, p: Partial<DrawLayer>) => updateLayers(layers.map((l) => (l.id === id ? { ...l, ...p } : l)));

  const merge = async () => {
    await flush();
    const r = await attempt(() => Api.mergeDrawing(story.slug, panel.id), "Merged your drawing into a new version");
    if (!r) return;
    for (const c of canvases.current.values()) c.getContext("2d")!.clearRect(0, 0, W, H);
    undo.current = [];
    redo.current = [];
    bumpHistory((n) => n + 1);
  };

  const base = panel.pick ? versionUrl(story.slug, panel.id, panel.pick) : null;
  const cursorPx = Math.max(4, widthFor(tool, size, 0.7) * scale);
  const shown = useMemo(() => [...layers].reverse(), [layers]);

  return (
    <div className="absolute inset-0 flex bg-[#e9e9e6]">
      {/* tools */}
      <nav aria-label="Drawing tools" className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-line bg-paper py-3">
        {TOOLS.map((t) => (
          <IconButton key={t.id} label={`${t.label} (${t.key}): ${t.hint}`} active={tool === t.id} onClick={() => chooseTool(t.id)}>
            {t.icon}
          </IconButton>
        ))}
        <span className="my-2 h-px w-6 bg-line" />
        {INKS.map((i) => (
          <button
            key={i.id}
            type="button"
            aria-label={i.label}
            title={i.label}
            onClick={() => setInk(i.id)}
            className={cx("size-6 rounded-full", ink === i.id ? "ring-2 ring-accent ring-offset-2 ring-offset-paper" : "ring-1 ring-line-2")}
            style={{ background: i.color }}
          />
        ))}
        <span className="my-2 h-px w-6 bg-line" />
        <IconButton label="Undo (⌘Z)" disabled={!undo.current.length} onClick={() => step(undo, redo)}>
          <ArrowUUpLeft size={16} />
        </IconButton>
        <IconButton label="Redo (⇧⌘Z)" disabled={!redo.current.length} onClick={() => step(redo, undo)}>
          <ArrowUUpRight size={16} />
        </IconButton>
      </nav>

      {/* sheet */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-4 overflow-hidden border-b border-line bg-paper px-4 text-[12.5px] whitespace-nowrap">
          <span className="font-semibold">Draw</span>
          <span className="num text-ink-2">
            {panel.id}
            {panel.title ? ` · ${panel.title}` : ""}
          </span>
          <label className="flex items-center gap-2" htmlFor="draw-size">
            Size
            <input id="draw-size" type="range" min={1} max={80} value={size} onChange={(e) => setSize(Number(e.target.value))} className="w-28 accent-[var(--color-ink)]" />
            <span className="num w-6 text-ink-2">{size}</span>
          </label>
          <label className="flex items-center gap-2" htmlFor="draw-stab" title="Stabilization: smooths shaky lines. Higher lags a little behind the pen.">
            Smoothing
            <input id="draw-stab" type="range" min={0} max={10} value={stab} onChange={(e) => setStab(Number(e.target.value))} className="w-24 accent-[var(--color-ink)]" />
            <span className="num w-4 text-ink-2">{stab}</span>
          </label>
          <span className="flex items-center gap-1">
            <IconButton label="Zoom out" size="sm" onClick={() => setZoom((z) => Math.max(1, z / 1.25))}>
              <MagnifyingGlassMinus size={14} />
            </IconButton>
            <button type="button" className="num w-12 text-ink-2 hover:text-ink" onClick={() => setZoom(1)} title="Fit">
              {Math.round(zoom * 100)}%
            </button>
            <IconButton label="Zoom in" size="sm" onClick={() => setZoom((z) => Math.min(6, z * 1.25))}>
              <MagnifyingGlassPlus size={14} />
            </IconButton>
          </span>
          <span className="ml-auto text-ink-2" title="Space + drag pans, [ and ] change the size, ⌘Z undoes">
            {saving > 0 ? "Saving…" : "Saved"}
          </span>
          <IconButton label="Done (Esc)" size="sm" onClick={() => void flush().then(close)}>
            <X size={15} />
          </IconButton>
        </div>
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-h-full min-w-full items-center justify-center p-8" style={{ width: W * scale + 64, height: H * scale + 64 }}>
            <div
              ref={sheet}
              className="relative shrink-0 bg-white shadow-[var(--shadow-page)]"
              style={{ width: W * scale, height: H * scale, cursor: "none", touchAction: "none" }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onPointerLeave={() => setHover(null)}
            >
              {base && <img src={base} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full object-fill" />}
              {layers.map((l) => (
                <canvas
                  key={l.id}
                  ref={bindCanvas(l.id)}
                  width={W}
                  height={H}
                  className="pointer-events-none absolute inset-0 size-full"
                  style={{ opacity: l.opacity ?? 1, display: l.visible === false ? "none" : undefined }}
                />
              ))}
              {hover && (
                <span
                  className="pointer-events-none absolute rounded-full border border-ink/70 mix-blend-difference"
                  style={{ left: (hover.x / W) * 100 + "%", top: (hover.y / H) * 100 + "%", width: cursorPx, height: cursorPx, transform: "translate(-50%, -50%)", borderColor: "#fff" }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* layers */}
      <aside className="flex w-[248px] shrink-0 flex-col border-l border-line bg-paper">
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <h2 className="type-label flex items-center gap-1.5">
            <Stack size={13} /> Layers
          </h2>
          <IconButton label="Add layer" size="sm" onClick={addLayer}>
            <Plus size={14} />
          </IconButton>
        </div>
        <div className="flex flex-col gap-0.5 px-2">
          {shown.map((l) => (
            <div key={l.id} className={cx("flex flex-col gap-1.5 rounded-[var(--radius-control)] px-2 py-1.5", active === l.id ? "bg-accent-wash" : "hover:bg-wash")}>
              <div className="flex items-center gap-1.5">
                <IconButton label={l.visible === false ? "Show layer" : "Hide layer"} size="sm" onClick={() => patchLayer(l.id, { visible: l.visible === false ? undefined : false })}>
                  {l.visible === false ? <EyeSlash size={14} /> : <Eye size={14} />}
                </IconButton>
                <button type="button" className={cx("min-w-0 flex-1 truncate text-left text-[13px]", active === l.id && "font-semibold")} onClick={() => setActive(l.id)}>
                  {l.name}
                </button>
                <span className="num text-[11px] text-ink-2">{Math.round((l.opacity ?? 1) * 100)}%</span>
                {layers.length > 1 && (
                  <IconButton label={`Delete ${l.name}`} size="sm" onClick={() => removeLayer(l.id)}>
                    <Trash size={13} />
                  </IconButton>
                )}
              </div>
              {active === l.id && (
                <div className="flex items-center gap-2 pl-8">
                  <input
                    aria-label={`${l.name} name`}
                    value={l.name}
                    onChange={(e) => patchLayer(l.id, { name: e.target.value })}
                    className="h-7 min-w-0 flex-1 rounded-[6px] border border-line-2 bg-paper px-1.5 text-[12px]"
                  />
                  <input
                    aria-label={`${l.name} opacity`}
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={l.opacity ?? 1}
                    onChange={(e) => patchLayer(l.id, { opacity: Number(e.target.value) === 1 ? undefined : Number(e.target.value) })}
                    className="w-20 accent-[var(--color-accent)]"
                  />
                </div>
              )}
            </div>
          ))}
          <div className="flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-[13px] text-ink-2">
            <span className="size-7" />
            {panel.pick ? `Art · ${panel.pick}` : "Paper"}
          </div>
        </div>
        <div className="mt-auto flex flex-col gap-2 border-t border-line p-3">
          <p className="text-[12px] leading-snug text-ink-2">Your layers show on the page as they are. Merge them into a version to refine the drawing or edit its pixels.</p>
          <Button onClick={() => void merge()}>Merge into a new version</Button>
          <Button variant="primary" onClick={() => void flush().then(close)}>
            Done
          </Button>
        </div>
      </aside>
    </div>
  );
}
