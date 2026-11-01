// Left rail: format switches, page thumbnails (page mode), and the panel list. Panels drag onto page
// slots (HTML5 DnD, type application/x-panel) and onto each other to reorder.

import { useState } from "react";
import { DotsSixVertical, Plus, Trash, UploadSimple } from "@phosphor-icons/react";
import { Api, api, type Page, type Panel, type StoryDetail, versionUrl } from "../../lib/api";
import { applyTemplate, pageDims, stripPanels } from "../../lib/layout";
import { attempt, useApp } from "../../lib/store";
import { PanelView } from "../../ui/PanelView";
import { Badge, Button, IconButton, Segmented, cx } from "../../ui/kit";
import { ART_ACCEPT } from "./importArt";
import { startScan } from "./ScanReview";
import { STAGE_META, stageCounts } from "../../lib/stages";

const THUMB_LAYERS = { background: true, art: true, fx: false, lettering: false };

export function Rail({
  story,
  pages,
  previewLayout,
  onPagesChange,
  onReveal,
}: {
  story: StoryDetail;
  pages: Page[];
  previewLayout: boolean;
  onPagesChange: (p: Page[]) => void;
  onReveal: (pid: string) => void;
}) {
  const mode = story.format?.mode ?? "page";
  const dir = story.format?.direction ?? "rtl";
  const { page: pageIdx, setPage, panel: selected, selectPanel } = useApp();

  const setFormat = (patch: Partial<StoryDetail["format"]>) => attempt(() => Api.patchStory(story.slug, { format: { ...story.format, ...patch } }));

  const placed = new Set(pages.flatMap((p) => p.panels.map((s) => s.panel)));
  const unplaced = stripPanels(story)
    .map((p) => p.id)
    .filter((id) => !placed.has(id));

  const choose = (pid: string) => {
    selectPanel(pid);
    if (mode === "page") {
      const i = pages.findIndex((pg) => pg.panels.some((s) => s.panel === pid));
      if (i >= 0) setPage(i);
    } else onReveal(pid);
  };

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-line bg-paper">
      <div className="flex flex-col gap-2 border-b border-line p-3">
        <Segmented
          size="sm"
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          value={mode}
          onChange={(m) => setFormat({ mode: m })}
          options={[
            { value: "page", label: "Manga pages" },
            { value: "webtoon", label: "Webtoon" },
          ]}
        />
        {mode === "page" && (
          <Segmented
            size="sm"
            className="w-full [&>button]:flex-1 [&>button]:justify-center"
            value={dir}
            onChange={(d) => setFormat({ direction: d })}
            options={[
              { value: "rtl", label: "Right to left", title: "Japanese reading order" },
              { value: "ltr", label: "Left to right" },
            ]}
          />
        )}
      </div>

      <StageProgress story={story} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === "page" && (
          <section className="flex flex-col gap-2 border-b border-line p-3">
            <div className="flex items-center justify-between">
              <h3 className="type-label">Pages</h3>
              <span className="flex-1" />
              <label className="pressable flex size-7 cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-ink-2 hover:bg-wash hover:text-ink" title="Import a scanned or drawn page: its panels are found for you">
                <UploadSimple size={14} />
                <span className="sr-only">Import a scanned page</span>
                <input
                  type="file"
                  accept={ART_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void startScan(story.slug, f);
                    e.target.value = "";
                  }}
                />
              </label>
              <IconButton
                label="Add page"
                size="sm"
                onClick={() => {
                  const id = `pg${Date.now().toString(36).slice(-4)}`;
                  const pg = applyTemplate({ id, panels: [] }, "rows3", story.format, unplaced);
                  onPagesChange([...pages, pg]);
                  setPage(pages.length);
                }}
              >
                <Plus size={14} />
              </IconButton>
            </div>
            {previewLayout && (
              <div className="flex flex-col gap-2 rounded-[var(--radius-control)] bg-accent-wash p-2.5">
                <p className="text-[12px] text-accent-ink">This layout is a preview. Save it to edit pages.</p>
                {/* Save the preview shown, not a fresh server layout: what you see is what you get. */}
                <Button size="sm" variant="primary" onClick={() => attempt(() => Api.putPages(story.slug, pages), "Pages saved")}>
                  Save layout
                </Button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2.5">
              {pages.map((pg, i) => (
                <PageThumb
                  key={pg.id + i}
                  story={story}
                  page={pg}
                  n={i + 1}
                  active={i === pageIdx}
                  onClick={() => setPage(i)}
                  onDelete={
                    pages.length > 1
                      ? () => {
                          onPagesChange(pages.filter((_, j) => j !== i));
                          setPage(Math.max(0, Math.min(pageIdx, pages.length - 2)));
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-1 p-3">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="type-label">Panels</h3>
            <IconButton
              label="Add panel"
              size="sm"
              onClick={async () => {
                const r = await attempt(() => Api.addPanel(story.slug, { after: selected ?? undefined, page: mode === "page" ? pages[pageIdx]?.id : undefined }));
                if (r) selectPanel(r.id);
              }}
            >
              <Plus size={14} />
            </IconButton>
          </div>
          <PanelList story={story} selected={selected} unplaced={mode === "page" ? new Set(unplaced) : new Set()} onChoose={choose} />
        </section>
      </div>
    </aside>
  );
}

function PageThumb({ story, page, n, active, onClick, onDelete }: { story: StoryDetail; page: Page; n: number; active: boolean; onClick: () => void; onDelete?: () => void }) {
  const { page: pd, live } = pageDims(story.format);
  const byId = new Map(story.panels.map((p) => [p.id, p]));
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="group relative flex flex-col items-center gap-1">
      <button
        onClick={onClick}
        className={cx(
          "pressable relative w-full overflow-hidden rounded-[4px] bg-white shadow-[0_0_0_1px_var(--color-line)]",
          active && "shadow-[0_0_0_2px_var(--color-accent)]",
        )}
        style={{ aspectRatio: `${pd.width} / ${pd.height}` }}
        aria-label={`Page ${n}`}
      >
        <div className="absolute" style={{ left: `${(live.x / pd.width) * 100}%`, top: `${(live.y / pd.height) * 100}%`, width: `${(live.w / pd.width) * 100}%`, height: `${(live.h / pd.height) * 100}%` }}>
          {page.panels.map((s, i) => {
            const p = s.panel ? byId.get(s.panel) : undefined;
            const [x, y, w, h] = s.box;
            return (
              <div key={i} className="absolute" style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}>
                {p?.pick ? (
                  <PanelView slug={story.slug} panel={p} story={story} slotAspect={(w * live.w) / (h * live.h)} poly={s.poly} layers={THUMB_LAYERS} className="size-full" />
                ) : (
                  <div className="size-full bg-wash" />
                )}
              </div>
            );
          })}
        </div>
      </button>
      <span className={cx("num text-[11px]", active ? "font-semibold text-ink" : "text-ink-2")}>{n}</span>
      {onDelete && (
        <button
          className={cx(
            "pressable absolute top-1 right-1 flex h-6 items-center gap-1 rounded-full bg-paper px-1.5 text-[11px] font-medium shadow-[var(--shadow-float)] transition-opacity duration-150",
            confirm ? "text-err opacity-100" : "text-ink-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
          onClick={() => (confirm ? onDelete() : (setConfirm(true), window.setTimeout(() => setConfirm(false), 2500)))}
          aria-label={`Delete page ${n}`}
        >
          <Trash size={12} />
          {confirm && "Delete"}
        </button>
      )}
    </div>
  );
}

function PanelList({ story, selected, unplaced, onChoose }: { story: StoryDetail; selected: string | null; unplaced: Set<string>; onChoose: (pid: string) => void }) {
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const reorder = async (pid: string, before: string) => {
    if (pid === before) return;
    const ids = story.panels.map((p) => p.id).filter((id) => id !== pid);
    ids.splice(ids.indexOf(before), 0, pid);
    await attempt(() => api(`/api/stories/${encodeURIComponent(story.slug)}/panels/order`, { method: "PUT", body: { order: ids } }));
  };

  return (
    <ul className="flex flex-col">
      {story.panels.map((p) => (
        <li
          key={p.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/x-panel", p.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("application/x-panel")) {
              e.preventDefault();
              setDragOver(p.id);
            }
          }}
          onDragLeave={() => setDragOver((d) => (d === p.id ? null : d))}
          onDrop={(e) => {
            setDragOver(null);
            const pid = e.dataTransfer.getData("application/x-panel");
            if (pid) void reorder(pid, p.id);
          }}
          className={cx("group relative", dragOver === p.id && "before:absolute before:inset-x-1 before:-top-px before:h-[2px] before:rounded-full before:bg-accent")}
        >
          <div
            role="button"
            tabIndex={0}
            onClick={() => onChoose(p.id)}
            onKeyDown={(e) => e.key === "Enter" && onChoose(p.id)}
            className={cx(
              "flex w-full cursor-default items-center gap-2.5 rounded-[var(--radius-control)] px-1.5 py-1.5 text-left transition-colors duration-150",
              selected === p.id ? "bg-wash" : "hover:bg-wash/70",
            )}
          >
            <DotsSixVertical size={14} className="shrink-0 cursor-grab text-ink-3 opacity-0 group-hover:opacity-100" />
            <PanelThumb story={story} panel={p} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="num text-[11.5px] text-ink-2">{p.id}</span>
              <span className="truncate text-[12.5px] font-medium">{p.title || "Untitled"}</span>
            </span>
            {p.strip === false ? (
              <Badge>Ref</Badge>
            ) : unplaced.has(p.id) ? (
              <Badge tone="warn">Unplaced</Badge>
            ) : p.stage ? (
              <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold" style={{ background: STAGE_META[p.stage].bg, color: STAGE_META[p.stage].fg }} title={STAGE_META[p.stage].hint}>
                {STAGE_META[p.stage].label}
              </span>
            ) : !p.pick && !Object.keys(p.drawing_files ?? {}).length ? (
              <Badge>Empty</Badge>
            ) : null}
            <button
              className={cx(
                "pressable flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium transition-opacity duration-150",
                confirm === p.id ? "bg-[#fdeeee] text-err opacity-100" : "text-ink-3 opacity-0 hover:text-err group-hover:opacity-100 focus-visible:opacity-100",
              )}
              aria-label={`Delete ${p.id}`}
              onClick={async (e) => {
                e.stopPropagation();
                if (confirm !== p.id) {
                  setConfirm(p.id);
                  window.setTimeout(() => setConfirm((c) => (c === p.id ? null : c)), 2500);
                  return;
                }
                setConfirm(null);
                await attempt(() => Api.deletePanel(story.slug, p.id), `Deleted ${p.id}`);
              }}
            >
              <Trash size={12} />
              {confirm === p.id && "Delete"}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PanelThumb({ story, panel }: { story: StoryDetail; panel: Panel }) {
  return (
    <span className="relative h-10 w-[30px] shrink-0 overflow-hidden rounded-[3px] bg-wash shadow-[0_0_0_0.5px_rgb(23_23_26/0.12)]">
      {panel.pick && <img src={versionUrl(story.slug, panel.id, panel.pick)} alt="" draggable={false} loading="lazy" className="size-full object-cover" />}
    </span>
  );
}

/** How far the chapter is, by production stage: one bar, one segment per stage in order. */
function StageProgress({ story }: { story: StoryDetail }) {
  const { counts, unset, total } = stageCounts(story.panels);
  if (!total) return null;
  const done = counts.find((c) => c.stage === "letters")!.n;
  return (
    <div className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium">Progress</span>
        <span className="num text-[11px] text-ink-2">
          {done}/{total} lettered
        </span>
      </div>
      <div className="flex h-2 gap-px overflow-hidden rounded-full bg-wash" role="img" aria-label={counts.map((c) => `${STAGE_META[c.stage].label} ${c.n}`).join(", ") + `, no stage ${unset}`}>
        {counts.map((c) => (c.n ? <span key={c.stage} title={`${STAGE_META[c.stage].label}: ${c.n}`} style={{ flex: c.n, background: STAGE_META[c.stage].bg }} /> : null))}
        {unset ? <span title={`No stage: ${unset}`} style={{ flex: unset }} className="bg-[repeating-linear-gradient(45deg,#d6d6d2_0_3px,#efefec_3px_6px)]" /> : null}
      </div>
    </div>
  );
}
