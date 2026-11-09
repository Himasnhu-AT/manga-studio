// Review a scanned page before it becomes panels: the found panel borders sit on the scan, numbered in
// reading order. Drag a box to move it, its corners to resize, drag on empty paper to draw a missing one,
// Delete to remove one. Amber boxes are probably two panels merged. Create makes one panel per box (its
// crop is version 1) and a new page laid out the way it was drawn.

import { ArrowCounterClockwise, Trash, X } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Api, fileUrl, type Box, type Stage, type StoryDetail } from "../../lib/api";
import { orderSlots } from "../../lib/layout";
import { attempt, useApp } from "../../lib/store";
import { Button, IconButton, Segmented, cx } from "../../ui/kit";
import { useStudio, type ScanDraft } from "./studioState";

type Item = { box: Box; unclear?: boolean; key: number };
const STAGE_OPTS: { value: Stage; label: string; title: string }[] = [
  { value: "pencils", label: "Rough sketch", title: "Pencils: you'll ink or refine them" },
  { value: "inks", label: "Clean inks", title: "Inked: ready for tone and lettering" },
  { value: "finish", label: "Finished", title: "Done art: only lettering left" },
];
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const clamp = (v: number) => Math.min(1, Math.max(0, v));

export function ScanReview({ story, draft, onCreated }: { story: StoryDetail; draft: ScanDraft; onCreated: (pageId: string, panels: string[]) => void }) {
  const close = () => useStudio.getState().setScan(null);
  const keyRef = useRef(0);
  const fresh = () => draft.panels.map((p) => ({ box: p.box, unclear: p.unclear, key: keyRef.current++ }));
  const [items, setItems] = useState<Item[]>(fresh);
  const [sel, setSel] = useState<number | null>(null);
  const [stage, setStage] = useState<Stage>("pencils");
  const [busy, setBusy] = useState(false);
  const dir = story.format?.direction ?? "rtl";
  const ordered = orderSlots(items, dir);
  const numberOf = new Map(ordered.map((it, i) => [it.key, i + 1]));

  const wrap = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [W, H] = draft.size;
  const [fit, setFit] = useState(0.3);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const m = () => setFit(Math.min((el.clientWidth - 48) / W, (el.clientHeight - 48) / H));
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  const frac = (e: { clientX: number; clientY: number }) => {
    const r = sheet.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] as const;
  };

  const drag = (e: React.PointerEvent, onMove: (dx: number, dy: number, x: number, y: number) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const [sx, sy] = frac(e);
    const move = (ev: PointerEvent) => {
      const [x, y] = frac(ev);
      onMove(x - sx, y - sy, x, y);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const setBox = (key: number, box: Box) => setItems((xs) => xs.map((it) => (it.key === key ? { ...it, box, unclear: false } : it)));

  // drag on empty paper draws a new box
  const onPaperDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const [x0, y0] = frac(e);
    const key = keyRef.current++;
    setItems((xs) => [...xs, { box: [r4(x0), r4(y0), 0.001, 0.001], key }]);
    setSel(key);
    drag(e, (_dx, _dy, x, y) => {
      const [a, b] = [clamp(Math.min(x0, x)), clamp(Math.min(y0, y))];
      setBox(key, [r4(a), r4(b), r4(Math.abs(clamp(x) - x0)), r4(Math.abs(clamp(y) - y0))]);
    });
  };

  // drop boxes too small to be a panel once a drag ends
  useEffect(() => {
    const up = () => setItems((xs) => xs.filter((it) => it.box[2] > 0.02 && it.box[3] > 0.02));
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (sel !== null) setSel(null);
        else close();
      }
      if ((e.key === "Delete" || e.key === "Backspace") && sel !== null) {
        e.preventDefault();
        setItems((xs) => xs.filter((it) => it.key !== sel));
        setSel(null);
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  });

  const create = async () => {
    setBusy(true);
    const boxes = ordered.map((it) => it.box.map(r4));
    const r = await attempt(() => Api.applyScan(story.slug, { scan: draft.scan, boxes, stage }), `Made ${boxes.length} panels from ${draft.name}`);
    setBusy(false);
    if (r) {
      close();
      onCreated(r.page, r.panels);
    }
  };

  const src = fileUrl(story.slug, draft.scan);
  const unclear = items.filter((it) => it.unclear).length;

  return (
    <div className="absolute inset-0 flex bg-[#e9e9e6]">
      <div ref={wrap} className="relative flex min-w-0 flex-1 items-center justify-center">
        <div ref={sheet} className="relative shrink-0 bg-white shadow-[var(--shadow-page)]" style={{ width: W * fit, height: H * fit, cursor: "crosshair" }} onPointerDown={onPaperDown}>
          <img src={src} alt={draft.name} draggable={false} className="pointer-events-none absolute inset-0 size-full" />
          {items.map((it) => {
            const [x, y, w, h] = it.box;
            const on = sel === it.key;
            return (
              <div
                key={it.key}
                className={cx("absolute border-2", it.unclear ? "border-dashed border-warn bg-warn/10" : "border-accent bg-accent/[0.06]", on && "ring-2 ring-ink/60")}
                style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, cursor: "move" }}
                onPointerDown={(e) => {
                  setSel(it.key);
                  drag(e, (dx, dy) => setBox(it.key, [r4(clamp(x + dx)), r4(clamp(y + dy)), w, h]));
                }}
              >
                <span className={cx("num pointer-events-none absolute -top-3 -right-3 flex size-6 items-center justify-center rounded-full text-[11.5px] font-semibold text-white", it.unclear ? "bg-warn" : "bg-accent")}>
                  {numberOf.get(it.key)}
                </span>
                {it.unclear && <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-[6px] bg-white px-2 py-0.5 text-[11px] font-medium text-[#8a5a12] shadow">Two panels? Split by drawing two boxes</span>}
                {(["nw", "ne", "sw", "se"] as const).map((c) => (
                  <span
                    key={c}
                    role="presentation"
                    className="absolute size-3 border-2 border-accent bg-white"
                    style={{ left: c.includes("w") ? -6 : undefined, right: c.includes("e") ? -6 : undefined, top: c.includes("n") ? -6 : undefined, bottom: c.includes("s") ? -6 : undefined, cursor: c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize" }}
                    onPointerDown={(e) => {
                      setSel(it.key);
                      drag(e, (dx, dy) => {
                        let [x0, y0, x1, y1] = [x, y, x + w, y + h];
                        if (c.includes("w")) x0 = clamp(Math.min(x1 - 0.03, x0 + dx));
                        if (c.includes("e")) x1 = clamp(Math.max(x0 + 0.03, x1 + dx));
                        if (c.includes("n")) y0 = clamp(Math.min(y1 - 0.03, y0 + dy));
                        if (c.includes("s")) y1 = clamp(Math.max(y0 + 0.03, y1 + dy));
                        setBox(it.key, [r4(x0), r4(y0), r4(x1 - x0), r4(y1 - y0)]);
                      });
                    }}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-paper">
        <div className="flex items-start gap-2 px-4 pt-4 pb-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">
              {items.length} panel{items.length === 1 ? "" : "s"} found
            </h2>
            <p className="mt-1 text-[12.5px] leading-snug text-ink-2">
              Numbered in reading order, {dir === "rtl" ? "right to left" : "left to right"}. Drag a box or its corners to fix it, drag on the paper to add one, Delete removes the selected one.
            </p>
          </div>
          <IconButton label="Cancel (Esc)" size="sm" onClick={close}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3">
          {ordered.map((it, i) => {
            const [x, y, w, h] = it.box;
            return (
              <div key={it.key} className={cx("flex items-center gap-3 rounded-[10px] p-2", sel === it.key ? "bg-wash" : "hover:bg-wash/60", it.unclear && "ring-1 ring-warn")} onClick={() => setSel(it.key)}>
                <span className={cx("num flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white", it.unclear ? "bg-warn" : "bg-accent")}>{i + 1}</span>
                <span
                  className="h-12 w-10 shrink-0 rounded-[4px] border border-line bg-white"
                  style={{ backgroundImage: `url("${src}")`, backgroundSize: `${100 / Math.max(0.01, w)}% ${100 / Math.max(0.01, h)}%`, backgroundPosition: `${w < 1 ? (x / (1 - w)) * 100 : 0}% ${h < 1 ? (y / (1 - h)) * 100 : 0}%` }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">Panel {i + 1}</span>
                  <span className="num block text-[11.5px] text-ink-2">
                    {Math.round(w * W)} × {Math.round(h * H)} px
                  </span>
                </span>
                <IconButton
                  label={`Remove panel ${i + 1}`}
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setItems((xs) => xs.filter((x2) => x2.key !== it.key));
                  }}
                >
                  <Trash size={13} />
                </IconButton>
              </div>
            );
          })}
          {items.length === 0 && <p className="px-2 py-4 text-[12.5px] text-ink-2">No panels yet. Drag on the page to draw a box around each panel.</p>}
        </div>
        <div className="flex flex-col gap-3 border-t border-line p-4">
          <div className="flex flex-col gap-1.5">
            <span className="type-label">This page is</span>
            <Segmented<Stage> size="sm" value={stage} onChange={setStage} options={STAGE_OPTS} />
          </div>
          {unclear > 0 && <p className="text-[12px] text-[#8a5a12]">{unclear} box{unclear === 1 ? " looks" : "es look"} like two panels merged. Check before creating.</p>}
          <div className="flex gap-2">
            <Button
              icon={<ArrowCounterClockwise size={13} />}
              onClick={() => {
                setItems(fresh());
                setSel(null);
              }}
            >
              Reset boxes
            </Button>
            <Button variant="primary" className="flex-1" loading={busy} disabled={!items.length} onClick={() => void create()}>
              Create {items.length} panel{items.length === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** Upload a page scan and open the review. */
export async function startScan(slug: string, file: File) {
  const r = await attempt(() => Api.scanPage(slug, file));
  if (!r) return;
  if (!r.panels.length) useApp.getState().toast("No panel borders found. Draw a box around each panel.", "info");
  useStudio.getState().setScan({ ...r, name: file.name });
}
