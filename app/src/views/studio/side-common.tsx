// Small building blocks shared by the Inspector, Copilot, Versions and Cast Studio.

import { AnimatePresence, motion } from "motion/react";
import { CaretRight } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fileUrl, versionUrl, type Panel, type StoryDetail } from "../../lib/api";
import { useDebounced } from "../../lib/live";
import { cx, spring } from "../../ui/kit";

export const refName = (r: string | { ref: string; label?: string }) => (typeof r === "string" ? r : r.ref);

/** Thumbnail URL for a ref: a panel id uses its picked version, anything else is a file in refs/. */
export function refThumb(story: StoryDetail, name: string): string | null {
  const p = story.panels.find((x) => x.id === name);
  if (p) return p.pick ? versionUrl(story.slug, p.id, p.pick) : null;
  return fileUrl(story.slug, `refs/${name}`);
}

export function pickedUrl(story: StoryDetail, panel: Panel): string | null {
  return panel.pick ? versionUrl(story.slug, panel.id, panel.pick) : null;
}

/**
 * Text that saves as you type. Local state wins while the field is being edited; server
 * updates (an agent editing story.yaml) flow in when the field isn't dirty.
 */
export function useSyncedText(server: string, save: (v: string) => void, key: string, ms = 500) {
  const [value, setValue] = useState(server);
  const dirty = useRef(false);
  const saveD = useDebounced((v: string) => {
    save(v);
    dirty.current = false;
  }, ms);
  useEffect(() => {
    dirty.current = false;
    setValue(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (!dirty.current) setValue(server);
  }, [server]);
  return {
    value,
    onChange: (v: string) => {
      dirty.current = true;
      setValue(v);
      saveD(v);
    },
  };
}

export function Chip({ on, onClick, children, title }: { on: boolean; onClick?: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className={cx(
        "pressable inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium",
        on ? "border-ink bg-ink text-paper" : "border-line-2 bg-paper text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

export function Slider({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.05,
  onChange,
  format = (v) => v.toFixed(2),
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="flex items-center gap-3 text-[12.5px]">
      <span className="w-[68px] shrink-0 text-ink-2">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--color-ink)]"
      />
      <span className="num w-9 shrink-0 text-right text-ink-2">{format(value)}</span>
    </label>
  );
}

/** Collapsible section. Height animates (accordion is the sanctioned exception), content fades. */
export function Collapse({
  title,
  icon,
  defaultOpen = true,
  action,
  children,
}: {
  title: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-t border-line">
      <div className="flex items-center justify-between gap-2 px-4">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex h-10 min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={open}>
          <CaretRight size={11} weight="bold" className={cx("shrink-0 text-ink-3 transition-transform duration-200 ease-[var(--ease-out)]", open && "rotate-90")} />
          {icon && <span className="text-ink-2">{icon}</span>}
          <span className="text-[12.5px] font-semibold tracking-[-0.005em]">{title}</span>
        </button>
        {action}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-3 px-4 pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

export function Thumb({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={cx("overflow-hidden rounded-[6px] bg-wash", className)}>
      {src && !broken ? (
        <img src={src} alt={alt} loading="lazy" draggable={false} onError={() => setBroken(true)} className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center text-[10px] text-ink-3">none</div>
      )}
    </div>
  );
}

export function compileCast(c: { name?: string; role?: string; face?: string; hair?: string; outfit?: string; palette?: string }) {
  return `${c.name ?? ""}, ${c.role ?? ""}: ${c.face ?? ""}. Hair: ${c.hair ?? ""}. Outfit: ${c.outfit ?? ""}. Palette: ${c.palette ?? ""}.`;
}
