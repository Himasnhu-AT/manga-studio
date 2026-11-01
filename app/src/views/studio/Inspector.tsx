import { Reorder } from "motion/react";
import {
  ArrowSquareOut,
  Check,
  Copy,
  DotsSixVertical,
  Eye,
  EyeSlash,
  Images,
  Lightning,
  NotePencil,
  Plus,
  Selection,
  Sparkle,
  Stack,
  Trash,
  UploadSimple,
  Users,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Api, type FxItem, type Job, type Layers, type Panel, type StoryDetail } from "../../lib/api";
import { useDebounced, useLive } from "../../lib/live";
import { attempt, useApp } from "../../lib/store";
import { Badge, Button, IconButton, Input, Progress, Segmented, Textarea, cx } from "../../ui/kit";
import { CastStudio } from "./CastStudio";
import { Copilot } from "./Copilot";
import { Versions } from "./Versions";
import { useStudio } from "./studioState";
import { Chip, Collapse, Slider, Thumb, refName, refThumb, useSyncedText } from "./side-common";

export function Inspector({ story, panel }: { story: StoryDetail; panel: Panel | null }) {
  const [castOpen, setCastOpen] = useState(false);
  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col overflow-y-auto border-l border-line bg-paper">
      {panel ? <PanelInspector key={panel.id} story={story} panel={panel} openCast={() => setCastOpen(true)} /> : <StoryInspector story={story} openCast={() => setCastOpen(true)} />}
      <CastStudio story={story} open={castOpen} onClose={() => setCastOpen(false)} />
    </aside>
  );
}

// ---- story level ----------------------------------------------------------

function StoryInspector({ story, openCast }: { story: StoryDetail; openCast: () => void }) {
  const title = useSyncedText(story.title, (v) => void attempt(() => Api.patchStory(story.slug, { title: v })), story.slug);
  const avoid = useSyncedText(story.avoid ?? "", (v) => void attempt(() => Api.patchStory(story.slug, { avoid: v })), story.slug);
  const castIds = Object.keys(story.cast ?? {});
  const f = story.format;
  const openNotes = story.state.notes.map((n, i) => ({ ...n, i })).filter((n) => !n.done);
  const stripPanels = story.panels.filter((p) => p.strip !== false);
  const generated = stripPanels.filter((p) => p.pick).length;

  return (
    <>
      <div className="flex flex-col gap-3 px-4 pt-4 pb-4">
        <Input aria-label="Title" value={title.value} onChange={(e) => title.onChange(e.target.value)} className="h-9 border-transparent px-1.5 text-[16px] font-semibold tracking-[-0.012em] hover:border-line-2" />
        <div className="flex flex-wrap gap-1.5 px-1.5">
          <Badge>{f?.mode === "webtoon" ? "Webtoon scroll" : "Manga pages"}</Badge>
          {f?.mode !== "webtoon" && <Badge>{f?.direction === "ltr" ? "Left to right" : "Right to left"}</Badge>}
          <Badge>
            <span className="num">
              {generated}/{stripPanels.length}
            </span>{" "}
            panels drawn
          </Badge>
        </div>
        <p className="px-1.5 text-[12.5px] text-ink-2">Select a panel on the canvas to edit it.</p>
      </div>

      <Collapse title="Cast" icon={<Users size={13} />} action={<Button size="sm" variant="ghost" onClick={openCast}>Open</Button>}>
        {castIds.length === 0 ? (
          <p className="text-[12.5px] text-ink-2">No characters yet. Describe each one once and every panel reuses the same words.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {castIds.map((id) => {
              const c = story.cast[id];
              return (
                <button key={id} type="button" onClick={openCast} className="flex items-center gap-2.5 rounded-[var(--radius-control)] px-1.5 py-1 text-left hover:bg-wash">
                  <Thumb src={c.sheet ? refThumb(story, c.sheet) : c.refs?.[0] ? refThumb(story, c.refs[0]) : null} alt={c.name} className="size-7 shrink-0 rounded-full" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{c.name || id}</span>
                    <span className="block truncate text-[12px] text-ink-2">{c.outfit || c.role}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <Button size="sm" icon={<Plus size={13} />} onClick={openCast} className="self-start">
          Add character
        </Button>
      </Collapse>

      <Collapse title="Prompt blocks" icon={<Stack size={13} />}>
        <BlocksEditor story={story} />
        <div className="flex flex-col gap-1.5">
          <label className="type-label">Avoid</label>
          <Textarea value={avoid.value} onChange={(e) => avoid.onChange(e.target.value)} className="min-h-14 text-[12.5px]" placeholder="t-shirt, navy hair, any text" />
          <p className="text-[12px] text-ink-2">Appended as “Avoid: …”. Turbo ignores negative prompts.</p>
        </div>
      </Collapse>

      <Collapse title={`Notes${openNotes.length ? ` (${openNotes.length})` : ""}`} icon={<NotePencil size={13} />} defaultOpen={openNotes.length > 0}>
        <NotesList story={story} notes={openNotes} />
        <AddNote story={story} panel={null} />
      </Collapse>
    </>
  );
}

function BlocksEditor({ story }: { story: StoryDetail }) {
  const [adding, setAdding] = useState("");
  const keys = Object.keys(story.blocks ?? {});
  return (
    <div className="flex flex-col gap-3">
      {keys.map((k) => (
        <BlockField key={k} story={story} name={k} />
      ))}
      <div className="flex gap-1.5">
        <Input value={adding} onChange={(e) => setAdding(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} placeholder="new block name" className="num" aria-label="New block name" />
        <Button
          size="md"
          icon={<Plus size={13} />}
          disabled={!adding || keys.includes(adding)}
          onClick={async () => {
            const r = await attempt(() => Api.patchStory(story.slug, { blocks: { ...story.blocks, [adding]: "" } }));
            if (r !== undefined) setAdding("");
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function BlockField({ story, name }: { story: StoryDetail; name: string }) {
  const t = useSyncedText(story.blocks[name] ?? "", (v) => void attempt(() => Api.patchStory(story.slug, { blocks: { [name]: v } })), `${story.slug}/${name}`);
  const inCast = name in (story.cast ?? {});
  return (
    <div className="flex flex-col gap-1.5">
      <label className="type-label flex items-center gap-1.5">
        <span className="num">{name}</span>
        {inCast && <Badge tone="warn">overrides cast</Badge>}
      </label>
      <Textarea value={t.value} onChange={(e) => t.onChange(e.target.value)} className="min-h-20 text-[12.5px]" />
    </div>
  );
}

// ---- panel level ----------------------------------------------------------

function PanelInspector({ story, panel, openCast }: { story: StoryDetail; panel: Panel; openCast: () => void }) {
  const slug = story.slug;
  const patch = (b: Record<string, unknown>) => attempt(() => Api.patchPanel(slug, panel.id, b));
  const title = useSyncedText(panel.title ?? "", (v) => void patch({ title: v }), panel.id);
  const action = useSyncedText(panel.action ?? "", (v) => void patch({ action: v }), panel.id);
  const [source, setSource] = useState<string | null>(null);

  const castIds = Object.keys(story.cast ?? {});
  const blockKeys = useMemo(() => [...new Set([...Object.keys(story.blocks ?? {}), ...castIds])], [story.blocks, castIds.join(",")]);
  const notes = story.state.notes.map((n, i) => ({ ...n, i })).filter((n) => n.panel === panel.id && !n.done);

  const toggle = (key: "cast" | "use", id: string) => {
    const cur = panel[key] ?? [];
    void patch({ [key]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };

  return (
    <>
      <div className="flex flex-col gap-2 px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <Badge>
            <span className="num">{panel.id}</span>
          </Badge>
          {panel.strip === false && <Badge tone="accent">reference</Badge>}
        </div>
        <Input aria-label="Panel title" value={title.value} onChange={(e) => title.onChange(e.target.value)} placeholder="Untitled panel" className="h-9 border-transparent px-1.5 text-[16px] font-semibold tracking-[-0.012em] hover:border-line-2" />
      </div>

      <div className="flex flex-col gap-3 px-4 pb-4">
        <Versions story={story} panel={panel} onUseSource={setSource} />
        <GenerateRow story={story} panel={panel} />
      </div>

      <Collapse title="Action" icon={<Lightning size={13} />}>
        <Textarea value={action.value} onChange={(e) => action.onChange(e.target.value)} className="min-h-28 text-[13px]" placeholder="What happens in this panel. Who is where, doing what, with which expression." />
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <p className="type-label">Cast</p>
            <button type="button" onClick={openCast} className="text-[12px] text-ink-2 hover:text-ink">
              Edit cast
            </button>
          </div>
          {castIds.length ? (
            <div className="flex flex-wrap gap-1.5">
              {castIds.map((id) => (
                <Chip key={id} on={(panel.cast ?? []).includes(id)} onClick={() => toggle("cast", id)} title="Adds their block and reference sheet">
                  {story.cast[id].name || id}
                </Chip>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-ink-2">No characters yet.</p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="type-label">Blocks used</p>
          <div className="flex flex-wrap gap-1.5">
            {blockKeys.map((k) => (
              <Chip key={k} on={(panel.use ?? []).includes(k)} onClick={() => toggle("use", k)}>
                <span className="num">{k}</span>
              </Chip>
            ))}
          </div>
        </div>
      </Collapse>

      <Collapse title="References" icon={<Images size={13} />}>
        <RefsEditor story={story} panel={panel} />
      </Collapse>

      <Collapse title="Prompt" icon={<Selection size={13} />} defaultOpen={false}>
        <SeedStrength panel={panel} patch={patch} />
        <PromptPreview panel={panel} />
      </Collapse>

      <Copilot story={story} panel={panel} source={source} setSource={setSource} />

      <Collapse title="Layers" icon={<Stack size={13} />} defaultOpen={false}>
        <LayersEditor panel={panel} patch={patch} />
        <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
          <div className="text-[12.5px]">
            <p>Protected areas</p>
            <p className="text-ink-2">
              <span className="num">{panel.protect?.length ?? 0}</span> box{panel.protect?.length === 1 ? "" : "es"}. Auto-lettering keeps bubbles off them.
            </p>
          </div>
          <Button size="sm" variant="ghost" disabled={!panel.protect?.length} onClick={() => void patch({ protect: null })}>
            Clear
          </Button>
        </div>
      </Collapse>

      <Collapse title={`Notes${notes.length ? ` (${notes.length})` : ""}`} icon={<NotePencil size={13} />} defaultOpen={notes.length > 0}>
        <NotesList story={story} notes={notes} />
        <AddNote story={story} panel={panel.id} />
      </Collapse>
    </>
  );
}

function GenerateRow({ story, panel }: { story: StoryDetail; panel: Panel }) {
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const jobs = useLive(() => Api.jobs(story.slug, true), [story.slug]);
  const mine: Job[] = (jobs.data ?? []).filter((j) => j.panel === panel.id);
  const running = mine.find((j) => j.status === "running");
  const queued = mine.filter((j) => j.status === "queued");

  return (
    <div className="flex flex-col gap-2">
      {panel.plan_error && (
        <p className="flex items-start gap-1.5 rounded-[var(--radius-control)] bg-[#fdeeee] px-2.5 py-2 text-[12px] text-err">
          <WarningCircle size={14} className="mt-px shrink-0" />
          <span className="selectable">{panel.plan_error}</span>
        </p>
      )}
      <div className="flex items-center gap-2">
        <Segmented size="sm" value={String(count)} onChange={(v) => setCount(Number(v))} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: <span className="num">{n}</span>, title: `${n} version${n > 1 ? "s" : ""}` }))} />
        {panel.pick && (
          <Button className="ml-auto" icon={<Sparkle size={13} weight="fill" className="text-accent" />} onClick={() => useStudio.getState().setRefine(true)} title="Turn your drawing into clean lines, inks, tone or color">
            Refine
          </Button>
        )}
        <Button
          variant="primary"
          className={panel.pick ? undefined : "ml-auto"}
          loading={busy}
          disabled={!!panel.plan_error}
          onClick={async () => {
            setBusy(true);
            await attempt(() => Api.generate(story.slug, panel.id, count), `Queued ${count} for ${panel.id}`);
            setBusy(false);
          }}
        >
          Generate
        </Button>
      </div>
      {(running || queued.length > 0) && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[12px] text-ink-2">
            <span>{running ? (running.steps ? "Drawing" : "Loading model") : "Queued"}</span>
            <span className="num">
              {running?.steps ? `${running.step ?? 0}/${running.steps}` : ""}
              {queued.length ? `${running ? " · " : ""}${queued.length} waiting` : ""}
            </span>
          </div>
          <Progress value={running?.steps ? (running.step ?? 0) / running.steps : 0} />
          {queued.length > 0 && (
            <button type="button" className="self-start text-[12px] text-ink-2 hover:text-ink" onClick={() => queued.forEach((j) => void attempt(() => Api.cancelJob(j.id)))}>
              Cancel waiting
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RefsEditor({ story, panel }: { story: StoryDetail; panel: Panel }) {
  const raw = panel.refs ?? [];
  const names = raw.map(refName);
  const [order, setOrder] = useState(names);
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(() => setOrder(names), [names.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (next: string[]) => {
    const byName = new Map(raw.map((r) => [refName(r), r]));
    return attempt(() => Api.patchPanel(story.slug, panel.id, { refs: next.map((n) => byName.get(n) ?? n) }));
  };
  const saveOrder = useDebounced((next: string[]) => void save(next), 350);

  const candidates = [
    ...story.panels.filter((p) => p.strip === false && p.id !== panel.id).map((p) => ({ name: p.id, label: p.title || p.id })),
    ...story.refs.map((r) => ({ name: r, label: r })),
  ].filter((c) => !names.includes(c.name));

  async function upload(files: FileList) {
    const added: string[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      const r = await attempt(() => Api.uploadRef(story.slug, f));
      if (r) added.push(r.name);
    }
    if (added.length) await save([...names, ...added.filter((a) => !names.includes(a))]);
  }

  const labelOf = (n: string) => {
    const r = panel.resolved_refs.find((x) => x.name === n);
    return r?.label ?? n;
  };

  return (
    <div
      className={cx("flex flex-col gap-2 rounded-[var(--radius-control)] transition-[box-shadow] duration-150", over && "shadow-[0_0_0_2px_var(--color-accent)]")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }
      }}
    >
      {order.length === 0 ? (
        <p className="text-[12.5px] text-ink-2">No references. Add the character sheet and room plate so every panel shares the same anchors.</p>
      ) : (
        <Reorder.Group axis="y" values={order} onReorder={(next) => { setOrder(next); saveOrder(next); }} className="flex flex-col gap-1">
          {order.map((n, i) => (
            <Reorder.Item key={n} value={n} className="group flex items-center gap-2 rounded-[var(--radius-control)] bg-paper py-1 pr-1 hover:bg-wash">
              <DotsSixVertical size={14} className="shrink-0 cursor-grab text-ink-3 active:cursor-grabbing" />
              <span className="num w-4 shrink-0 text-[11px] text-ink-3">{i + 1}</span>
              <Thumb src={refThumb(story, n)} alt={n} className="h-10 w-8 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="num block truncate text-[12px]">{n}</span>
                <span className="block truncate text-[11.5px] text-ink-2">{labelOf(n)}</span>
              </span>
              <IconButton label={`Remove ${n}`} size="sm" className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => void save(names.filter((x) => x !== n))}>
                <X size={12} />
              </IconButton>
            </Reorder.Item>
          ))}
        </Reorder.Group>
      )}
      {order.length > 10 && (
        <p className="flex items-center gap-1.5 text-[12px] text-err">
          <WarningCircle size={13} /> Qwen-Image takes at most 10 references. Remove {order.length - 10}.
        </p>
      )}
      {order.length > 0 && <p className="text-[12px] text-ink-2">The prompt names them by position: Image 1, Image 2. Drag to reorder; the first is the source for small edits.</p>}

      {adding ? (
        <div className="flex flex-col gap-1 rounded-[var(--radius-control)] border border-line p-1.5">
          {candidates.length === 0 && <p className="px-1 py-1 text-[12px] text-ink-2">Nothing else to add. Upload an image.</p>}
          {candidates.map((c) => (
            <button
              key={c.name}
              type="button"
              className="flex items-center gap-2 rounded-[6px] px-1 py-1 text-left hover:bg-wash"
              onClick={() => {
                void save([...names, c.name]);
                setAdding(false);
              }}
            >
              <Thumb src={refThumb(story, c.name)} alt={c.name} className="h-8 w-6 shrink-0" />
              <span className="num truncate text-[12px]">{c.label}</span>
            </button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Done
          </Button>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
            Add
          </Button>
          <label className="pressable inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-wash hover:text-ink">
            <UploadSimple size={13} />
            Upload
            <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />
          </label>
        </div>
      )}
    </div>
  );
}

function SeedStrength({ panel, patch }: { panel: Panel; patch: (b: Record<string, unknown>) => Promise<unknown> }) {
  const [seed, setSeed] = useState(panel.seed != null ? String(panel.seed) : "");
  const [strength, setStrength] = useState(panel.strength ?? 1);
  useEffect(() => setSeed(panel.seed != null ? String(panel.seed) : ""), [panel.seed]);
  useEffect(() => setStrength(panel.strength ?? 1), [panel.strength]);
  const saveStrength = useDebounced((v: number) => void patch({ strength: v === 1 ? null : v }), 400);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3 text-[12.5px]">
        <span className="w-[68px] shrink-0 text-ink-2">Seed</span>
        <Input
          className="num h-7"
          inputMode="numeric"
          value={seed}
          placeholder="random"
          onChange={(e) => setSeed(e.target.value.replace(/\D/g, ""))}
          onBlur={() => void patch({ seed: seed ? Number(seed) : null })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <Slider
        label="Strength"
        value={strength}
        min={0.2}
        max={1}
        onChange={(v) => {
          setStrength(v);
          saveStrength(v);
        }}
      />
    </div>
  );
}

function PromptPreview({ panel }: { panel: Panel }) {
  const [copied, setCopied] = useState(false);
  if (!panel.prompt) return <p className="text-[12px] text-ink-2">{panel.plan_error ?? "No prompt yet."}</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <p className="type-label">Exact prompt</p>
        <button
          type="button"
          className="flex items-center gap-1 text-[12px] text-ink-2 hover:text-ink"
          onClick={async () => {
            await navigator.clipboard.writeText(panel.prompt!);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="selectable num max-h-72 overflow-auto rounded-[var(--radius-control)] bg-wash px-2.5 py-2 text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink">{panel.prompt}</pre>
    </div>
  );
}

// ---- layers --------------------------------------------------------------

const FX_TYPES: FxItem["type"][] = ["screentone", "speedlines", "focuslines"];
const FX_LABEL: Record<FxItem["type"], string> = { screentone: "Screentone", speedlines: "Speed lines", focuslines: "Focus lines" };

function LayersEditor({ panel, patch }: { panel: Panel; patch: (b: Record<string, unknown>) => Promise<unknown> }) {
  const [layers, setLayers] = useState<Layers>(panel.layers ?? {});
  const serverKey = JSON.stringify(panel.layers ?? {});
  useEffect(() => setLayers(panel.layers ?? {}), [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveD = useDebounced((l: Layers) => void patch({ layers: l }), 350);
  const update = (l: Layers) => {
    setLayers(l);
    saveD(l);
  };

  const vis = (k: keyof Layers) => layers[k]?.visible !== false;
  const toggle = (k: keyof Layers) => update({ ...layers, [k]: { ...(layers[k] ?? {}), visible: !vis(k) } });
  const items = layers.fx?.items ?? [];
  const setItems = (next: FxItem[]) => update({ ...layers, fx: { ...(layers.fx ?? {}), items: next } });

  const row = (k: keyof Layers, label: string, extra?: React.ReactNode) => (
    <div className="flex h-8 items-center gap-2">
      <IconButton label={vis(k) ? `Hide ${label}` : `Show ${label}`} size="sm" onClick={() => toggle(k)}>
        {vis(k) ? <Eye size={14} /> : <EyeSlash size={14} className="text-ink-3" />}
      </IconButton>
      <span className={cx("flex-1 text-[12.5px]", !vis(k) && "text-ink-3")}>{label}</span>
      {extra}
    </div>
  );

  return (
    <div className="flex flex-col">
      {row("lettering", "Lettering")}
      {row("fx", "Screentone and FX")}
      {items.map((it, i) => (
        <div key={i} className="mb-2 ml-9 flex flex-col gap-2 rounded-[var(--radius-control)] border border-line p-2.5">
          <div className="flex items-center gap-2">
            <select
              value={it.type}
              aria-label="Effect type"
              onChange={(e) => setItems(items.map((x, j) => (j === i ? ({ ...x, type: e.target.value } as FxItem) : x)))}
              className="h-7 flex-1 rounded-[6px] border border-line-2 bg-paper px-1.5 text-[12.5px] outline-none focus:border-ink"
            >
              {FX_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FX_LABEL[t]}
                </option>
              ))}
            </select>
            <IconButton label="Remove effect" size="sm" onClick={() => setItems(items.filter((_, j) => j !== i))}>
              <Trash size={13} />
            </IconButton>
          </div>
          <Slider label="Density" value={it.density ?? 0.5} onChange={(v) => setItems(items.map((x, j) => (j === i ? { ...x, density: v } : x)))} />
          <Slider label="Opacity" value={it.opacity ?? 0.25} onChange={(v) => setItems(items.map((x, j) => (j === i ? { ...x, opacity: v } : x)))} />
          {it.type !== "focuslines" && (
            <Slider label="Angle" value={(it as { angle?: number }).angle ?? 45} min={0} max={180} step={1} format={(v) => `${Math.round(v)}°`} onChange={(v) => setItems(items.map((x, j) => (j === i ? ({ ...x, angle: v } as FxItem) : x)))} />
          )}
        </div>
      ))}
      <div className="mb-1 ml-9 flex flex-wrap gap-1">
        {FX_TYPES.map((t) => (
          <Button key={t} size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setItems([...items, t === "focuslines" ? { type: t, density: 0.5, opacity: 0.35 } : { type: t, density: 0.5, opacity: 0.25, angle: t === "screentone" ? 45 : 0 }])}>
            {FX_LABEL[t]}
          </Button>
        ))}
      </div>
      {row("art", "Artwork")}
      {row(
        "background",
        "Background",
        <label className="relative flex items-center gap-1.5 text-[12px] text-ink-2" title="Background colour">
          <span className="num">{layers.background?.color ?? "#ffffff"}</span>
          <span className="size-5 rounded-[5px] border border-line-2" style={{ background: layers.background?.color ?? "#ffffff" }} />
          <input
            type="color"
            aria-label="Background colour"
            value={layers.background?.color ?? "#ffffff"}
            onChange={(e) => update({ ...layers, background: { ...(layers.background ?? {}), color: e.target.value } })}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>,
      )}
    </div>
  );
}

// ---- notes ---------------------------------------------------------------

function NotesList({ story, notes }: { story: StoryDetail; notes: (StoryDetail["state"]["notes"][number] & { i: number })[] }) {
  if (!notes.length) return <p className="text-[12.5px] text-ink-2">No open notes.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {notes.map((n) => (
        <li key={n.i} className="group flex gap-2 rounded-[var(--radius-control)] bg-wash px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <p className="selectable text-[12.5px] leading-relaxed">{n.text}</p>
            <p className="num mt-0.5 text-[11px] text-ink-2">
              {n.panel ? `${n.panel} · ` : ""}
              {n.at}
            </p>
            {n.reply && <p className="mt-1 border-l-2 border-accent pl-2 text-[12px] text-ink-2">{n.reply}</p>}
          </div>
          <IconButton label="Mark done" size="sm" onClick={() => void attempt(() => Api.noteDone(story.slug, n.i))}>
            <Check size={13} />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

function AddNote({ story, panel }: { story: StoryDetail; panel: string | null }) {
  const [text, setText] = useState("");
  const toast = useApp((s) => s.toast);
  const send = async () => {
    if (!text.trim()) return;
    const r = await attempt(() => Api.addNote(story.slug, { panel, text: text.trim() }));
    if (r !== undefined) {
      setText("");
      toast("Note saved. Your agent reads it with get_feedback.", "ok");
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void send()}
        placeholder={panel ? "Tell the agent what to change in this panel" : "A note for the agent about the whole story"}
        className="min-h-14 text-[12.5px]"
      />
      <Button size="sm" className="self-end" icon={<ArrowSquareOut size={13} />} disabled={!text.trim()} onClick={() => void send()}>
        Leave note
      </Button>
    </div>
  );
}
