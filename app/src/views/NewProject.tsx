// "New project" choices, used by the Library sheet and the last onboarding step.

import { BookOpenText, FilePlus, TextAlignLeft } from "@phosphor-icons/react";
import { useState } from "react";
import { Api, type Format } from "../lib/api";
import { attempt, useApp, type View } from "../lib/store";
import { Button, Field, Input, Segmented, Sheet, Textarea } from "../ui/kit";
import { ChoiceCard } from "./app-common";

export type ProjectKind = "sample" | "blank" | "text";
export interface ProjectDraft {
  kind: ProjectKind;
  title: string;
  mode: Format["mode"];
  direction: Format["direction"];
  text: string;
}

export const emptyDraft = (): ProjectDraft => ({ kind: "sample", title: "", mode: "page", direction: "rtl", text: "" });

export function draftError(d: ProjectDraft): string | null {
  if (d.kind === "sample") return null;
  if (!d.title.trim()) return "Give the project a title.";
  if (d.kind === "text" && d.text.trim().length < 40) return "Paste a bit more story text (a few sentences at least).";
  return null;
}

/** Create the project; returns where to go next. */
export async function createFromDraft(d: ProjectDraft): Promise<{ slug: string; view: View } | undefined> {
  if (d.kind === "sample") {
    // The sample ships with generated art in stories/cheek-squish; open it rather than an art-less copy.
    const existing = await Api.stories().catch(() => []);
    if (existing.some((s) => s.slug === "cheek-squish")) return { slug: "cheek-squish", view: "studio" };
    const r = await attempt(() => Api.createProject({ title: "Cheek Squish", mode: "page", direction: "rtl", template: "sample" }));
    return r && { slug: r.slug, view: "studio" };
  }
  if (d.kind === "blank") {
    const r = await attempt(() => Api.createProject({ title: d.title.trim(), mode: d.mode, direction: d.direction, template: "blank" }));
    return r && { slug: r.slug, view: "studio" };
  }
  const r = await attempt(() => Api.pipelineNew({ title: d.title.trim(), text: d.text, mode: d.mode, direction: d.direction }));
  return r && { slug: r.slug, view: "pipeline" };
}

function FormatFields({ d, set }: { d: ProjectDraft; set: (p: Partial<ProjectDraft>) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented
        size="sm"
        value={d.mode}
        onChange={(mode) => set({ mode })}
        options={[
          { value: "page", label: "Manga pages" },
          { value: "webtoon", label: "Webtoon scroll" },
        ]}
      />
      {d.mode === "page" && (
        <Segmented
          size="sm"
          value={d.direction}
          onChange={(direction) => set({ direction })}
          options={[
            { value: "rtl", label: "Right to left", title: "Japanese reading order" },
            { value: "ltr", label: "Left to right" },
          ]}
        />
      )}
    </div>
  );
}

export function NewProjectChoices({ draft, onChange }: { draft: ProjectDraft; onChange: (d: ProjectDraft) => void }) {
  const set = (p: Partial<ProjectDraft>) => onChange({ ...draft, ...p });
  return (
    <div role="radiogroup" className="flex flex-col gap-2.5">
      <ChoiceCard
        selected={draft.kind === "sample"}
        onSelect={() => set({ kind: "sample" })}
        icon={<BookOpenText size={17} />}
        title="Open the sample story"
        body="Cheek Squish: ten panels with a cast sheet, room plate and lettering, ready to explore."
      />
      <ChoiceCard selected={draft.kind === "blank"} onSelect={() => set({ kind: "blank" })} icon={<FilePlus size={17} />} title="Start blank" body="An empty project with a character sheet slot. You build pages panel by panel.">
        <div className="flex flex-col gap-3">
          <Field label="Title">{(id) => <Input id={id} autoFocus value={draft.title} placeholder="The Night Market" onChange={(e) => set({ title: e.target.value })} />}</Field>
          <FormatFields d={draft} set={set} />
        </div>
      </ChoiceCard>
      <ChoiceCard selected={draft.kind === "text"} onSelect={() => set({ kind: "text" })} icon={<TextAlignLeft size={17} />} title="From story text" body="Paste a chapter or script. The pipeline breaks it into pages and panels, then draws them.">
        <div className="flex flex-col gap-3">
          <Field label="Title">{(id) => <Input id={id} value={draft.title} placeholder="Chapter 1" onChange={(e) => set({ title: e.target.value })} />}</Field>
          <Field label="Story text" hint={draft.text ? `${draft.text.trim().split(/\s+/).filter(Boolean).length} words` : "Plain text or a script with dialogue in quotes."}>
            {(id) => <Textarea id={id} rows={7} value={draft.text} onChange={(e) => set({ text: e.target.value })} placeholder="Paste your story here" />}
          </Field>
          <FormatFields d={draft} set={set} />
        </div>
      </ChoiceCard>
    </div>
  );
}

export function NewProjectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState<ProjectDraft>(() => ({ ...emptyDraft(), kind: "blank" }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = useApp((s) => s.go);

  const submit = async () => {
    const e = draftError(draft);
    setErr(e);
    if (e) return;
    setBusy(true);
    const r = await createFromDraft(draft);
    setBusy(false);
    if (r) {
      onClose();
      setDraft({ ...emptyDraft(), kind: "blank" });
      go(r.view, r.slug);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New project"
      width={560}
      footer={
        <>
          {err && <p className="mr-auto self-center text-[12.5px] text-err">{err}</p>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {draft.kind === "text" ? "Create and run" : "Create"}
          </Button>
        </>
      }
    >
      <NewProjectChoices draft={draft} onChange={(d) => { setDraft(d); setErr(null); }} />
    </Sheet>
  );
}
