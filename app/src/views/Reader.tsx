// Built-in reader: paged manga (single page or two-page spread, RTL/LTR) and continuous vertical
// scroll (webtoon, or pages stacked). Chrome fades while reading and comes back on pointer move.

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, BookOpenText, CaretLeft, CaretRight, Columns, PaintBrushBroad, Scroll, Square, WarningCircle } from "@phosphor-icons/react";
import { Api, type Page, type StoryDetail } from "../lib/api";
import { useLive } from "../lib/live";
import { borderFrac, pageDims, polyClip, slotRect, storyPages, stripPanels } from "../lib/layout";
import { useApp } from "../lib/store";
import { PageBackground, PanelView } from "../ui/PanelView";
import { Button, Empty, IconButton, Segmented, cx } from "../ui/kit";
import "../ui/panel.css";

type Layout = "paged" | "scroll";

export function Reader() {
  const slug = useApp((s) => s.slug)!;
  const story = useLive(() => Api.story(slug), [slug]);
  if (story.error && !story.data) return <Empty icon={<WarningCircle size={20} />} title="Couldn't open this project" body={story.error.message} />;
  if (!story.data) return <ReaderSkeleton />;
  return <ReaderBody story={story.data} />;
}

function ReaderBody({ story }: { story: StoryDetail }) {
  const go = useApp((s) => s.go);
  const mode = story.format?.mode ?? "page";
  const dir = story.format?.direction ?? "rtl";
  const pages = storyPages(story);
  const panels = stripPanels(story);
  const [layout, setLayout] = useState<Layout>(mode === "webtoon" ? "scroll" : "paged");
  const [spread, setSpread] = useState(false);
  const chrome = useChrome();

  if (!panels.length)
    return (
      <div className="flex h-full items-center justify-center">
        <Empty
          icon={<BookOpen size={20} />}
          title="Nothing to read yet"
          body="Panels show up here once they're drawn."
          action={
            <Button icon={<PaintBrushBroad size={14} />} onClick={() => go("studio")}>
              Open Studio
            </Button>
          }
        />
      </div>
    );

  return (
    <div className="relative h-full bg-[#ececea]" onPointerMove={chrome.poke}>
      {layout === "paged" && mode === "page" ? (
        <Paged story={story} pages={pages} dir={dir} spread={spread} chromeVisible={chrome.visible} poke={chrome.poke} />
      ) : (
        <ScrollView story={story} pages={mode === "page" ? pages : null} />
      )}

      <div
        className={cx(
          "material absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line p-1 shadow-[var(--shadow-float)] transition-opacity duration-300",
          chrome.visible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {mode === "page" && (
          <Segmented
            size="sm"
            value={layout}
            onChange={setLayout}
            options={[
              { value: "paged", label: <><BookOpenText size={13} />Pages</> },
              { value: "scroll", label: <><Scroll size={13} />Scroll</> },
            ]}
          />
        )}
        {mode === "page" && layout === "paged" && (
          <IconButton label={spread ? "Single page" : "Two-page spread"} size="sm" active={spread} onClick={() => setSpread(!spread)}>
            {spread ? <Columns size={15} /> : <Square size={15} />}
          </IconButton>
        )}
        <span className="px-2 text-[12px] text-ink-2">{mode === "page" ? (dir === "rtl" ? "Right to left" : "Left to right") : "Webtoon"}</span>
      </div>
    </div>
  );
}

/** Chrome visibility: visible on pointer movement, fades after 2.2s of stillness. */
function useChrome() {
  const [visible, setVisible] = useState(true);
  const t = useRef<number | undefined>(undefined);
  const poke = useCallback(() => {
    setVisible(true);
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => setVisible(false), 2200);
  }, []);
  useEffect(() => {
    poke();
    return () => window.clearTimeout(t.current);
  }, [poke]);
  return { visible, poke };
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

// ---- paged ----------------------------------------------------------------------------------

function Paged({ story, pages, dir, spread, chromeVisible, poke }: { story: StoryDetail; pages: Page[]; dir: "rtl" | "ltr"; spread: boolean; chromeVisible: boolean; poke: () => void }) {
  const [stage, size] = useSize<HTMLDivElement>();
  const step = spread ? 2 : 1;
  const [idx, setIdx] = useState(0); // first page shown
  const [travel, setTravel] = useState(1); // +1 forward, -1 back (for the slide direction)
  const { page: pd } = pageDims(story.format);
  const aspect = pd.width / pd.height;

  useEffect(() => {
    if (spread) setIdx((i) => i - (i % 2));
  }, [spread]);

  const goTo = useCallback(
    (i: number) => {
      const max = Math.max(0, pages.length - 1);
      const n = Math.max(0, Math.min(max - (spread ? max % 2 : 0), i));
      setIdx((cur) => {
        setTravel(n >= cur ? 1 : -1);
        return n;
      });
    },
    [pages.length, spread],
  );
  const next = useCallback(() => goTo(idx + step), [goTo, idx, step]);
  const prev = useCallback(() => goTo(idx - step), [goTo, idx, step]);

  // Arrow keys follow the reading direction: in RTL the next page is to the left.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      const fwdKey = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
      const backKey = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
      if (e.key === fwdKey || e.key === "PageDown" || e.key === " ") (e.preventDefault(), next());
      else if (e.key === backKey || e.key === "PageUp") (e.preventDefault(), prev());
      else if (e.key === "Home") goTo(0);
      else if (e.key === "End") goTo(pages.length - 1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [dir, next, prev, goTo, pages.length]);

  const shown = spread ? [idx, idx + 1].filter((i) => i < pages.length) : [idx];
  // In RTL the earlier page of a spread sits on the right.
  const ordered = dir === "rtl" ? [...shown].reverse() : shown;
  const pad = 24;
  const k = shown.length;
  const ph = Math.max(0, Math.min(size.h - pad * 2 - 40, (size.w - pad * 2) / (k * aspect)));
  const pw = ph * aspect;
  // slide toward where the next page comes from: RTL forward = content moves right
  const dx = (dir === "rtl" ? 1 : -1) * travel * 28;

  return (
    <div className="absolute inset-0 flex flex-col">
      <div ref={stage} className="relative flex min-h-0 flex-1 items-center justify-center">
        <AnimatePresence initial={false} mode="popLayout" custom={dx}>
          <motion.div
            key={shown.join("-")}
            custom={dx}
            className="flex"
            variants={{
              enter: (d: number) => ({ opacity: 0, transform: `translateX(${-d}px)` }),
              center: { opacity: 1, transform: "translateX(0px)" },
              exit: (d: number) => ({ opacity: 0, transform: `translateX(${d}px)` }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          >
            {ordered.map((i) => (
              <ReaderPage key={i} story={story} page={pages[i]} width={pw} />
            ))}
          </motion.div>
        </AnimatePresence>

        {/* click halves: the left half goes forward in RTL */}
        <button aria-label={dir === "rtl" ? "Next page" : "Previous page"} className="absolute inset-y-0 left-0 w-1/2 cursor-w-resize" onClick={dir === "rtl" ? next : prev} />
        <button aria-label={dir === "rtl" ? "Previous page" : "Next page"} className="absolute inset-y-0 right-0 w-1/2 cursor-e-resize" onClick={dir === "rtl" ? prev : next} />

        <div className={cx("pointer-events-none absolute inset-x-4 top-1/2 flex -translate-y-1/2 justify-between transition-opacity duration-300", chromeVisible ? "opacity-100" : "opacity-0")}>
          <span className="material flex size-9 items-center justify-center rounded-full border border-line text-ink-2 shadow-[var(--shadow-float)]">
            <CaretLeft size={16} />
          </span>
          <span className="material flex size-9 items-center justify-center rounded-full border border-line text-ink-2 shadow-[var(--shadow-float)]">
            <CaretRight size={16} />
          </span>
        </div>
      </div>

      <ThumbStrip story={story} pages={pages} current={shown} dir={dir} onGo={goTo} chromeVisible={chromeVisible} poke={poke} />
    </div>
  );
}

function ReaderPage({ story, page, width }: { story: StoryDetail; page: Page; width: number }) {
  const { page: pd, live } = pageDims(story.format);
  const byId = new Map(story.panels.map((p) => [p.id, p]));
  return (
    <div className="relative overflow-hidden shadow-[var(--shadow-page)]" style={{ width, aspectRatio: `${pd.width} / ${pd.height}`, background: page.paper === "black" ? "#0c0c0e" : "#ffffff" }}>
      <PageBackground story={story} page={page} eager />
      <div className="absolute" style={{ left: `${(live.x / pd.width) * 100}%`, top: `${(live.y / pd.height) * 100}%`, width: `${(live.w / pd.width) * 100}%`, height: `${(live.h / pd.height) * 100}%` }}>
        {page.panels.map((s, i) => {
          const p = s.panel ? byId.get(s.panel) : undefined;
          const [x, y, w, h] = slotRect(s, story.format);
          const mode = s.subject && p?.subject ? s.subject : undefined;
          return (
            <div key={i} className="absolute" style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}>
              {p?.pick ? (
                <PanelView
                  slug={story.slug}
                  panel={p}
                  story={story}
                  slotAspect={(w * live.w) / (h * live.h)}
                  poly={s.poly}
                  borderPx={mode === "cutout" ? 0 : borderFrac(s.border) * width}
                  subjectMode={mode}
                  className="size-full"
                  eager
                />
              ) : (
                <div className="size-full bg-[#f3f3f1]" style={{ clipPath: polyClip(s.poly) }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ThumbStrip({ story, pages, current, dir, onGo, chromeVisible, poke }: { story: StoryDetail; pages: Page[]; current: number[]; dir: "rtl" | "ltr"; onGo: (i: number) => void; chromeVisible: boolean; poke: () => void }) {
  const [hover, setHover] = useState(false);
  const show = hover || chromeVisible;
  const list = pages.map((p, i) => ({ p, i }));
  if (dir === "rtl") list.reverse();
  return (
    <div className="relative h-10 shrink-0" onPointerEnter={() => (setHover(true), poke())} onPointerLeave={() => setHover(false)}>
      <div className={cx("absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 pb-3 transition-opacity duration-200", show ? "opacity-100" : "pointer-events-none opacity-0")}>
        <AnimatePresence>
          {hover && (
            <motion.div
              className="material flex max-w-[90%] gap-2 overflow-x-auto rounded-[var(--radius-surface)] border border-line p-2 shadow-[var(--shadow-float)]"
              initial={{ opacity: 0, transform: "translateY(8px)" }}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              exit={{ opacity: 0, transform: "translateY(8px)" }}
              transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            >
              {list.map(({ p, i }) => (
                <button key={i} onClick={() => onGo(i)} className={cx("pressable shrink-0 rounded-[3px]", current.includes(i) ? "ring-2 ring-accent" : "opacity-80 hover:opacity-100")}>
                  <ReaderPage story={story} page={p} width={54} />
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <span className="num rounded-full bg-paper/80 px-2.5 py-0.5 text-[12px] text-ink-2">
          {current.map((i) => i + 1).join("-")} / {pages.length}
        </span>
      </div>
    </div>
  );
}

// ---- scroll ---------------------------------------------------------------------------------

function ScrollView({ story, pages }: { story: StoryDetail; pages: Page[] | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ i: 1, n: 1 });
  const panels = stripPanels(story);
  const n = pages ? pages.length : panels.length;

  // page indicator from what's in view (IntersectionObserver, not a scroll listener)
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setPos({ i: Number((e.target as HTMLElement).dataset.i) + 1, n });
      },
      { root, rootMargin: "-45% 0px -45% 0px" },
    );
    root.querySelectorAll("[data-i]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [n, story.slug]);

  return (
    <div ref={scroller} className="absolute inset-0 overflow-y-auto" tabIndex={0}>
      <div className="mx-auto flex flex-col items-center gap-6 px-6 py-16" style={{ maxWidth: pages ? 760 : 680 }}>
        {pages
          ? pages.map((pg, i) => (
              <div key={pg.id + i} data-i={i} className="w-full">
                <ReaderPage story={story} page={pg} width={Math.min(720, (scroller.current?.clientWidth ?? 760) - 48)} />
              </div>
            ))
          : (
            <div className="flex w-full flex-col gap-4 bg-white py-4 shadow-[var(--shadow-page)]">
              {panels.map((p, i) => (
                <div key={p.id} data-i={i}>
                  {p.pick ? <PanelView slug={story.slug} panel={p} story={story} className="w-full" /> : <div className="flex aspect-[3/4] items-center justify-center bg-[#f3f3f1] text-[12px] text-ink-3">Not drawn yet</div>}
                </div>
              ))}
            </div>
          )}
      </div>
      <span className="num pointer-events-none fixed right-5 bottom-5 rounded-full bg-paper/85 px-2.5 py-0.5 text-[12px] text-ink-2 shadow-[var(--shadow-float)]">
        {pos.i} / {n}
      </span>
    </div>
  );
}

function ReaderSkeleton() {
  return (
    <div className="flex h-full items-center justify-center bg-[#ececea]">
      <div className="skeleton h-[80%]" style={{ aspectRatio: "1654 / 2339" }} />
    </div>
  );
}
