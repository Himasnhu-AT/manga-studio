// Mode B: source text -> six stages -> a finished project that opens in the Studio.
// Left: the source with coverage (which characters of the text ended up in a panel).
// Right: the stages, each with status, progress, its output and a manual override.

import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight,
  CaretDown,
  CheckCircle,
  Circle,
  FlowArrow,
  Hourglass,
  PencilSimple,
  Play,
  Robot,
  Stop,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Api, type Coverage, type PipelineStage, type PipelineState, type StageId, type StageStatus } from "../lib/api";
import { useDebounced, useLive } from "../lib/live";
import { attempt, useApp } from "../lib/store";
import { Badge, Button, Empty, Progress, Segmented, Spinner, Textarea, cx, spring } from "../ui/kit";
import { CopyBlock } from "./app-common";

const STAGE_NAMES: Record<StageId, string> = {
  analysis: "Source analysis",
  script: "Script",
  layout: "Storyboard layout",
  artwork: "Artwork",
  lettering: "Lettering",
  qa: "QA gate",
};
const STAGE_HINTS: Record<StageId, string> = {
  analysis: "Cast, locations and story beats from the text.",
  script: "Pages and panels with camera, action and dialogue.",
  layout: "Panel boxes and reading order on each page.",
  artwork: "Text-free panel art, drawn with the cast sheets.",
  lettering: "Bubbles placed away from faces and busy areas.",
  qa: "Checks consistency, anatomy and bubble overlap. Retries up to 3 times.",
};
const ORDER: StageId[] = ["analysis", "script", "layout", "artwork", "lettering", "qa"];

export function Pipeline() {
  const slug = useApp((s) => s.slug)!;
  const go = useApp((s) => s.go);
  const pipe = useLive(() => Api.pipeline(slug), [slug]);
  const p = pipe.data;

  // SSE drives refreshes; poll as a fallback while a run is active.
  const { reload } = pipe;
  useEffect(() => {
    if (!p?.running) return;
    const t = window.setInterval(() => void reload(), 2000);
    return () => window.clearInterval(t);
  }, [p?.running, reload]);

  const stages: PipelineStage[] = useMemo(() => {
    const byId = new Map((p?.stages ?? []).map((s) => [s.id, s]));
    return ORDER.map((id) => byId.get(id) ?? { id, name: STAGE_NAMES[id], status: "idle" as StageStatus });
  }, [p]);

  const started = stages.some((s) => s.status !== "idle");
  const allDone = stages.every((s) => s.status === "done" || s.status === "flagged");
  const [provider, setProvider] = useState<PipelineState["provider"] | null>(null);
  const prov = provider ?? p?.provider ?? "agent";

  const run = async (from?: StageId) => {
    const r = await attempt(() => Api.runPipeline(slug, { from, provider: prov }));
    if (r) pipe.setData(r);
  };

  if (pipe.error && !p) {
    return (
      <Empty icon={<FlowArrow size={20} />} title="Pipeline unavailable" body={pipe.error.message} action={<Button onClick={() => void pipe.reload()}>Try again</Button>} />
    );
  }

  return (
    <div className="mx-auto grid h-full w-full max-w-[1320px] grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_440px]">
      <SourcePane slug={slug} editable={!started} />

      <aside className="flex min-h-0 flex-col border-line lg:border-l">
        <div className="flex flex-col gap-3 border-b border-line px-6 pt-6 pb-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="type-title">Pipeline</h2>
            {p?.running ? (
              <Button size="sm" variant="secondary" icon={<Stop size={13} weight="fill" />} onClick={() => void attempt(() => Api.cancelPipeline(slug))}>
                Cancel
              </Button>
            ) : allDone ? (
              <Button size="sm" variant="primary" trailing={<ArrowRight size={13} />} onClick={() => go("studio")}>
                Open in Studio
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon={<Play size={13} weight="fill" />} onClick={() => void run()}>
                {started ? "Run again" : "Run all"}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="type-label">Language model</span>
            <Segmented
              size="sm"
              value={prov}
              onChange={setProvider}
              options={[
                { value: "agent", label: "Agent", title: "Claude Code or Codex over MCP" },
                { value: "ollama", label: "Ollama", title: "Local model" },
                { value: "heuristic", label: "Heuristic", title: "Simple rules, no AI" },
              ]}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {!p ? (
            <div className="flex flex-col gap-2 px-3">
              {ORDER.map((id) => (
                <div key={id} className="skeleton h-14" />
              ))}
            </div>
          ) : (
            <ol className="flex flex-col">
              {stages.map((s, n) => (
                <StageRow
                  key={s.id}
                  slug={slug}
                  stage={s}
                  last={n === stages.length - 1}
                  state={p}
                  running={!!p.running}
                  onRunFrom={() => void run(s.id)}
                  onChanged={(st) => pipe.setData(st)}
                />
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );
}

// ---- Source + coverage -------------------------------------------------------

function SourcePane({ slug, editable }: { slug: string; editable: boolean }) {
  const src = useLive(() => Api.source(slug), [slug]);
  const cov = useLive<Coverage | null>(() => (editable ? Promise.resolve(null) : Api.coverage(slug).catch(() => null)), [slug, editable]);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const save = useDebounced(async (t: string) => {
    await attempt(() => Api.putSource(slug, t));
    setSaved(true);
  }, 600);

  useEffect(() => {
    if (src.data && text === null) setText(src.data.text);
  }, [src.data, text]);

  const body = text ?? src.data?.text ?? "";
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const c = cov.data;

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-8 pt-6 pb-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="type-title">Source</h2>
          <span className="num text-[12px] text-ink-2">
            {words} words
            {c && <> · {Math.round(c.covered_ratio * 100)}% in panels</>}
          </span>
        </div>
        {editable ? (
          <span className="text-[12px] text-ink-2">{saved ? "Saved" : "Saving"}</span>
        ) : c && c.gaps.length > 0 ? (
          <Badge tone="accent">{c.gaps.length === 1 ? "1 passage not in any panel" : `${c.gaps.length} passages not in any panel`}</Badge>
        ) : c ? (
          <Badge tone="ok">Every passage is in a panel</Badge>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {src.loading ? (
          <div className="flex max-w-[68ch] flex-col gap-2.5">
            {[90, 100, 84, 96, 70].map((w, i) => (
              <div key={i} className="skeleton h-3.5" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : editable ? (
          <Textarea
            className="min-h-[60vh] max-w-[68ch] border-none bg-transparent px-0 text-[15px] leading-[1.75] shadow-none focus:shadow-none"
            value={body}
            placeholder="Paste a chapter, a short story or a script. Dialogue in quotes becomes speech bubbles."
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
              save(e.target.value);
            }}
          />
        ) : (
          <CoverageText text={body} cov={c ?? null} />
        )}
      </div>
    </section>
  );
}

function CoverageText({ text, cov }: { text: string; cov: Coverage | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const segs = useMemo(() => {
    type Seg = { start: number; end: number; panels?: string[]; gap?: boolean };
    if (!cov) return [{ start: 0, end: text.length }] as Seg[];
    const marks: Seg[] = [...cov.spans.map((s) => ({ ...s })), ...cov.gaps.map((g) => ({ ...g, gap: true }))]
      .filter((s) => s.end > s.start)
      .sort((a, b) => a.start - b.start);
    const out: Seg[] = [];
    let at = 0;
    for (const m of marks) {
      const start = Math.max(m.start, at);
      if (start >= m.end) continue;
      if (start > at) out.push({ start: at, end: start });
      out.push({ ...m, start });
      at = m.end;
    }
    if (at < text.length) out.push({ start: at, end: text.length });
    return out;
  }, [text, cov]);

  return (
    <p className="selectable max-w-[68ch] text-[15px] leading-[1.75] whitespace-pre-wrap text-ink">
      {segs.map((s, i) =>
        s.gap ? (
          <mark key={i} title="Not in any panel" className="rounded-[3px] bg-accent-wash text-ink underline decoration-accent decoration-wavy decoration-1 underline-offset-4">
            {text.slice(s.start, s.end)}
          </mark>
        ) : s.panels ? (
          <span
            key={i}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            className={cx(
              "relative rounded-[3px] transition-colors duration-150",
              hover === i ? "bg-[#dcdcd7]" : segs.slice(0, i).filter((x) => x.panels).length % 2 ? "bg-[#e9e9e5]" : "bg-paper",
            )}
          >
            {text.slice(s.start, s.end)}
            {hover === i && (
              <span className="num pointer-events-none absolute -top-6 left-0 z-10 rounded-[6px] bg-ink px-1.5 py-0.5 text-[11px] whitespace-nowrap text-paper">
                {s.panels.join(", ")}
              </span>
            )}
          </span>
        ) : (
          <span key={i} className="text-ink-2">
            {text.slice(s.start, s.end)}
          </span>
        ),
      )}
    </p>
  );
}

// ---- Stages -----------------------------------------------------------------

function StatusIcon({ status }: { status: StageStatus }) {
  switch (status) {
    case "running":
      return <Spinner className="size-4 text-accent" />;
    case "done":
      return <CheckCircle size={18} weight="fill" className="text-ok" />;
    case "awaiting_agent":
      return <Hourglass size={18} weight="fill" className="text-accent" />;
    case "error":
      return <XCircle size={18} weight="fill" className="text-err" />;
    case "flagged":
      return <WarningCircle size={18} weight="fill" className="text-warn" />;
    default:
      return <Circle size={18} className="text-ink-3" />;
  }
}

const STATUS_LABEL: Record<StageStatus, string> = {
  idle: "Not run",
  running: "Running",
  awaiting_agent: "Waiting for agent",
  done: "Done",
  error: "Failed",
  flagged: "Needs a look",
};

function StageRow({
  slug,
  stage,
  state,
  last,
  running,
  onRunFrom,
  onChanged,
}: {
  slug: string;
  stage: PipelineStage;
  state: PipelineState;
  last: boolean;
  running: boolean;
  onRunFrom: () => void;
  onChanged: (s: PipelineState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const hasOutput = stage.output !== undefined && stage.output !== null;
  const qa = stage.id === "qa" ? state.qa : undefined;
  const expandable = hasOutput || !!qa;
  const pr = stage.progress;

  useEffect(() => {
    if (stage.status === "awaiting_agent" || stage.status === "flagged") setOpen(true);
  }, [stage.status]);

  return (
    <li className="relative flex gap-3 rounded-[var(--radius-surface)] px-3 py-3 hover:bg-wash/50">
      {/* connector line between stage icons */}
      {!last && <span className="absolute top-9 bottom-[-6px] left-[20.5px] w-px bg-line-2" aria-hidden />}
      <span className="relative mt-0.5 flex size-[18px] shrink-0 items-center justify-center">
        <StatusIcon status={stage.status} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <button className="flex min-w-0 items-center gap-1.5 text-left" onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable}>
            <span className="truncate text-[13.5px] font-semibold tracking-[-0.01em]">{STAGE_NAMES[stage.id] ?? stage.name}</span>
            {expandable && <CaretDown size={12} className={cx("shrink-0 text-ink-3 transition-transform duration-200", open && "rotate-180")} />}
          </button>
          <span className="flex shrink-0 items-center gap-1">
            <span className={cx("text-[12px]", stage.status === "error" ? "text-err" : stage.status === "awaiting_agent" ? "text-accent-ink" : "text-ink-2")}>
              {pr && stage.status === "running" ? (
                <span className="num">
                  {pr.done}/{pr.total}
                </span>
              ) : (
                STATUS_LABEL[stage.status]
              )}
            </span>
            {!running && (
              <button title="Run from this stage" aria-label={`Run from ${STAGE_NAMES[stage.id]}`} onClick={onRunFrom} className="pressable flex size-6 items-center justify-center rounded-[6px] text-ink-3 hover:bg-paper hover:text-ink">
                <Play size={11} weight="fill" />
              </button>
            )}
          </span>
        </div>
        <p className="text-[12.5px] text-ink-2">{stage.detail || STAGE_HINTS[stage.id]}</p>
        {stage.status === "running" && pr && pr.total > 0 && <Progress value={pr.done / pr.total} className="mt-1" />}

        {stage.status === "awaiting_agent" && <AgentCallout slug={slug} instructions={state.task?.stage === stage.id ? state.task.instructions : undefined} />}

        <AnimatePresence initial={false}>
          {open && expandable && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring}
              className="overflow-hidden"
            >
              <div className="mt-2 flex flex-col gap-3 rounded-[var(--radius-control)] border border-line bg-paper p-3">
                {editing ? (
                  <JsonEditor
                    value={stage.output}
                    onCancel={() => setEditing(false)}
                    onSave={async (v) => {
                      const r = await attempt(() => Api.overrideStage(slug, stage.id, v), "Stage output replaced");
                      if (r) {
                        onChanged(r);
                        setEditing(false);
                      }
                    }}
                  />
                ) : (
                  <>
                    <StageOutput stage={stage} qa={qa} />
                    {hasOutput && (
                      <div>
                        <Button size="sm" variant="ghost" icon={<PencilSimple size={13} />} onClick={() => setEditing(true)}>
                          Edit output
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </li>
  );
}

function AgentCallout({ slug, instructions }: { slug: string; instructions?: string }) {
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-[var(--radius-control)] border border-accent/25 bg-accent-wash/60 p-3">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-accent-ink">
        <Robot size={15} /> Waiting for your agent
      </p>
      {instructions && <p className="line-clamp-3 text-[12.5px] text-ink-2">{instructions}</p>}
      <CopyBlock text={`Run the manga-studio pipeline task for ${slug}`} className="bg-paper" />
      <p className="text-[12px] text-ink-2">Paste that into Claude Code or Codex. It picks up the task over MCP and posts the result here.</p>
    </div>
  );
}

// ---- Output viewers -----------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
const asArr = (v: any): any[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.entries(v).map(([id, x]) => ({ id, ...(x as object) })) : []);
const str = (v: any) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="type-label">{title}</span>
      {children}
    </div>
  );
}

function StageOutput({ stage, qa }: { stage: PipelineStage; qa?: PipelineState["qa"] }) {
  const o: any = stage.output;
  if (stage.id === "analysis" && o) {
    const cast = asArr(o.cast);
    const locs = asArr(o.locations);
    const beats = asArr(o.beats);
    return (
      <div className="flex flex-col gap-3 text-[12.5px]">
        {cast.length > 0 && (
          <Sub title={`Cast (${cast.length})`}>
            <ul className="flex flex-col gap-1">
              {cast.map((c, i) => (
                <li key={i}>
                  <span className="font-semibold">{str(c.name ?? c.id)}</span>
                  {c.role && <span className="text-ink-2">, {str(c.role)}</span>}
                  {(c.hair || c.outfit) && <span className="block text-ink-2">{[c.hair, c.outfit].filter(Boolean).map(str).join(". ")}</span>}
                </li>
              ))}
            </ul>
          </Sub>
        )}
        {locs.length > 0 && (
          <Sub title={`Locations (${locs.length})`}>
            <p className="text-ink-2">{locs.map((l) => str(l.name ?? l.id ?? l)).join(", ")}</p>
          </Sub>
        )}
        {beats.length > 0 && (
          <Sub title={`Beats (${beats.length})`}>
            <ol className="flex list-decimal flex-col gap-1 pl-4 text-ink-2">
              {beats.map((b, i) => (
                <li key={i}>{str(b.summary ?? b.text ?? b)}</li>
              ))}
            </ol>
          </Sub>
        )}
      </div>
    );
  }
  if (stage.id === "script" && o) {
    const pages = asArr(o.pages);
    return (
      <div className="flex flex-col gap-3 text-[12.5px]">
        {pages.map((pg, i) => (
          <Sub key={i} title={`Page ${i + 1}`}>
            <ul className="flex flex-col gap-2">
              {asArr(pg.panels).map((pn, j) => (
                <li key={j} className="flex flex-col gap-0.5">
                  <span>
                    <span className="num font-semibold">{str(pn.id ?? `${i + 1}.${j + 1}`)}</span>
                    {pn.camera && <span className="text-ink-2"> · {str(pn.camera)}</span>}
                  </span>
                  {pn.action && <span className="text-ink-2">{str(pn.action)}</span>}
                  {asArr(pn.dialogue).map((d, k) => (
                    <span key={k} className="text-ink">
                      <span className="font-medium">{str(d.speaker) || "Narration"}:</span> {str(d.text)}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </Sub>
        ))}
      </div>
    );
  }
  if (stage.id === "qa" && qa) {
    return <QaList qa={qa} />;
  }
  return <pre className="num selectable max-h-72 overflow-auto text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{JSON.stringify(o, null, 2)}</pre>;
}

function QaList({ qa }: { qa: NonNullable<PipelineState["qa"]> }) {
  const go = useApp((s) => s.go);
  const select = useApp((s) => s.selectPanel);
  const rows = Object.entries(qa.panels).sort(([, a], [, b]) => Number(b.flagged) - Number(a.flagged) || Number(a.ok) - Number(b.ok));
  if (!rows.length) return <p className="text-[12.5px] text-ink-2">No panels checked yet.</p>;
  return (
    <ul className="flex flex-col divide-y divide-line">
      {rows.map(([pid, r]) => (
        <li key={pid} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2 text-[12.5px]">
              <span className="num font-semibold">{pid}</span>
              {r.flagged ? <Badge tone="warn">Flagged</Badge> : r.ok ? <Badge tone="ok">Passed</Badge> : <Badge tone="err">Issues</Badge>}
              {r.attempts > 1 && <span className="num text-[11.5px] text-ink-2">{r.attempts} attempts</span>}
            </span>
            {r.issues.map((t, i) => (
              <span key={i} className="text-[12px] text-ink-2">
                {t}
              </span>
            ))}
          </div>
          {!r.ok && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                go("studio");
                select(pid);
              }}
            >
              Fix in Studio
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function JsonEditor({ value, onSave, onCancel }: { value: unknown; onSave: (v: unknown) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        className="num min-h-64 text-[11.5px] leading-relaxed"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setErr(null);
        }}
      />
      {err && <p className="text-[12px] text-err">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={async () => {
            let v: unknown;
            try {
              v = JSON.parse(text);
            } catch (e) {
              setErr(`Not valid JSON: ${(e as Error).message}`);
              return;
            }
            setBusy(true);
            await onSave(v);
            setBusy(false);
          }}
        >
          Save output
        </Button>
      </div>
    </div>
  );
}
