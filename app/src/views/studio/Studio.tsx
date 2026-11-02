// Mode A: Manual Studio. Rail (pages + panels) | canvas with floating toolbars | Inspector.

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlowArrow, Plus, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { Api, type Page, type StoryDetail } from "../../lib/api";
import { useLive } from "../../lib/live";
import { applyTemplate, pageDims, storyPages, stripPanels, type TemplateId } from "../../lib/layout";
import { attempt, useApp } from "../../lib/store";
import { Button, Empty, spring } from "../../ui/kit";
import { ExportSheet } from "../ExportSheet";
import { Canvas, PAGE_BASE, type CanvasHandle } from "./Canvas";
import { CastStudio } from "./CastStudio";
import { ImageEditor } from "./ImageEditor";
import { Refine } from "./Refine";
import { DrawEditor } from "./DrawEditor";
import { ScanReview, startScan } from "./ScanReview";
import { ART_ACCEPT } from "./importArt";
import { StoryEditor } from "./StoryEditor";
import { Inspector } from "./Inspector";
import { Rail } from "./Rail";
import { useStudio } from "./studioState";
import { ActionBar, CanvasToolbar, setZoomLabel } from "./Toolbar";
import { LayoutBars } from "./LayoutBars";
import { UNPLACED_AT } from "../../lib/geometry";
import { useLettering } from "./useLettering";

export function Studio() {
  const slug = useApp((s) => s.slug)!;
  const story = useLive(() => Api.story(slug), [slug]);

  if (story.error && !story.data)
    return (
      <Empty
        icon={<WarningCircle size={20} />}
        title="Couldn't open this project"
        body={story.error.message}
        action={
          <Button onClick={() => story.reload()} size="sm">
            Try again
          </Button>
        }
      />
    );
  if (!story.data) return <StudioSkeleton />;
  return <StudioBody story={story.data} />;
}

function StudioBody({ story }: { story: StoryDetail }) {
  const { panel: selectedId, page: pageIdx, setPage, selectPanel, go } = useApp();
  const { inspector, layoutMode, editImage, setEditImage, refine, setRefine, draw, setDraw, scan } = useStudio();
  // a scanned page just became panels: jump to its page once the story has it
  const [goPage, setGoPage] = useState<string | null>(null);
  const canvas = useRef<CanvasHandle>(null);
  const [castOpen, setCastOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [letterBusy, setLetterBusy] = useState(false);
  const mode = story.format?.mode ?? "page";

  // ---- pages: optimistic local copy, debounced save --------------------------------
  const [localPages, setLocalPages] = useState<Page[] | null>(null);
  // Every change gets a number; the local copy is dropped only once the newest change has been
  // saved, so an older save landing first can't flash an older layout.
  const seq = useRef(0);
  const savedSeq = useRef(0);
  const queued = useRef<{ slug: string; pages: Page[]; n: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const serverPages = JSON.stringify(story.pages ?? []);
  useEffect(() => {
    if (savedSeq.current === seq.current) setLocalPages(null);
  }, [serverPages]);
  const pages = localPages ?? storyPages(story);
  const previewLayout = mode === "page" && !story.pages?.length && pages.length > 0;
  const flushPages = useCallback(async () => {
    window.clearTimeout(timer.current);
    const q = queued.current;
    queued.current = null;
    if (!q) return;
    await attempt(() => Api.putPages(q.slug, q.pages));
    savedSeq.current = Math.max(savedSeq.current, q.n);
  }, []);
  const onPagesChange = useCallback(
    (next: Page[]) => {
      setLocalPages(next);
      queued.current = { slug: story.slug, pages: next, n: ++seq.current };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flushPages(), 400);
    },
    [story.slug, flushPages],
  );
  // leaving the studio (or the window) right after a drag still saves it
  useEffect(() => {
    const onHide = () => void flushPages();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void flushPages();
    };
  }, [flushPages]);

  useEffect(() => {
    if (!goPage) return;
    const i = (story.pages ?? []).findIndex((p) => p.id === goPage);
    if (i >= 0) {
      setPage(i);
      setGoPage(null);
    }
  }, [goPage, story.pages, setPage]);

  // keep the page index valid; follow the selected panel to its page
  useEffect(() => {
    if (pageIdx >= pages.length && pages.length) setPage(pages.length - 1);
  }, [pageIdx, pages.length, setPage]);

  // default selection: first story panel
  useEffect(() => {
    if (!selectedId || !story.panels.some((p) => p.id === selectedId)) {
      const first = (mode === "page" ? pages[pageIdx]?.panels.find((s) => s.panel)?.panel : undefined) ?? stripPanels(story)[0]?.id ?? story.panels[0]?.id ?? null;
      selectPanel(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.slug, story.panels.length]);

  const selected = useMemo(() => story.panels.find((p) => p.id === selectedId) ?? null, [story.panels, selectedId]);
  const lettering = useLettering(story.slug, selected);
  // leaving the panel (deleted, or nothing selected) ends an edit session
  useEffect(() => {
    if (editImage && !selected) setEditImage(false);
    if (refine && !selected?.pick) setRefine(false);
    if (draw && !selected) setDraw(false);
  }, [editImage, selected, setEditImage, refine, setRefine, draw, setDraw]);

  // ---- keyboard ----------------------------------------------------------------------
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const st = useStudio.getState();
      if (st.editImage || st.refine || st.draw || st.scan) return; // the image editor / refine view own the keyboard while open
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "0") (e.preventDefault(), canvas.current?.fit(false));
        else if (e.key === "=" || e.key === "+") (e.preventDefault(), canvas.current?.zoomBy(1.25));
        else if (e.key === "-") (e.preventDefault(), canvas.current?.zoomBy(1 / 1.25));
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        if (!e.repeat) st.setSpace(true);
        return;
      }
      const sel = st.sel;
      // layout mode: Delete removes the selected slot, Escape lets go of it first
      if (st.layoutMode && st.slotSel !== null && mode === "page" && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        const i = st.slotSel;
        onPagesChange(pages.map((p, k) => (k === pageIdx ? { ...p, panels: p.panels.filter((_, j) => j !== i) } : p)));
        st.setSlotSel(null);
        return;
      }
      if (e.key === "Escape" && st.layoutMode && (st.slotSel !== null || st.pickSubject !== null)) {
        st.setSlotSel(null);
        return;
      }
      if (e.key === "Escape") {
        if (st.layoutMode) st.setLayoutMode(false);
        else st.setSel(null);
        return;
      }
      if (sel && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        if (sel.kind === "bubble") lettering.updateBubbles((bs) => bs.filter((_, j) => j !== sel.i));
        else lettering.updateSfx((ss) => ss.filter((_, j) => j !== sel.i));
        st.setSel(null);
        return;
      }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (sel && arrows[e.key]) {
        e.preventDefault();
        const step = e.shiftKey ? 0.02 : 0.005;
        const [dx, dy] = arrows[e.key];
        const nudge = (at: [number, number]): [number, number] => [Math.round(Math.min(1, Math.max(0, at[0] + dx * step)) * 1000) / 1000, Math.round(Math.min(1, Math.max(0, at[1] + dy * step)) * 1000) / 1000];
        if (sel.kind === "bubble") lettering.updateBubbles((bs) => bs.map((b, j) => (j === sel.i ? { ...b, at: nudge(b.at ?? UNPLACED_AT) } : b)));
        else lettering.updateSfx((ss) => ss.map((x, j) => (j === sel.i ? { ...x, at: nudge(x.at) } : x)));
        return;
      }
      if (!sel && mode === "page" && (e.key === "PageDown" || e.key === "PageUp")) {
        e.preventDefault();
        const ni = Math.min(pages.length - 1, Math.max(0, pageIdx + (e.key === "PageDown" ? 1 : -1)));
        setPage(ni);
        return;
      }
      const tools: Record<string, "select" | "bubble" | "sfx" | "pan"> = { v: "select", b: "bubble", s: "sfx", h: "pan" };
      if (tools[e.key.toLowerCase()] && !st.layoutMode) st.setTool(tools[e.key.toLowerCase()]);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") useStudio.getState().setSpace(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [lettering, mode, pages, pageIdx, setPage, onPagesChange]);

  const autoLetter = async () => {
    setLetterBusy(true);
    await lettering.flush();
    const r = await attempt(() => Api.letter(story.slug, mode === "page" ? pages[pageIdx]?.panels.map((s) => s.panel).filter(Boolean) : undefined));
    if (r) {
      const n = Object.values(r.placed).reduce((a, b) => a + b, 0);
      useApp.getState().toast(n ? `Placed ${n} bubble${n === 1 ? "" : "s"}` : "Every bubble already has a spot", n ? "ok" : "info");
    }
    setLetterBusy(false);
  };

  const applyTpl = (t: TemplateId) => {
    const page = pages[pageIdx];
    if (!page) return;
    const placed = new Set(pages.flatMap((p, i) => (i === pageIdx ? [] : p.panels.map((s) => s.panel))));
    const unplaced = stripPanels(story)
      .map((p) => p.id)
      .filter((id) => !placed.has(id));
    onPagesChange(pages.map((p, i) => (i === pageIdx ? applyTemplate(page, t, story.format, unplaced) : p)));
  };

  // no story panels yet (reference sheets don't count): start from a drawn page, a panel, or a script
  if (!stripPanels(story).length)
    return (
      <div className="relative flex h-full items-center justify-center">
        <Empty
          icon={<UploadSimple size={20} />}
          title="Start from your drawings"
          body="Bring in a page you drew or scanned: its panels are found for you, and each keeps your art. Or add a panel and work one at a time."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <label className="pressable inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[var(--radius-control)] bg-ink px-3.5 text-[13px] font-medium text-paper">
                <UploadSimple size={14} />
                Import a drawn page
                <input
                  type="file"
                  accept={ART_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void startScan(story.slug, f);
                    e.target.value = "";
                  }}
                />
              </label>
              <Button icon={<Plus size={14} />} onClick={async () => {
                const r = await attempt(() => Api.addPanel(story.slug, { title: "Opening" }));
                if (r) selectPanel(r.id);
              }}>
                Add panel
              </Button>
              <Button icon={<FlowArrow size={14} />} onClick={() => go("pipeline")}>
                From a script
              </Button>
            </div>
          }
        />
        <AnimatePresence>
          {scan && (
            <motion.div key="scan" className="absolute inset-0 z-20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <ScanReview
                story={story}
                draft={scan}
                onCreated={(pageId, panels) => {
                  setGoPage(pageId);
                  if (panels[0]) selectPanel(panels[0]);
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );

  return (
    <div className="flex h-full">
      <Rail story={story} pages={pages} previewLayout={previewLayout} onPagesChange={onPagesChange} onReveal={(pid) => canvas.current?.revealPanel(pid)} />

      <div className="@container relative min-w-0 flex-1">
        <Canvas ref={canvas} story={story} pages={pages} pageIdx={pageIdx} onPagesChange={onPagesChange} lettering={lettering} onZoom={setZoomLabel} />

        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3">
          <div className="relative">
            <CanvasToolbar pageMode={mode === "page"} canEdit={!!selected?.pick} onFit={() => canvas.current?.fit()} onZoomBy={(f) => canvas.current?.zoomBy(f)} onZoomTo={(z) => canvas.current?.zoomTo(z)} />
            {/* own row, out of flow, so it never squeezes the action bar */}
            <div className="absolute top-full left-0 mt-2 w-max max-w-[calc(100cqw-24px)]">
              <AnimatePresence>
                {layoutMode && mode === "page" && pages[pageIdx] && (
                  <LayoutBars story={story} page={pages[pageIdx]} onApply={applyTpl} onPage={(pg) => onPagesChange(pages.map((p, i) => (i === pageIdx ? pg : p)))} />
                )}
              </AnimatePresence>
            </div>
          </div>
          <ActionBar onLetter={autoLetter} letterBusy={letterBusy} onCast={() => setCastOpen(true)} onExport={() => setExportOpen(true)} onScript={() => setScriptOpen(true)} castCount={Object.keys(story.cast ?? {}).length} />
        </div>

        {mode === "page" && pages.length > 1 && <PageNav n={pages.length} i={pageIdx} onGo={setPage} />}

        <AnimatePresence>
          {editImage && selected && (
            <motion.div key="image-editor" className="absolute inset-0 z-20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <ImageEditor story={story} panel={selected} pageMode={mode === "page"} />
            </motion.div>
          )}
          {scan && (
            <motion.div key="scan" className="absolute inset-0 z-20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <ScanReview
                story={story}
                draft={scan}
                onCreated={(pageId, panels) => {
                  setGoPage(pageId);
                  if (panels[0]) selectPanel(panels[0]);
                }}
              />
            </motion.div>
          )}
          {draw && selected && (
            <motion.div key={`draw-${selected.id}`} className="absolute inset-0 z-20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <DrawEditor story={story} panel={selected} />
            </motion.div>
          )}
          {refine && selected?.pick && (
            <motion.div key={`refine-${selected.id}`} className="absolute inset-0 z-20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <Refine story={story} panel={selected} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {inspector && !draw && !scan && (
          <motion.aside
            key="inspector"
            className="w-[320px] shrink-0 overflow-y-auto border-l border-line bg-paper"
            initial={{ opacity: 0, transform: "translateX(16px)" }}
            animate={{ opacity: 1, transform: "translateX(0px)" }}
            exit={{ opacity: 0, transform: "translateX(16px)" }}
            transition={spring}
          >
            <Inspector story={story} panel={selected} />
          </motion.aside>
        )}
      </AnimatePresence>

      <CastStudio story={story} open={castOpen} onClose={() => setCastOpen(false)} />
      <ExportSheet slug={story.slug} open={exportOpen} onClose={() => setExportOpen(false)} />
      <StoryEditor story={story} pages={pages} pageIdx={pageIdx} open={scriptOpen} onClose={() => setScriptOpen(false)} />
    </div>
  );
}

function PageNav({ n, i, onGo }: { n: number; i: number; onGo: (i: number) => void }) {
  return (
    <div className="material absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line p-1 shadow-[var(--shadow-float)]">
      {Array.from({ length: n }, (_, k) => (
        <button
          key={k}
          onClick={() => onGo(k)}
          className={`pressable num h-7 min-w-7 rounded-full px-2 text-[12px] ${k === i ? "bg-ink text-paper" : "text-ink-2 hover:bg-wash hover:text-ink"}`}
          aria-label={`Page ${k + 1}`}
          aria-current={k === i}
        >
          {k + 1}
        </button>
      ))}
    </div>
  );
}

function StudioSkeleton() {
  const { page } = pageDims(undefined);
  return (
    <div className="flex h-full">
      <div className="flex w-[248px] flex-col gap-3 border-r border-line bg-paper p-3">
        <div className="skeleton h-7" />
        <div className="grid grid-cols-2 gap-2.5">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton" style={{ aspectRatio: `${page.width} / ${page.height}` }} />
          ))}
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-10" />
        ))}
      </div>
      <div className="canvas-bg flex flex-1 items-center justify-center">
        <div className="skeleton" style={{ width: PAGE_BASE * 0.7, aspectRatio: `${page.width} / ${page.height}` }} />
      </div>
      <div className="flex w-[320px] flex-col gap-3 border-l border-line bg-paper p-4">
        <div className="skeleton h-6 w-1/2" />
        <div className="skeleton h-24" />
        <div className="skeleton h-8" />
      </div>
    </div>
  );
}
