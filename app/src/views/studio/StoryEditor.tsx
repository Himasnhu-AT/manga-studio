// Story editor: every line of dialogue on the page (or the whole chapter) in reading order, in one list.
// Edit text and bubble style here; new lines start unplaced and Auto-letter finds them a spot away from
// faces. Edits go straight to the panels' bubbles, so the page updates as you type.

import { Plus, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Api, type Bubble, type BubbleStyle, type Page, type Panel, type StoryDetail } from "../../lib/api";
import { useDebounced } from "../../lib/live";
import { orderSlots, stripPanels } from "../../lib/layout";
import { attempt, useApp } from "../../lib/store";
import { Button, IconButton, Segmented, Sheet, cx } from "../../ui/kit";

type Scope = "page" | "all";
const STYLES: { value: BubbleStyle; label: string }[] = [
  { value: "speech", label: "Speech" },
  { value: "shout", label: "Shout" },
  { value: "thought", label: "Thought" },
  { value: "caption", label: "Caption" },
];

export function StoryEditor({ story, pages, pageIdx, open, onClose }: { story: StoryDetail; pages: Page[]; pageIdx: number; open: boolean; onClose: () => void }) {
  const pageMode = (story.format?.mode ?? "page") === "page";
  const [scope, setScope] = useState<Scope>(pageMode ? "page" : "all");
  const dir = story.format?.direction ?? "rtl";
  const byId = useMemo(() => new Map(story.panels.map((p) => [p.id, p])), [story.panels]);

  // panels in reading order: page by page (slots in reading order), or the strip order in webtoon mode
  const groups = useMemo(() => {
    if (!pageMode) return [{ label: "Strip", panels: stripPanels(story) }];
    const list = scope === "page" ? [pageIdx] : pages.map((_, i) => i);
    return list
      .filter((i) => pages[i])
      .map((i) => ({
        label: `Page ${i + 1}`,
        panels: orderSlots(pages[i].panels, dir)
          .map((s) => byId.get(s.panel))
          .filter((p): p is Panel => !!p && p.strip !== false),
      }));
  }, [pageMode, scope, pageIdx, pages, dir, byId, story]);

  const unplaced = groups.flatMap((g) => g.panels).filter((p) => (p.bubbles ?? []).some((b) => !b.at || !b.text));
  const lines = groups.reduce((n, g) => n + g.panels.reduce((m, p) => m + (p.bubbles?.length ?? 0), 0), 0);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Story editor"
      width={720}
      footer={
        <div className="flex items-center gap-3">
          <span className="text-[12.5px] text-ink-2">
            {lines} line{lines === 1 ? "" : "s"}
            {unplaced.length ? ` · new lines in ${unplaced.length} panel${unplaced.length === 1 ? "" : "s"} need a spot` : ""}
          </span>
          <Button
            className="ml-auto"
            disabled={!unplaced.length}
            onClick={async () => {
              const r = await attempt(() => Api.letter(story.slug, unplaced.map((p) => p.id)));
              if (r) useApp.getState().toast(`Placed ${Object.values(r.placed).reduce((a, b) => a + b, 0)} lines away from faces`, "ok");
            }}
          >
            Place new lines
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {pageMode && (
          <Segmented<Scope>
            size="sm"
            value={scope}
            onChange={setScope}
            className="self-start"
            options={[
              { value: "page", label: `Page ${pageIdx + 1}` },
              { value: "all", label: "Whole chapter" },
            ]}
          />
        )}
        {groups.map((g) => (
          <section key={g.label} className="flex flex-col gap-1">
            {groups.length > 1 && <h3 className="type-label pt-1">{g.label}</h3>}
            {g.panels.length === 0 && <p className="text-[12.5px] text-ink-2">No panels on this page.</p>}
            {g.panels.map((p) => (
              <PanelLines key={p.id} slug={story.slug} panel={p} />
            ))}
          </section>
        ))}
      </div>
    </Sheet>
  );
}

function PanelLines({ slug, panel }: { slug: string; panel: Panel }) {
  const [local, setLocal] = useState<Bubble[]>(panel.bubbles ?? []);
  const server = JSON.stringify(panel.bubbles ?? []);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setLocal(panel.bubbles ?? []);
  }, [server]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useDebounced(async (next: Bubble[]) => {
    await attempt(() => Api.patchPanel(slug, panel.id, { bubbles: next }));
    setDirty(false);
  }, 450);
  const change = (next: Bubble[]) => {
    setLocal(next);
    setDirty(true);
    save(next);
  };

  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 border-b border-line py-2">
      <div className="flex flex-col gap-0.5 pt-1.5">
        <span className="num text-[11.5px] font-medium">{panel.id}</span>
        <span className="truncate text-[11px] text-ink-2" title={panel.title}>
          {panel.title}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {local.map((b, i) => (
          <div key={b.id ?? i} className="flex items-start gap-2">
            <select
              aria-label="Bubble style"
              value={b.style ?? "speech"}
              onChange={(e) => change(local.map((x, j) => (j === i ? { ...x, style: e.target.value as BubbleStyle } : x)))}
              className="h-8 rounded-[var(--radius-control)] border border-line-2 bg-paper px-1.5 text-[12px]"
            >
              {STYLES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <textarea
              aria-label={`Line ${i + 1} of ${panel.id}`}
              value={b.text}
              rows={Math.min(4, Math.max(1, Math.ceil((b.text.length || 1) / 52)))}
              onChange={(e) => change(local.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              placeholder="What they say"
              className="font-letter min-w-0 flex-1 resize-none rounded-[var(--radius-control)] border border-line-2 bg-paper px-2 py-1.5 text-[14px] leading-snug font-bold"
            />
            <span className={cx("w-[72px] pt-2 text-[11px] font-medium", b.at ? "text-ink-3" : "text-warn")}>{b.at ? "On the page" : "Not placed"}</span>
            <IconButton label="Delete line" size="sm" onClick={() => change(local.filter((_, j) => j !== i))}>
              <Trash size={13} />
            </IconButton>
          </div>
        ))}
        <button
          type="button"
          className="flex items-center gap-1 self-start text-[12px] text-ink-2 hover:text-ink"
          onClick={() => change([...local, { id: `b${Date.now().toString(36).slice(-5)}`, text: "", w: 0.36, style: "speech" } as unknown as Bubble])}
        >
          <Plus size={12} /> Add line
        </button>
      </div>
    </div>
  );
}
