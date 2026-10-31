// Floating canvas toolbars. Tool switches and zoom steps are instant (used constantly, often from the
// keyboard); only the layers popover animates, scaling from its trigger.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ChatCircle,
  ChatText,
  CursorClick,
  Export,
  Hand,
  Layout,
  MagicWand,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  SidebarSimple,
  Stack,
  TextT,
  UsersThree,
} from "@phosphor-icons/react";
import { Button, IconButton, Kbd, Segmented, cx, spring } from "../../ui/kit";
import { useApp } from "../../lib/store";
import type { LayerToggles } from "../../ui/PanelView";
import { TEMPLATES, type TemplateId } from "../../lib/layout";
import { useStudio, type Tool } from "./studioState";

// zoom level as an external store so the label re-renders without re-rendering the Studio
let zoom = 1;
const zl = new Set<() => void>();
export const setZoomLabel = (z: number) => {
  zoom = z;
  zl.forEach((l) => l());
};
const useZoom = () =>
  useSyncExternalStore(
    (l) => {
      zl.add(l);
      return () => zl.delete(l);
    },
    () => zoom,
  );

const TOOLS: { id: Tool; label: string; key: string; icon: React.ReactNode }[] = [
  { id: "select", label: "Select", key: "V", icon: <CursorClick size={16} /> },
  { id: "bubble", label: "Speech bubble", key: "B", icon: <ChatCircle size={16} /> },
  { id: "sfx", label: "Sound effect", key: "S", icon: <TextT size={16} /> },
  { id: "pan", label: "Pan", key: "H", icon: <Hand size={16} /> },
];

const LAYERS: { k: keyof LayerToggles; label: string }[] = [
  { k: "background", label: "Background" },
  { k: "art", label: "Art" },
  { k: "fx", label: "Tone and FX" },
  { k: "lettering", label: "Lettering" },
];

type StudioMode = "letter" | "layout" | "edit";

/** One obvious switch for what the canvas is doing: lettering, page layout, or editing the picture itself. */
export function ModeSwitch({ pageMode, canEdit }: { pageMode: boolean; canEdit: boolean }) {
  const { layoutMode, editImage, setLayoutMode, setEditImage } = useStudio();
  const mode: StudioMode = editImage ? "edit" : layoutMode ? "layout" : "letter";
  const set = (m: StudioMode) => {
    if (m === "edit" && !canEdit) {
      useApp.getState().toast("Select a panel that has a picture to edit it", "info");
      return;
    }
    if (m === "edit") setEditImage(true);
    else if (m === "layout") setLayoutMode(true);
    else {
      setEditImage(false);
      setLayoutMode(false);
    }
  };
  const opts: { value: StudioMode; label: React.ReactNode; title: string }[] = [
    { value: "letter", label: <><ChatCircle size={14} />Letter</>, title: "Bubbles and sound effects" },
    ...(pageMode ? [{ value: "layout" as const, label: <><Layout size={14} />Layout</>, title: "Page slots, gutters and framing" }] : []),
    { value: "edit", label: <><MagicWand size={14} />Edit image</>, title: "Select, move, erase and fix the picture" },
  ];
  return <Segmented<StudioMode> value={mode} onChange={set} options={opts} />;
}

export function CanvasToolbar({
  pageMode,
  canEdit,
  onFit,
  onZoomBy,
  onZoomTo,
}: {
  pageMode: boolean;
  canEdit: boolean;
  onFit: () => void;
  onZoomBy: (f: number) => void;
  onZoomTo: (z: number) => void;
}) {
  const { tool, setTool, layers, toggleLayer, layoutMode } = useStudio();
  const z = useZoom();
  const [layersOpen, setLayersOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const hidden = LAYERS.filter((l) => !layers[l.k]).length;

  return (
    <div className="material pointer-events-auto flex items-center gap-0.5 rounded-[var(--radius-surface)] border border-line p-1 shadow-[var(--shadow-float)]">
      <ModeSwitch pageMode={pageMode} canEdit={canEdit} />
      <Divider />
      {TOOLS.map((t) => (
        <IconButton key={t.id} label={`${t.label} (${t.key})`} active={tool === t.id} disabled={layoutMode && t.id !== "pan" && t.id !== "select"} onClick={() => setTool(t.id)}>
          {t.icon}
        </IconButton>
      ))}
      <Divider />
      <IconButton label="Zoom out" onClick={() => onZoomBy(1 / 1.25)}>
        <MagnifyingGlassMinus size={16} />
      </IconButton>
      <div className="relative">
        <button className="pressable num h-8 w-14 rounded-[var(--radius-control)] text-[12.5px] text-ink-2 hover:bg-wash hover:text-ink" onClick={() => setZoomOpen((o) => !o)} aria-label="Zoom level">
          {Math.round(z * 100)}%
        </button>
        <Popover open={zoomOpen} onClose={() => setZoomOpen(false)} origin="top center" className="left-1/2 w-36 -translate-x-1/2">
          <MenuItem onClick={() => (onFit(), setZoomOpen(false))} hint={<Kbd>⌘0</Kbd>}>
            Fit
          </MenuItem>
          {[0.5, 1, 1.5, 2].map((v) => (
            <MenuItem key={v} onClick={() => (onZoomTo(v), setZoomOpen(false))}>
              {v * 100}%
            </MenuItem>
          ))}
        </Popover>
      </div>
      <IconButton label="Zoom in" onClick={() => onZoomBy(1.25)}>
        <MagnifyingGlassPlus size={16} />
      </IconButton>
      <Divider />
      <div className="relative">
        <IconButton label="Layers" active={layersOpen} onClick={() => setLayersOpen((o) => !o)}>
          <Stack size={16} />
        </IconButton>
        {hidden > 0 && <span className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-accent" aria-label={`${hidden} layers hidden`} />}
        <Popover open={layersOpen} onClose={() => setLayersOpen(false)} origin="top center" className="left-1/2 w-48 -translate-x-1/2">
          {LAYERS.map((l) => (
            <label key={l.k} className="flex h-8 cursor-default items-center justify-between rounded-[var(--radius-control)] px-2 text-[13px] hover:bg-wash">
              {l.label}
              <Switch on={layers[l.k]} onChange={() => toggleLayer(l.k)} />
            </label>
          ))}
        </Popover>
      </div>
    </div>
  );
}

export function TemplateBar({ onApply }: { onApply: (t: TemplateId) => void }) {
  const setLayoutMode = useStudio((s) => s.setLayoutMode);
  return (
    <motion.div
      className="material pointer-events-auto flex items-center gap-1 rounded-[var(--radius-surface)] border border-line p-1 shadow-[var(--shadow-float)]"
      initial={{ opacity: 0, transform: "translateY(-6px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0, transform: "translateY(-6px)" }}
      transition={spring}
    >
      <span className="px-2 text-[12px] whitespace-nowrap text-ink-2">Template</span>
      {TEMPLATES.map((t) => (
        <button key={t.id} className="pressable flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-[12.5px] whitespace-nowrap text-ink-2 hover:bg-wash hover:text-ink" onClick={() => onApply(t.id)}>
          <TemplateIcon id={t.id} />
          {t.label}
        </button>
      ))}
      <Divider />
      <span className="px-1 text-[12px] whitespace-nowrap text-ink-2">Drag gutters or art</span>
      <Button size="sm" variant="primary" onClick={() => setLayoutMode(false)}>
        Done
      </Button>
    </motion.div>
  );
}

export function ActionBar({ onLetter, letterBusy, onCast, onExport, castCount }: { onLetter: () => void; letterBusy: boolean; onCast: () => void; onExport: () => void; castCount: number }) {
  const { inspector, setInspector } = useStudio();
  return (
    <div className="material pointer-events-auto flex items-center gap-0.5 rounded-[var(--radius-surface)] border border-line p-1 shadow-[var(--shadow-float)]">
      <Button size="sm" variant="ghost" icon={<ChatText size={15} />} loading={letterBusy} onClick={onLetter} title="Place speech bubbles away from faces">
        Auto-letter
      </Button>
      <Button size="sm" variant="ghost" icon={<UsersThree size={15} />} onClick={onCast}>
        Cast{castCount ? <span className="num text-ink-3">{castCount}</span> : null}
      </Button>
      <Button size="sm" variant="ghost" icon={<Export size={15} />} onClick={onExport}>
        Export
      </Button>
      <Divider />
      <IconButton label={inspector ? "Hide inspector" : "Show inspector"} active={inspector} onClick={() => setInspector(!inspector)}>
        <SidebarSimple size={16} mirrored />
      </IconButton>
    </div>
  );
}

export function Divider() {
  return <span className="mx-1 h-5 w-px bg-line" />;
}

export function Switch({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onChange}
      className={cx("relative h-[18px] w-[30px] rounded-full transition-colors duration-150", on ? "bg-ink" : "bg-line-2")}
    >
      <span
        className="absolute top-[2px] left-[2px] size-[14px] rounded-full bg-paper shadow-[0_1px_2px_rgb(23_23_26/0.2)] transition-transform duration-200 ease-[var(--ease-out)]"
        style={{ transform: on ? "translateX(12px)" : "translateX(0px)" }}
      />
    </button>
  );
}

export function Popover({ open, onClose, children, className, origin }: { open: boolean; onClose: () => void; children: React.ReactNode; className?: string; origin: string }) {
  // Escape closes it (the click-catcher below would otherwise swallow the next click on the canvas).
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onPointerDown={onClose} />
          <motion.div
            className={cx("absolute top-10 z-40 flex flex-col rounded-[var(--radius-surface)] border border-line bg-paper p-1 shadow-[var(--shadow-float)]", className)}
            style={{ transformOrigin: origin }}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function MenuItem({ children, onClick, hint }: { children: React.ReactNode; onClick: () => void; hint?: React.ReactNode }) {
  return (
    <button className="flex h-8 items-center justify-between rounded-[var(--radius-control)] px-2 text-left text-[13px] hover:bg-wash" onClick={onClick}>
      {children}
      {hint}
    </button>
  );
}

/** Tiny schematic of a template (not decorative: it's the option's preview). */
function TemplateIcon({ id }: { id: TemplateId }) {
  const rects: Record<TemplateId, string[]> = {
    one: ["M1 1h12v16H1z"],
    rows2: ["M1 1h12v7.5H1z", "M1 9.5h12v7.5H1z"],
    rows3: ["M1 1h12v4.7H1z", "M1 6.7h12v4.6H1z", "M1 12.3h12v4.7H1z"],
    grid4: ["M1 1h5.5v7.5H1z", "M7.5 1H13v7.5H7.5z", "M1 9.5h5.5V17H1z", "M7.5 9.5H13V17H7.5z"],
    big2: ["M1 1h12v9H1z", "M1 11h5.5v6H1z", "M7.5 11H13v6H7.5z"],
    tier3: ["M1 1h12v4.7H1z", "M1 6.7h7.5L7 11.3H1z", "M9.5 6.7H13v4.6H8z", "M1 12.3h12v4.7H1z"],
  };
  return (
    <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden className="shrink-0">
      {rects[id].map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="1.1" />
      ))}
    </svg>
  );
}
