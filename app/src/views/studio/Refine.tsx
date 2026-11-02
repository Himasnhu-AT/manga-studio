// Refine sketch: the artist's drawing on the left, the refined result on the right. Pick how far to take it
// (clean lines, inks, inks + tone, color) and how closely to follow the lines; results are new versions,
// the drawing never changes. "Show my drawing on top" overlays the sketch to check that poses held.

import { AnimatePresence, motion } from "motion/react";
import { Check, Sparkle, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Api, versionUrl, type Panel, type StoryDetail, type Version } from "../../lib/api";
import { useLive } from "../../lib/live";
import { attempt } from "../../lib/store";
import { Button, IconButton, Progress, Segmented, cx } from "../../ui/kit";
import { useStudio } from "./studioState";
import { REFINE_STAGE, STAGES } from "../../lib/stages";

type Preset = "clean" | "inks" | "tone" | "color";
const PRESETS: { value: Preset; label: string; title: string; strength: number }[] = [
  { value: "clean", label: "Clean lines", title: "Tidy pencil lines, no shading", strength: 0.45 },
  { value: "inks", label: "Inks", title: "Inked line art with solid blacks", strength: 0.55 },
  { value: "tone", label: "Inks + tone", title: "Inks, blacks and screentone", strength: 0.6 },
  { value: "color", label: "Full color", title: "Colored, in the story's style", strength: 0.7 },
];
const MIN = 0.25;
const MAX = 0.95;

export function Refine({ story, panel }: { story: StoryDetail; panel: Panel }) {
  const close = () => useStudio.getState().setRefine(false);
  // the drawing being refined stays fixed while results come in (they become versions too)
  const [source] = useState(() => {
    const p = panel.versions.find((v) => v.file === panel.pick);
    return typeof p?.source === "string" && p.refine ? p.source : panel.pick;
  });
  const [preset, setPreset] = useState<Preset>("inks");
  const [strength, setStrength] = useState(0.55);
  const [count, setCount] = useState(3);
  const [prompt, setPrompt] = useState("");
  const [overlay, setOverlay] = useState(false);
  const [jobIds, setJobIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const jobs = useLive(jobIds.length ? () => Api.jobs(story.slug) : null, [story.slug, jobIds.join(",")]);

  // every refinement of this drawing, newest first (earlier sessions too)
  const results: Version[] = useMemo(() => panel.versions.filter((v) => v.source === source && v.refine).reverse(), [panel.versions, source]);
  const [shown, setShown] = useState<string | null>(null);
  const current = results.find((r) => r.file === shown) ?? results[0];
  useEffect(() => {
    if (results[0] && !shown) setShown(results[0].file);
  }, [results, shown]);

  const mine = (jobs.data ?? []).filter((j) => jobIds.includes(j.id));
  const pending = mine.filter((j) => j.status === "queued" || j.status === "running");
  const running = pending.find((j) => j.status === "running");
  const failed = mine.find((j) => j.status === "error");

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);

  if (!source) return null;

  const run = async () => {
    setBusy(true);
    const r = await attempt(() => Api.refine(story.slug, panel.id, { preset, strength, count, source, prompt: prompt.trim() || undefined }), `Refining ${panel.id}: ${count} result${count > 1 ? "s" : ""}`);
    if (r) {
      setJobIds((ids) => [...ids, ...r.jobs]);
      setShown(null);
    }
    setBusy(false);
  };

  const hint = strength <= 0.45 ? "Pose and layout locked" : strength <= 0.7 ? "Small shifts possible" : "May redraw the pose";
  const hintTone = strength <= 0.45 ? "text-ok" : strength <= 0.7 ? "text-warn" : "text-err";

  return (
    <div className="absolute inset-0 flex flex-col bg-canvas">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-paper px-4">
        <Sparkle size={15} weight="fill" className="text-accent" />
        <span className="text-[13.5px] font-semibold">Refine sketch</span>
        <span className="num text-[12px] text-ink-2">
          {panel.id}
          {panel.title ? ` · ${panel.title}` : ""}
        </span>
        <span className="ml-auto text-[12px] text-ink-2">Your drawing is never changed. Each result is a new version.</span>
        <IconButton label="Close (Esc)" size="sm" onClick={close}>
          <X size={15} />
        </IconButton>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-8 px-10 py-6">
        <Frame title="Your drawing" sub={source}>
          <img src={versionUrl(story.slug, panel.id, source)} alt="Your drawing" className="max-h-full max-w-full object-contain" draggable={false} />
        </Frame>
        <Frame title={current ? `Refined · ${PRESETS.find((p) => p.value === current.refine)?.label ?? current.refine}` : "Refined"} sub={current?.file} accent={!!current}>
          {current ? (
            <div className="relative max-h-full">
              <img src={versionUrl(story.slug, panel.id, current.file)} alt="Refined result" className="max-h-full max-w-full object-contain" draggable={false} />
              {overlay && <img src={versionUrl(story.slug, panel.id, source)} alt="" className="pointer-events-none absolute inset-0 size-full object-fill opacity-40 mix-blend-multiply" draggable={false} />}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-center text-[13px] text-ink-2">
              {pending.length ? "Working on it…" : "Choose how far to take it below, then Refine."}
            </div>
          )}
          <AnimatePresence>
            {pending.length > 0 && (
              <motion.div className="absolute inset-x-6 bottom-4 flex flex-col gap-1.5 rounded-[var(--radius-control)] bg-paper/95 p-3 shadow-[var(--shadow-float)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="flex justify-between text-[12px] text-ink-2">
                  <span>{running ? (running.steps ? "Drawing" : "Loading the model (first run takes a minute or two)") : "Queued"}</span>
                  <span className="num">{pending.length} to go</span>
                </div>
                <Progress value={running?.steps ? (running.step ?? 0) / running.steps : 0} />
              </motion.div>
            )}
          </AnimatePresence>
          {failed && !pending.length && <p className="absolute inset-x-6 bottom-4 rounded-[var(--radius-control)] bg-[#fdeeee] p-2 text-[12px] text-err">{failed.error}</p>}
        </Frame>
      </div>

      <div className="flex shrink-0 flex-wrap items-end gap-6 border-t border-line bg-paper px-6 py-4">
        <div className="flex flex-col gap-1.5">
          <span className="type-label">Finish as</span>
          <Segmented<Preset>
            value={preset}
            onChange={(v) => {
              setPreset(v);
              setStrength(PRESETS.find((p) => p.value === v)!.strength);
            }}
            options={PRESETS.map((p) => ({ value: p.value, label: p.label, title: p.title }))}
          />
        </div>
        <div className="flex w-80 flex-col gap-1.5">
          <label htmlFor="refine-prompt" className="type-label">
            Describe it
          </label>
          <input
            id="refine-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void run()}
            placeholder="Who is in it, what they do. Optional."
            className="h-9 rounded-[var(--radius-control)] border border-line-2 bg-paper px-2.5 text-[13px]"
          />
        </div>
        <div className="flex w-72 flex-col gap-1.5">
          <label htmlFor="refine-strength" className="type-label">
            Follow my lines
          </label>
          <input id="refine-strength" type="range" min={MIN} max={MAX} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} className="accent-[var(--color-accent)]" />
          <div className="flex justify-between text-[11.5px] text-ink-2">
            <span>Keep my drawing</span>
            <span className={cx("font-medium", hintTone)}>{hint}</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="type-label">Results</span>
          <Segmented size="sm" value={String(count)} onChange={(v) => setCount(Number(v))} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: <span className="num">{n}</span> }))} />
        </div>
        <Button variant="primary" icon={<Sparkle size={14} />} loading={busy} onClick={() => void run()}>
          Refine
        </Button>

        {results.length > 0 && (
          <div className="flex items-end gap-2">
            {results.slice(0, 8).map((r) => (
              <button
                key={r.file}
                type="button"
                aria-label={`Show ${r.file}`}
                onClick={() => setShown(r.file)}
                className={cx("h-14 w-11 overflow-hidden rounded-[6px] bg-wash", r.file === current?.file ? "ring-2 ring-accent ring-offset-1" : "ring-1 ring-line hover:ring-line-2")}
              >
                <img src={versionUrl(story.slug, panel.id, r.file)} alt="" className="size-full object-cover" draggable={false} />
              </button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} className="size-4 accent-[var(--color-ink)]" />
            Show my drawing on top
          </label>
          <Button
            variant="primary"
            icon={<Check size={14} />}
            disabled={!current}
            onClick={async () => {
              if (!current) return;
              const ok = await attempt(() => Api.pick(story.slug, panel.id, current.file), "Using the refined version");
              if (ok === undefined) return;
              // the panel moves on to the stage the refinement reached (never backwards)
              const next = REFINE_STAGE[String(current.refine)];
              if (next && STAGES.indexOf(next) > STAGES.indexOf(panel.stage ?? "name")) await attempt(() => Api.patchPanel(story.slug, panel.id, { stage: next }));
              close();
            }}
          >
            Use this one
          </Button>
        </div>
      </div>
    </div>
  );
}

function Frame({ title, sub, accent, children }: { title: string; sub?: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        {sub && <span className="num text-[11.5px] text-ink-2">{sub}</span>}
      </div>
      <div className={cx("relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[var(--radius-control)] bg-paper p-3 shadow-[var(--shadow-page)]", accent && "ring-2 ring-accent")}>{children}</div>
    </section>
  );
}
