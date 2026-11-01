// Layout mode bars, under the canvas toolbar: page templates, then page devices (free panels, a
// full-bleed background, black paper), then the selected slot (shape, border, bleed, cut-out character,
// split, stacking). Everything edits `pages` through the Studio's debounced save.

import { AnimatePresence, motion } from "motion/react";
import { ArrowsInLineHorizontal, ArrowsInLineVertical, Crosshair, Plus, StackMinus, StackPlus, Trash } from "@phosphor-icons/react";
import { Api, ApiError, type Page, type PageSlot, type SlotBorder, type SlotSubject, type StoryDetail } from "../../lib/api";
import { insetSlot, SLANT_POLY, splitSlot, type TemplateId } from "../../lib/layout";
import { useApp } from "../../lib/store";
import { IconButton, Segmented, cx, spring } from "../../ui/kit";
import { useStudio } from "./studioState";
import { Divider, TemplateBar } from "./Toolbar";

const bar = "material pointer-events-auto flex flex-wrap items-center gap-1 rounded-[var(--radius-surface)] border border-line p-1 shadow-[var(--shadow-float)]";
const label = "px-1.5 text-[12px] whitespace-nowrap text-ink-2";
const enter = { initial: { opacity: 0, transform: "translateY(-6px)" }, animate: { opacity: 1, transform: "translateY(0px)" }, exit: { opacity: 0, transform: "translateY(-6px)" }, transition: spring };

export function LayoutBars({ story, page, onPage, onApply }: { story: StoryDetail; page: Page; onPage: (p: Page) => void; onApply: (t: TemplateId) => void }) {
  const slotSel = useStudio((s) => s.slotSel);
  const slot = slotSel !== null ? page.panels[slotSel] : undefined;
  return (
    <div className="flex flex-col items-start gap-2">
      <TemplateBar onApply={onApply} />
      <PageBar story={story} page={page} onPage={onPage} />
      <AnimatePresence>{slot && slotSel !== null && <SlotBar key="slot" story={story} page={page} i={slotSel} slot={slot} onPage={onPage} />}</AnimatePresence>
    </div>
  );
}

function PageBar({ story, page, onPage }: { story: StoryDetail; page: Page; onPage: (p: Page) => void }) {
  const setSlotSel = useStudio((s) => s.setSlotSel);
  const drawn = story.panels.filter((p) => p.pick);
  const bg = page.background;
  return (
    <motion.div className={bar} {...enter}>
      <button
        className="pressable flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-[12.5px] font-medium whitespace-nowrap text-ink hover:bg-wash"
        title="A free panel on top of the page. Drag it, resize it, overlap others."
        onClick={() => {
          onPage({ ...page, panels: [...page.panels, insetSlot()] });
          setSlotSel(page.panels.length);
        }}
      >
        <Plus size={14} /> Add panel
      </button>
      <Divider />
      <label className={label} htmlFor="page-bg">
        Background
      </label>
      <select
        id="page-bg"
        className="h-8 max-w-44 rounded-[var(--radius-control)] border border-line-2 bg-paper px-1.5 text-[12.5px]"
        value={bg?.panel ?? ""}
        title="Art behind every panel on this page: a giant face, a mood, a place"
        onChange={(e) => {
          const { background: _b, ...rest } = page;
          onPage(e.target.value ? { ...page, background: { panel: e.target.value, opacity: bg?.opacity ?? 0.35 } } : rest);
        }}
      >
        <option value="">None</option>
        {drawn.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id}
            {p.title ? ` · ${p.title}` : ""}
          </option>
        ))}
      </select>
      {bg && (
        <input
          type="range"
          aria-label="Background strength"
          title="Background strength"
          min={0.1}
          max={1}
          step={0.05}
          value={bg.opacity ?? 0.35}
          onChange={(e) => onPage({ ...page, background: { ...bg, opacity: Number(e.target.value) } })}
          className="w-24 accent-[var(--color-accent)]"
        />
      )}
      <Divider />
      <span className={label}>Paper</span>
      <Segmented
        size="sm"
        value={page.paper ?? "white"}
        onChange={(v) => onPage({ ...page, paper: v })}
        options={[
          { value: "white", label: "White" },
          { value: "black", label: "Black", title: "Black page and gutters: flashbacks, dread" },
        ]}
      />
    </motion.div>
  );
}

type Shape = "rect" | "slant" | "custom";
const RECT_POLY: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

function SlotBar({ story, page, i, slot, onPage }: { story: StoryDetail; page: Page; i: number; slot: PageSlot; onPage: (p: Page) => void }) {
  const { setSlotSel, setPickSubject, pickSubject } = useStudio();
  const panel = slot.panel ? story.panels.find((p) => p.id === slot.panel) : undefined;
  const set = (s: PageSlot) => onPage({ ...page, panels: page.panels.map((x, j) => (j === i ? s : x)) });
  const shape: Shape = !slot.poly ? "rect" : JSON.stringify(slot.poly) === JSON.stringify(SLANT_POLY) ? "slant" : "custom";

  const setShape = (v: Shape) => {
    const { poly: _p, ...rest } = slot;
    set(v === "rect" ? rest : { ...slot, poly: v === "slant" ? SLANT_POLY : RECT_POLY.map(([x, y]) => [x, y] as [number, number]) });
  };

  const setSubject = async (v: SlotSubject | "off") => {
    const { subject: _s, ...rest } = slot;
    if (v === "off") return set(rest);
    if (!panel?.pick) return;
    if (!panel.subject) {
      try {
        await Api.subject(story.slug, panel.id, {});
      } catch (e) {
        // no Apple Vision, or it found nobody: let the user click the character
        set({ ...slot, subject: v });
        setPickSubject(i);
        useApp.getState().toast(e instanceof ApiError && e.status === 400 ? "Click the character in the panel" : "Couldn't cut out the character", "info");
        return;
      }
    }
    set({ ...slot, subject: v });
  };

  const split = (axis: "x" | "y") => {
    const [a, b] = splitSlot(slot, axis, story.format);
    onPage({ ...page, panels: [...page.panels.slice(0, i), a, b, ...page.panels.slice(i + 1)] });
  };
  const restack = (to: "front" | "back") => {
    const rest = page.panels.filter((_, j) => j !== i);
    onPage({ ...page, panels: to === "front" ? [...rest, slot] : [slot, ...rest] });
    setSlotSel(to === "front" ? rest.length : 0);
  };

  return (
    <motion.div className={bar} {...enter}>
      <span className={cx(label, "font-medium text-ink")}>{panel ? `${panel.id}${panel.title ? ` · ${panel.title}` : ""}` : "Empty slot"}</span>
      <Divider />
      <Segmented<Shape>
        size="sm"
        value={shape}
        onChange={setShape}
        options={[
          { value: "rect", label: "Rect" },
          { value: "slant", label: "Slant" },
          { value: "custom", label: "Custom", title: "Drag the round corners to any shape" },
        ]}
      />
      <Segmented<SlotBorder>
        size="sm"
        value={slot.border ?? "normal"}
        onChange={(v) => {
          const { border: _b, ...rest } = slot;
          set(v === "normal" ? rest : { ...slot, border: v });
        }}
        options={[
          { value: "normal", label: "Line" },
          { value: "bold", label: "Bold" },
          { value: "thin", label: "Thin" },
          { value: "none", label: "No border", title: "Borderless: the art sits on the page" },
        ]}
      />
      <button
        aria-pressed={!!slot.bleed}
        title="Run the edges that touch the margin off the page"
        className={cx("pressable h-7 rounded-[var(--radius-control)] px-2 text-[12px] font-medium", slot.bleed ? "bg-ink text-paper" : "text-ink-2 hover:bg-wash hover:text-ink")}
        onClick={() => {
          const { bleed: _b, ...rest } = slot;
          set(slot.bleed ? rest : { ...slot, bleed: true });
        }}
      >
        Bleed
      </button>
      <Divider />
      <span className={label}>Character</span>
      <Segmented<SlotSubject | "off">
        size="sm"
        value={slot.subject ?? "off"}
        onChange={(v) => void setSubject(v)}
        options={[
          { value: "off", label: "In frame" },
          { value: "pop", label: "Pop out", title: "The character breaks out over the border" },
          { value: "cutout", label: "Cutout", title: "No frame: only the character, floating on the page" },
        ]}
      />
      <IconButton label="Pick the character again (click it in the panel)" size="sm" active={pickSubject === i} disabled={!panel?.pick} onClick={() => setPickSubject(pickSubject === i ? null : i)}>
        <Crosshair size={15} />
      </IconButton>
      <Divider />
      <IconButton label="Split side by side" size="sm" disabled={!!slot.poly} onClick={() => split("x")}>
        <ArrowsInLineHorizontal size={15} />
      </IconButton>
      <IconButton label="Split top and bottom" size="sm" disabled={!!slot.poly} onClick={() => split("y")}>
        <ArrowsInLineVertical size={15} />
      </IconButton>
      <IconButton label="Bring to front" size="sm" onClick={() => restack("front")}>
        <StackPlus size={15} />
      </IconButton>
      <IconButton label="Send to back" size="sm" onClick={() => restack("back")}>
        <StackMinus size={15} />
      </IconButton>
      <IconButton
        label="Delete slot (Delete)"
        size="sm"
        onClick={() => {
          onPage({ ...page, panels: page.panels.filter((_, j) => j !== i) });
          setSlotSel(null);
        }}
      >
        <Trash size={15} />
      </IconButton>
    </motion.div>
  );
}
