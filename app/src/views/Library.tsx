// Project library: every story under stories/, newest work first.

import { BookOpenText, ImageSquare, Plus, PlugsConnected } from "@phosphor-icons/react";
import { useState } from "react";
import { Api, fileUrl, type StorySummary } from "../lib/api";
import { useConnected, useLive } from "../lib/live";
import { useApp } from "../lib/store";
import { Badge, Button, Empty } from "../ui/kit";
import { NewProjectSheet } from "./NewProject";

export function Library() {
  const stories = useLive(() => Api.stories(), []);
  const connected = useConnected();
  const [open, setOpen] = useState(false);
  const list = [...(stories.data ?? [])].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));

  return (
    <div className="mx-auto w-full max-w-[1200px] px-8 pt-10 pb-16">
      <div className="mb-8 flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="type-display">Projects</h1>
          <p className="text-[13.5px] text-ink-2">Stories on this Mac, in stories/.</p>
        </div>
        <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setOpen(true)}>
          New project
        </Button>
      </div>

      {stories.loading && !stories.error ? (
        <Grid>
          {[0, 1, 2, 3].map((n) => (
            <div key={n} className="flex flex-col gap-3">
              <div className="skeleton aspect-[3/4] rounded-[var(--radius-surface)]" />
              <div className="skeleton h-4 w-2/3" />
              <div className="skeleton h-3 w-1/3" />
            </div>
          ))}
        </Grid>
      ) : stories.error && !stories.data ? (
        <Empty
          icon={<PlugsConnected size={20} />}
          title="Can't reach the studio backend"
          body={
            <>
              Start it with <code className="num">uv run studio serve</code> in the project folder. This page reconnects on its own.
            </>
          }
          action={!connected ? undefined : <Button onClick={() => void stories.reload()}>Try again</Button>}
        />
      ) : list.length === 0 ? (
        <Empty
          icon={<BookOpenText size={20} />}
          title="No projects yet"
          body="Start from the sample story, a blank project, or paste a chapter and let the pipeline storyboard it."
          action={
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setOpen(true)}>
              New project
            </Button>
          }
        />
      ) : (
        <Grid>
          {list.map((s) => (
            <ProjectCard key={s.slug} s={s} />
          ))}
        </Grid>
      )}

      <NewProjectSheet open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-9 md:grid-cols-3 lg:grid-cols-4">{children}</div>;
}

function ProjectCard({ s }: { s: StorySummary }) {
  const go = useApp((st) => st.go);
  const [broken, setBroken] = useState(false);
  const cover = s.cover && !broken ? fileUrl(s.slug, s.cover, s.updated) : null;
  return (
    <button onClick={() => go("studio", s.slug)} className="group flex flex-col gap-3 text-left outline-none">
      <div className="relative aspect-[3/4] overflow-hidden rounded-[var(--radius-surface)] border border-line bg-wash shadow-[var(--shadow-page)] transition-[transform,box-shadow] duration-200 ease-[var(--ease-out)] group-focus-visible:ring-2 group-focus-visible:ring-accent group-active:scale-[0.98] group-hover:-translate-y-1">
        {cover ? (
          <img src={cover} alt="" loading="lazy" onError={() => setBroken(true)} className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-ink-3">
            <ImageSquare size={28} />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 px-0.5">
        <span className="truncate text-[14px] font-semibold tracking-[-0.01em]">{s.title}</span>
        <span className="flex items-center gap-2 text-[12.5px] text-ink-2">
          {s.error ? (
            <Badge tone="err">story.yaml has an error</Badge>
          ) : (
            <>
              <span className="num">{s.panels} panels</span>
              {s.mode && <Badge>{s.mode === "webtoon" ? "Webtoon" : "Pages"}</Badge>}
            </>
          )}
        </span>
      </div>
    </button>
  );
}
