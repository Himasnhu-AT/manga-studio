import { ArrowCounterClockwise, Eraser, PaintBrush, Sparkle, Swap } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Api, versionUrl, type Panel, type StoryDetail } from "../../lib/api";
import { attempt } from "../../lib/store";
import { Badge, Button, Input, Segmented, Sheet, cx } from "../../ui/kit";
import { Collapse, Slider, Thumb, refThumb } from "./side-common";

type Mode = "txt2img" | "img2img" | "inpaint";

/** In-panel AI Copilot: targeted generation with the panel's cast reference sheets injected. */
export function Copilot({ story, panel, source, setSource }: { story: StoryDetail; panel: Panel; source: string | null; setSource: (f: string | null) => void }) {
  const [mode, setMode] = useState<Mode>("txt2img");
  const [prompt, setPrompt] = useState("");
  const [strength, setStrength] = useState(0.6);
  const [count, setCount] = useState(1);
  const [mask, setMask] = useState<string | null>(null);
  const [painting, setPainting] = useState(false);
  const [busy, setBusy] = useState(false);

  // "Use as source" from the versions lightbox switches to img2img.
  useEffect(() => {
    if (source) setMode((m) => (m === "txt2img" ? "img2img" : m));
  }, [source]);
  useEffect(() => {
    setMask(null);
    setPrompt("");
  }, [panel.id]);

  const src = source ?? panel.pick;
  const sheets = useMemo(() => {
    const out: { id: string; name: string; ref: string | null }[] = [];
    for (const cid of panel.cast ?? []) {
      const c = story.cast[cid];
      if (!c) continue;
      out.push({ id: cid, name: c.name || cid, ref: c.sheet ?? c.refs?.[0] ?? null });
    }
    return out;
  }, [panel.cast, story.cast]);

  const needsSource = mode !== "txt2img";
  const canRun = !busy && (!needsSource || !!src) && (mode !== "inpaint" || !!mask);

  async function run() {
    setBusy(true);
    const r = await attempt(
      () =>
        Api.copilot(story.slug, panel.id, {
          mode,
          prompt: prompt.trim() || undefined,
          source: needsSource ? (src ?? undefined) : undefined,
          mask: mode === "inpaint" ? (mask ?? undefined) : undefined,
          strength: needsSource ? strength : undefined,
          count,
        }),
      `Queued ${count} ${mode} job${count > 1 ? "s" : ""} for ${panel.id}`,
    );
    setBusy(false);
    if (r && mode === "inpaint") setMask(null);
  }

  return (
    <Collapse title="Copilot" icon={<Sparkle size={13} weight="fill" className="text-accent" />} defaultOpen={false}>
      <Segmented<Mode>
        size="sm"
        value={mode}
        onChange={setMode}
        className="self-start"
        options={[
          { value: "txt2img", label: "Text", title: "Generate from the prompt with cast refs" },
          { value: "img2img", label: "Image", title: "Rework an existing version" },
          { value: "inpaint", label: "Inpaint", title: "Change only a painted region" },
        ]}
      />

      <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={mode === "inpaint" ? "What should change in the painted area" : "Extra direction (optional)"} aria-label="Extra prompt" />

      {needsSource && (
        <div className="flex items-center gap-3">
          <Thumb src={src ? versionUrl(story.slug, panel.id, src) : null} alt="source" className="h-14 w-11 shrink-0" />
          <div className="min-w-0 flex-1 text-[12.5px]">
            <p className="text-ink-2">Source</p>
            <p className="num truncate">{src ?? "Generate a version first"}</p>
          </div>
          {source && (
            <Button size="sm" variant="ghost" icon={<Swap size={13} />} onClick={() => setSource(null)} title="Back to the version in use">
              Reset
            </Button>
          )}
        </div>
      )}

      {needsSource && <Slider label="Strength" value={strength} min={0.2} max={1} onChange={setStrength} />}
      {needsSource && <p className="-mt-1 text-[12px] text-ink-2">Lower stays closer to the source. Use 1.0 for big pose changes.</p>}

      {mode === "inpaint" && (
        <div className="flex items-center gap-2">
          <Button size="sm" icon={<PaintBrush size={13} />} onClick={() => setPainting(true)} disabled={!src}>
            {mask ? "Edit mask" : "Paint mask"}
          </Button>
          {mask && <Badge tone="ok">Mask ready</Badge>}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <p className="type-label">Cast references injected</p>
        {sheets.length === 0 ? (
          <p className="text-[12px] text-ink-2">No cast on this panel. Add characters in the Cast section above to lock identity.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {sheets.map((s) => (
              <div key={s.id} className="flex items-center gap-1.5 rounded-full border border-line bg-paper py-0.5 pr-2.5 pl-0.5">
                <Thumb src={s.ref ? refThumb(story, s.ref) : null} alt={s.name} className="size-5 rounded-full" />
                <span className="text-[12px]">{s.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Segmented size="sm" value={String(count)} onChange={(v) => setCount(Number(v))} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: <span className="num">{n}</span> }))} />
        <Button variant="primary" size="sm" className="ml-auto" icon={<Sparkle size={13} weight="fill" />} loading={busy} disabled={!canRun} onClick={() => void run()}>
          Run
        </Button>
      </div>

      {src && (
        <MaskPainter
          open={painting}
          onClose={() => setPainting(false)}
          image={versionUrl(story.slug, panel.id, src)}
          initial={mask}
          onSave={(m) => {
            setMask(m);
            setPainting(false);
          }}
        />
      )}
    </Collapse>
  );
}

const INK = "rgb(210, 69, 47)";

/** The backend wants white = change on transparent; the visible strokes are accent-colored. */
function exportMask(c: HTMLCanvasElement | null): string | null {
  if (!c) return null;
  const out = document.createElement("canvas");
  out.width = c.width;
  out.height = c.height;
  const ctx = out.getContext("2d")!;
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const a = d.data[i + 3] > 8 ? 255 : 0;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
    d.data[i + 3] = a;
  }
  ctx.putImageData(d, 0, 0);
  return out.toDataURL("image/png");
}

/** Paint a white-on-transparent mask at the image's native resolution. */
function MaskPainter({ open, onClose, image, initial, onSave }: { open: boolean; onClose: () => void; image: string; initial: string | null; onSave: (dataUrl: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [brush, setBrush] = useState(0.06); // fraction of image width
  const [erase, setErase] = useState(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    if (!open) return;
    const img = new Image();
    img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = image;
  }, [open, image]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !size) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    setEmpty(true);
    if (initial) {
      const m = new Image();
      m.onload = () => {
        ctx.drawImage(m, 0, 0, c.width, c.height);
        ctx.globalCompositeOperation = "source-in"; // recolor the stored white mask to the paint color
        ctx.fillStyle = INK;
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.globalCompositeOperation = "source-over";
        setEmpty(false);
      };
      m.src = initial;
    }
  }, [size, initial]);

  const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };

  const stroke = (p: { x: number; y: number }) => {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = brush * c.width;
    const from = last.current ?? p;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!erase) setEmpty(false);
  };

  const clear = () => {
    const c = canvas.current;
    if (!c) return;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setEmpty(true);
  };

  const invert = () => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const d = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const a = d.data[i + 3];
      d.data[i] = 210;
      d.data[i + 1] = 69;
      d.data[i + 2] = 47;
      d.data[i + 3] = 255 - a;
    }
    ctx.putImageData(d, 0, 0);
    setEmpty(false);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Paint the area to change"
      width={760}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={empty} onClick={() => onSave(exportMask(canvas.current))}>
            Use mask
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            value={erase ? "erase" : "paint"}
            onChange={(v) => setErase(v === "erase")}
            options={[
              { value: "paint", label: <><PaintBrush size={13} />Paint</> },
              { value: "erase", label: <><Eraser size={13} />Erase</> },
            ]}
          />
          <div className="w-52">
            <Slider label="Brush" value={brush} min={0.01} max={0.2} step={0.005} onChange={setBrush} format={(v) => `${Math.round(v * 100)}%`} />
          </div>
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={invert}>
              Invert
            </Button>
            <Button size="sm" variant="ghost" icon={<ArrowCounterClockwise size={13} />} onClick={clear}>
              Clear
            </Button>
          </div>
        </div>
        <div className="relative mx-auto w-full overflow-hidden rounded-[var(--radius-control)] bg-wash" style={size ? { aspectRatio: `${size.w} / ${size.h}`, width: `min(100%, calc(62vh * ${size.w / size.h}))` } : { height: 360 }}>
          {size ? (
            <>
              <img src={image} alt="" draggable={false} className="absolute inset-0 size-full object-contain" />
              <canvas
                ref={canvas}
                width={size.w}
                height={size.h}
                className={cx("absolute inset-0 size-full touch-none opacity-55", erase ? "cursor-cell" : "cursor-crosshair")}
                onPointerDown={(e) => {
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    /* synthetic pointers can't be captured */
                  }
                  drawing.current = true;
                  last.current = null;
                  stroke(toCanvas(e));
                }}
                onPointerMove={(e) => {
                  if (drawing.current) stroke(toCanvas(e));
                }}
                onPointerUp={() => {
                  drawing.current = false;
                  last.current = null;
                }}
                onPointerCancel={() => {
                  drawing.current = false;
                  last.current = null;
                }}
              />
            </>
          ) : (
            <div className="skeleton absolute inset-0" />
          )}
        </div>
        <p className="text-[12px] text-ink-2">Only the painted area is replaced. Everything else stays pixel-identical to the source.</p>
      </div>
    </Sheet>
  );
}
