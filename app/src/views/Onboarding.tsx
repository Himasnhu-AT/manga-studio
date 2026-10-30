// First-run setup. Full-window overlay, one question per screen.
// Motion: steps slide in the direction of travel (Next: from the right, Back: from the left) on a
// critically damped spring; MotionConfig reducedMotion="user" turns that into a crossfade.

import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, CheckCircle, CloudArrowDown, Cpu, HardDrives, Memory, WarningCircle, FilmStrip } from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { Api, type ModelInfo, type Settings, type SystemInfo } from "../lib/api";
import { useLive } from "../lib/live";
import { attempt, useApp } from "../lib/store";
import { Badge, Button, Progress, cx, spring } from "../ui/kit";
import { AiConnect } from "./app-ai";
import { CheckRow, fmtBytes } from "./app-common";
import { NewProjectChoices, createFromDraft, draftError, emptyDraft, type ProjectDraft } from "./NewProject";

const STEPS = ["welcome", "mac", "model", "ai", "project"] as const;
type Step = (typeof STEPS)[number];

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  agent: "claude",
  llm: { provider: "agent", ollama_url: "http://127.0.0.1:11434", text_model: "qwen3:8b", vision_model: "qwen2.5vl:7b" },
  image: { model: "qwen-image-2.1-turbo", quantize: 4 },
};

export const mergeSettings = (s?: Partial<Settings>): Settings => ({
  ...DEFAULT_SETTINGS,
  ...s,
  llm: { ...DEFAULT_SETTINGS.llm, ...(s?.llm ?? {}) },
  image: { ...DEFAULT_SETTINGS.image, ...(s?.image ?? {}) },
});

/** Poll the models list every second while something is downloading. */
export function useModels() {
  const q = useLive(() => Api.models(), []);
  const downloading = q.data?.some((m) => m.downloading);
  const { reload } = q;
  useEffect(() => {
    if (!downloading) return;
    const t = window.setInterval(() => void reload(), 1000);
    return () => window.clearInterval(t);
  }, [downloading, reload]);
  return q;
}

const slide = {
  enter: (dir: number) => ({ opacity: 0, transform: `translateX(${dir * 28}px)` }),
  center: { opacity: 1, transform: "translateX(0px)" },
  exit: (dir: number) => ({ opacity: 0, transform: `translateX(${dir * -28}px)` }),
};

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const [dir, setDir] = useState(1);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState<ProjectDraft>(emptyDraft);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = useApp((s) => s.go);
  const step: Step = STEPS[i];

  useEffect(() => {
    Api.settings()
      .then((s) => setSettings(mergeSettings(s)))
      .catch(() => {});
  }, []);

  const move = (d: number) => {
    setErr(null);
    setDir(d);
    setI((n) => Math.max(0, Math.min(STEPS.length - 1, n + d)));
  };

  const next = async () => {
    if (busy) return;
    if (step === "ai") {
      // Save the choice now so a crash later doesn't lose it.
      await attempt(() => Api.putSettings({ agent: settings.agent, llm: settings.llm }));
    }
    if (step !== "project") return move(1);
    const e = draftError(draft);
    if (e) return setErr(e);
    setBusy(true);
    const r = await createFromDraft(draft);
    if (!r) return setBusy(false);
    await attempt(() => Api.putSettings({ ...settings, onboarded: true }));
    setBusy(false);
    go(r.view, r.slug);
    onDone();
  };

  const skipAll = async () => {
    await attempt(() => Api.putSettings({ ...settings, onboarded: true }));
    go("library");
    onDone();
  };

  // Enter advances (but not while typing in a multi-line field).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.metaKey) return;
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      e.preventDefault();
      void next();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  return (
    <motion.div
      className="fixed inset-0 z-40 flex flex-col bg-paper"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
    >
      <div data-tauri-drag-region className="flex h-12 shrink-0 items-center justify-between pr-4 pl-[84px]">
        <span className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em]" data-tauri-drag-region>
          <span className="inline-block size-3 rounded-[3px] bg-accent" aria-hidden />
          Manga Studio
        </span>
        <Button size="sm" variant="ghost" onClick={skipAll}>
          Skip setup
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col px-6 pt-10 pb-8">
          <div className="mb-10 flex gap-1.5" aria-label={`Setup progress ${i + 1} of ${STEPS.length}`}>
            {STEPS.map((s, n) => (
              <span key={s} className={cx("h-[3px] flex-1 rounded-full transition-colors duration-300", n <= i ? "bg-ink" : "bg-line-2")} />
            ))}
          </div>

          <div className="relative flex-1">
            <AnimatePresence mode="popLayout" custom={dir} initial={false}>
              <motion.div key={step} custom={dir} variants={slide} initial="enter" animate="center" exit="exit" transition={spring}>
                {step === "welcome" && <Welcome />}
                {step === "mac" && <ThisMac />}
                {step === "model" && <ModelStep settings={settings} />}
                {step === "ai" && (
                  <StepFrame title="Who writes the prompts?" body="Pick the AI that drives the studio. You can change this any time in Settings.">
                    <AiConnect settings={settings} onChange={setSettings} />
                  </StepFrame>
                )}
                {step === "project" && (
                  <StepFrame title="Your first project" body="Start from the sample, an empty project, or a story you already have.">
                    <NewProjectChoices draft={draft} onChange={(d) => { setDraft(d); setErr(null); }} />
                  </StepFrame>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="mt-10 flex items-center gap-2">
            {i > 0 && (
              <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => move(-1)}>
                Back
              </Button>
            )}
            {err && <p className="text-[12.5px] text-err">{err}</p>}
            <div className="ml-auto flex items-center gap-2">
              {step === "model" && (
                <Button variant="ghost" onClick={() => move(1)}>
                  Skip for now
                </Button>
              )}
              <Button variant="primary" size="lg" loading={busy} trailing={step !== "project" ? <ArrowRight size={14} /> : undefined} onClick={() => void next()}>
                {step === "welcome" ? "Get started" : step === "project" ? (draft.kind === "text" ? "Create and run" : "Open studio") : "Continue"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function StepFrame({ title, body, children }: { title: string; body?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="type-display">{title}</h1>
        {body && <p className="max-w-[52ch] text-[14px] leading-relaxed text-ink-2">{body}</p>}
      </div>
      {children}
    </div>
  );
}

function Welcome() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-[34px] leading-[1.08] font-semibold tracking-[-0.028em] text-balance">Draw your story as manga, on this Mac.</h1>
        <p className="max-w-[48ch] text-[15px] leading-relaxed text-ink-2">
          Write or paste a story, draw it locally with Qwen-Image, letter it and export. Nothing leaves this machine.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-line border-y border-line">
        {[
          ["Studio", "Pages, panels, layers and speech bubbles you can drag and edit."],
          ["Pipeline", "Turns a chapter into a script, a storyboard and finished panels."],
          ["Your AI", "Claude Code, Codex or Ollama works alongside you through MCP."],
        ].map(([t, b]) => (
          <li key={t} className="flex gap-4 py-3">
            <span className="w-20 shrink-0 text-[13.5px] font-semibold">{t}</span>
            <span className="text-[13.5px] text-ink-2">{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThisMac() {
  const sys = useLive<SystemInfo>(() => Api.system(), []);
  const s = sys.data;
  return (
    <StepFrame title="This Mac" body="Qwen-Image runs on Apple Silicon through MLX. Here is how this machine measures up.">
      {!s ? (
        sys.error ? (
          <p className="text-[13px] text-err">{sys.error.message}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3].map((n) => (
              <div key={n} className="skeleton h-11" />
            ))}
          </div>
        )
      ) : (
        <div className="flex flex-col divide-y divide-line border-y border-line">
          <CheckRow
            tone={s.apple_silicon ? "ok" : "err"}
            icon={<Cpu size={18} />}
            label={s.apple_silicon ? "Apple Silicon" : `${s.arch} processor`}
            detail={s.apple_silicon ? "MLX can use the GPU and unified memory." : "Image generation needs an M-series Mac. You can still use the mock engine."}
          />
          <CheckRow
            tone={s.ram_gb >= 24 ? "ok" : s.ram_gb >= 16 ? "warn" : "err"}
            icon={<Memory size={18} />}
            label={`${Math.round(s.ram_gb)} GB memory`}
            detail={s.ram_gb >= 32 ? "Room for Turbo at 6 or 8-bit." : s.ram_gb >= 24 ? "24 GB runs Turbo at 4-bit." : "Below 24 GB, use 4-bit and smaller panels (768 x 1024)."}
          />
          <CheckRow
            tone={s.disk_free_gb >= 40 ? "ok" : "warn"}
            icon={<HardDrives size={18} />}
            label={`${Math.round(s.disk_free_gb)} GB free disk`}
            detail="The Turbo model needs about 32 GB once."
          />
          <CheckRow
            tone={s.ffmpeg ? "ok" : "neutral"}
            icon={<FilmStrip size={18} />}
            label={s.ffmpeg ? "ffmpeg found" : "ffmpeg not found"}
            detail={s.ffmpeg ? "Video export is available." : "Optional, only for video export: brew install ffmpeg."}
          />
        </div>
      )}
    </StepFrame>
  );
}

function ModelRow({ m, recommended }: { m: ModelInfo; recommended?: boolean }) {
  const [starting, setStarting] = useState(false);
  const p = m.progress;
  const frac = p && p.total_bytes ? p.done_bytes / p.total_bytes : 0;
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-surface)] border border-line-2 bg-paper px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-wash text-ink-2">
          {m.cached ? <CheckCircle size={17} weight="fill" className="text-ok" /> : <CloudArrowDown size={17} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[14px] font-semibold tracking-[-0.01em]">
            {m.id === "qwen-image-2.1-turbo" ? "Qwen-Image 2.1 Turbo" : m.id === "qwen-image-2.1" ? "Qwen-Image 2.1" : m.id}
            {recommended && <Badge tone="accent">Recommended</Badge>}
          </span>
          <span className="num text-[12px] text-ink-2">
            {m.repo} · about {m.approx_gb} GB
          </span>
        </div>
        <div className="shrink-0">
          {m.cached ? (
            <Badge tone="ok">Ready</Badge>
          ) : m.downloading ? (
            <span className="num text-[12px] text-ink-2">{p ? `${fmtBytes(p.done_bytes)} of ${fmtBytes(p.total_bytes)}` : "Starting"}</span>
          ) : (
            <Button
              size="sm"
              variant={recommended ? "primary" : "secondary"}
              loading={starting}
              onClick={async () => {
                setStarting(true);
                await attempt(() => Api.downloadModel(m.id));
                setStarting(false);
              }}
            >
              Download
            </Button>
          )}
        </div>
      </div>
      {m.downloading && <Progress value={frac} />}
      {m.error && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-err">
          <WarningCircle size={14} /> {m.error}
        </p>
      )}
    </div>
  );
}

function ModelStep({ settings }: { settings: Settings }) {
  const models = useModels();
  const list = models.data;
  return (
    <StepFrame title="Image model" body="Panels are drawn by Qwen-Image 2.1 on this Mac. It downloads once from Hugging Face and stays in its cache.">
      <div className="flex flex-col gap-2.5">
        {!list ? (
          models.error ? (
            <p className="text-[13px] text-err">{models.error.message}</p>
          ) : (
            [0, 1].map((n) => <div key={n} className="skeleton h-[66px]" />)
          )
        ) : (
          [...list]
            .sort((a, b) => (a.id === settings.image.model ? -1 : b.id === settings.image.model ? 1 : 0))
            .map((m) => <ModelRow key={m.id} m={m} recommended={m.id === "qwen-image-2.1-turbo"} />)
        )}
        <p className="pt-2 text-[12.5px] leading-relaxed text-ink-2">
          Turbo draws a panel in about a minute at 4-bit. The base model is slower and best kept for finals. Without a model you can still try everything with the mock engine:{" "}
          <code className="num">uv run studio serve --mock</code>.
        </p>
      </div>
    </StepFrame>
  );
}
