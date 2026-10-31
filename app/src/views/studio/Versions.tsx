import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Columns, MagicWand, Star, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Api, versionUrl, type Panel, type StoryDetail } from "../../lib/api";
import { attempt } from "../../lib/store";
import { Button, IconButton, Kbd, Portal, cx, spring } from "../../ui/kit";

/** Horizontal strip of a panel's versions. Click opens the lightbox. */
export function Versions({ story, panel, onUseSource }: { story: StoryDetail; panel: Panel; onUseSource: (file: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const vs = panel.versions;
  if (!vs.length) return <p className="text-[12.5px] text-ink-2">No versions yet. Generate to make the first one.</p>;
  return (
    <>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {vs.map((v, i) => {
          const picked = v.file === panel.pick;
          const starred = story.state.stars[`${panel.id}/${v.file}`];
          return (
            <button
              key={v.file}
              type="button"
              onClick={() => setOpen(i)}
              title={`${v.file}${v.seed != null ? ` · seed ${v.seed}` : ""}`}
              className={cx(
                "pressable relative h-[84px] w-[63px] shrink-0 overflow-hidden rounded-[6px] bg-wash",
                picked ? "ring-2 ring-accent ring-offset-2 ring-offset-paper" : "ring-1 ring-line hover:ring-line-2",
              )}
            >
              <img src={versionUrl(story.slug, panel.id, v.file)} alt={v.file} loading="lazy" draggable={false} className="size-full object-cover" />
              {starred && <Star size={12} weight="fill" className="absolute top-1 right-1 text-[#f5b301] drop-shadow" />}
              <span className="num absolute inset-x-0 bottom-0 bg-[rgb(23_23_26/0.55)] px-1 text-[10px] text-paper">{v.file.split("-")[0]}</span>
            </button>
          );
        })}
      </div>
      <Lightbox story={story} panel={panel} index={open} setIndex={setOpen} onUseSource={onUseSource} />
    </>
  );
}

function Lightbox({
  story,
  panel,
  index,
  setIndex,
  onUseSource,
}: {
  story: StoryDetail;
  panel: Panel;
  index: number | null;
  setIndex: (i: number | null) => void;
  onUseSource: (file: string) => void;
}) {
  const reduce = useReducedMotion();
  const [compare, setCompare] = useState(false);
  const vs = panel.versions;
  const v = index != null ? vs[Math.min(index, vs.length - 1)] : null;
  const starred = v ? !!story.state.stars[`${panel.id}/${v.file}`] : false;
  const isPicked = v?.file === panel.pick && !!panel.explicit_pick;

  const pick = () => v && !isPicked && attempt(() => Api.pick(story.slug, panel.id, v.file), `Using ${v.file} for ${panel.id}`);
  const star = () => v && attempt(() => Api.star(story.slug, panel.id, v.file, !starred));

  useEffect(() => {
    if (index == null) return;
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea")) return;
      if (e.key === "Escape") setIndex(null);
      else if (e.key === "ArrowRight") setIndex(Math.min(vs.length - 1, index + 1));
      else if (e.key === "ArrowLeft") setIndex(Math.max(0, index - 1));
      else if (e.key === "p") void pick();
      else if (e.key === "s") void star();
      else if (e.key === "c") setCompare((c) => !c);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const showCompare = compare && panel.pick && v && panel.pick !== v.file;

  return (
    <Portal>
      <AnimatePresence>
        {v && index != null && (
          <div className="fixed inset-0 z-40 flex flex-col">
            <motion.div
              className="absolute inset-0 bg-[rgb(244_244_242/0.92)] backdrop-blur-md"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setIndex(null)}
            />
            <motion.div
              className="relative flex min-h-0 flex-1 flex-col"
              initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "scale(0.98)" }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, transform: "scale(1)" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "scale(0.98)" }}
              transition={spring}
            >
              <div className="flex h-12 shrink-0 items-center gap-3 px-4">
                <span className="text-[13px] font-semibold">{panel.title || panel.id}</span>
                <span className="num text-[12px] text-ink-2">
                  {index + 1} / {vs.length}
                </span>
                <span className="num truncate text-[12px] text-ink-2">
                  {v.file}
                  {v.seed != null && ` · seed ${v.seed}`}
                  {v.seconds != null && ` · ${v.seconds}s`}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button size="sm" variant="ghost" icon={<Columns size={14} />} onClick={() => setCompare((c) => !c)} disabled={!panel.pick || panel.pick === v.file}>
                    Compare <Kbd>c</Kbd>
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Star size={14} weight={starred ? "fill" : "regular"} className={starred ? "text-[#f5b301]" : ""} />} onClick={() => void star()}>
                    {starred ? "Starred" : "Star"} <Kbd>s</Kbd>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<MagicWand size={14} />}
                    onClick={() => {
                      onUseSource(v.file);
                      setIndex(null);
                    }}
                  >
                    Use as source
                  </Button>
                  <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => void pick()} disabled={isPicked}>
                    {isPicked ? "In use" : "Use this"} <Kbd>p</Kbd>
                  </Button>
                  <IconButton label="Close" size="sm" onClick={() => setIndex(null)}>
                    <X size={15} />
                  </IconButton>
                </div>
              </div>
              <div className="relative flex min-h-0 flex-1 items-center justify-center gap-4 px-14 pb-6">
                <IconButton label="Previous" className="absolute left-3" disabled={index === 0} onClick={() => setIndex(index - 1)}>
                  <ArrowLeft size={16} />
                </IconButton>
                {showCompare && (
                  <figure className="flex h-full min-w-0 flex-1 flex-col items-center gap-2">
                    <img src={versionUrl(story.slug, panel.id, panel.pick!)} alt="in use" className="min-h-0 flex-1 rounded-[var(--radius-surface)] object-contain shadow-[var(--shadow-page)]" />
                    <figcaption className="num text-[12px] text-ink-2">{panel.pick} · in use</figcaption>
                  </figure>
                )}
                <figure className="flex h-full min-w-0 flex-1 flex-col items-center gap-2">
                  <img
                    key={v.file}
                    src={versionUrl(story.slug, panel.id, v.file)}
                    alt={v.file}
                    className={cx("min-h-0 flex-1 rounded-[var(--radius-surface)] object-contain shadow-[var(--shadow-page)]", v.file === panel.pick && "ring-2 ring-accent")}
                  />
                  {showCompare && <figcaption className="num text-[12px] text-ink-2">{v.file}</figcaption>}
                </figure>
                <IconButton label="Next" className="absolute right-3" disabled={index >= vs.length - 1} onClick={() => setIndex(index + 1)}>
                  <ArrowRight size={16} />
                </IconButton>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </Portal>
  );
}
