import { motion } from "motion/react";
import { DiceFive, Plus, Trash, UploadSimple, UserCircle, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Api, fileUrl, type CastMember, type StoryDetail } from "../../lib/api";
import { attempt, useApp } from "../../lib/store";
import { Button, Empty, Field, IconButton, Input, Sheet, Textarea, cx, spring } from "../../ui/kit";
import { Thumb, compileCast, refThumb } from "./side-common";

const base = (): CastMember => ({ name: "", role: "", face: "", hair: "", outfit: "", palette: "", notes: "", refs: [] });
const blank = (): CastMember => ({ ...base(), seed: rand() });
const rand = () => Math.floor(Math.random() * 99999) + 1;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Character & Cast Studio: structured character profiles that compile to a verbatim prompt block. */
export function CastStudio({ story, open, onClose }: { story: StoryDetail; open: boolean; onClose: () => void }) {
  const ids = Object.keys(story.cast ?? {});
  const [sel, setSel] = useState<string | null>(null); // existing id, or "__new"
  const [draft, setDraft] = useState<CastMember>(blank());
  const [newId, setNewId] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Pick the first character when opening; load its data into the draft.
  useEffect(() => {
    if (!open) return;
    if (sel === null || (sel !== "__new" && !story.cast[sel])) setSel(ids[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ids.join(",")]);
  useEffect(() => {
    setConfirmDelete(false);
    if (sel && sel !== "__new" && story.cast[sel]) setDraft({ ...base(), ...story.cast[sel] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const isNew = sel === "__new";
  const cid = isNew ? slugify(newId || draft.name) : sel;
  const saved = sel && !isNew ? story.cast[sel] : null;
  const dirty = isNew || JSON.stringify({ ...base(), ...saved }) !== JSON.stringify(draft);
  const sheetPanels = story.panels.filter((p) => p.strip === false);
  const set = <K extends keyof CastMember>(k: K, v: CastMember[K]) => setDraft((d) => ({ ...d, [k]: v }));

  async function save() {
    if (!cid) return;
    if (isNew && story.cast[cid]) {
      useApp.getState().toast(`A character with id "${cid}" already exists`, "error");
      return;
    }
    setSaving(true);
    const ok = await attempt(() => Api.putCast(story.slug, cid, { ...draft, name: draft.name.trim() || cid }), `Saved ${draft.name || cid}`);
    setSaving(false);
    if (ok !== undefined) setSel(cid);
  }

  async function remove() {
    if (!sel || isNew) return;
    const ok = await attempt(() => Api.deleteCast(story.slug, sel), `Removed ${story.cast[sel]?.name || sel}`);
    if (ok !== undefined) setSel(ids.filter((i) => i !== sel)[0] ?? null);
  }

  async function upload(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      const r = await attempt(() => Api.uploadRef(story.slug, f));
      if (r) setDraft((d) => ({ ...d, refs: [...(d.refs ?? []).filter((x) => x !== r.name), r.name] }));
    }
  }

  async function createSheet() {
    if (!cid || isNew) return;
    const r = await attempt(() => Api.addPanel(story.slug, { id: `sheet-${cid}`, title: `${draft.name || cid} sheet` }));
    if (!r) return;
    const uses = ["style", cid].filter((u, i, a) => a.indexOf(u) === i && (u === cid || u in story.blocks));
    await attempt(() =>
      Api.patchPanel(story.slug, r.id, {
        strip: false,
        cast: [cid],
        use: uses,
        refs: (draft.refs ?? []).slice(0, 3),
        ref_label: `character reference sheet of ${draft.name || cid}`,
        width: 1248,
        height: 832,
        action: `Character turnaround sheet on a plain white background: ${draft.name || cid}, full body, front view, side view and back view, plus a close-up of the face, relaxed neutral expression, evenly lit, nothing else in frame.`,
      }),
    );
    const next = { ...draft, sheet: r.id };
    setDraft(next);
    await attempt(() => Api.putCast(story.slug, cid, next), `Created ${r.id}. Generate it from the Studio.`);
  }

  const preview = useMemo(() => compileCast({ ...draft, name: draft.name || cid || "" }), [draft, cid]);
  const overridden = !!cid && !isNew && cid in (story.blocks ?? {});

  return (
    <Sheet open={open} onClose={onClose} title="Cast" width={920}>
      <div className="flex min-h-[520px] gap-5">
        {/* list */}
        <div className="flex w-52 shrink-0 flex-col gap-1">
          {ids.map((id) => {
            const c = story.cast[id];
            const thumb = c.sheet ? refThumb(story, c.sheet) : c.refs?.[0] ? refThumb(story, c.refs[0]) : null;
            const on = sel === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSel(id)}
                className={cx("relative flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-left", on ? "" : "hover:bg-wash")}
              >
                {on && <motion.span layoutId="cast-sel" transition={spring} className="absolute inset-0 rounded-[var(--radius-control)] bg-wash" />}
                <Thumb src={thumb} alt={c.name} className="relative size-8 shrink-0 rounded-full" />
                <span className="relative min-w-0">
                  <span className="block truncate text-[13px] font-medium">{c.name || id}</span>
                  <span className="block truncate text-[12px] text-ink-2">{c.role || id}</span>
                </span>
              </button>
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus size={13} />}
            className="mt-1 justify-start"
            onClick={() => {
              setSel("__new");
              setDraft(blank());
              setNewId("");
            }}
          >
            Add character
          </Button>
        </div>

        {/* editor */}
        <div className="min-w-0 flex-1 border-l border-line pl-5">
          {sel === null ? (
            <Empty
              icon={<UserCircle size={22} />}
              title="No characters yet"
              body="Describe each character once. Every panel that includes them gets the same words and reference sheet."
              action={
                <Button
                  variant="primary"
                  icon={<Plus size={14} />}
                  onClick={() => {
                    setSel("__new");
                    setDraft(blank());
                  }}
                >
                  Add character
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name">{(id) => <Input id={id} value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Kai" />}</Field>
                <Field label="Role">{(id) => <Input id={id} value={draft.role ?? ""} onChange={(e) => set("role", e.target.value)} placeholder="the father" />}</Field>
              </div>
              {isNew && (
                <Field label="Id" hint="Used in panels and as the block name. Lowercase, no spaces.">
                  {(id) => <Input id={id} className="num" value={newId || slugify(draft.name)} onChange={(e) => setNewId(slugify(e.target.value))} placeholder="kai" />}
                </Field>
              )}
              <Field label="Face design">{(id) => <Textarea id={id} className="min-h-14" value={draft.face ?? ""} onChange={(e) => set("face", e.target.value)} placeholder="young man, pale lilac-grey eyes, small black stud earring" />}</Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Hair">{(id) => <Textarea id={id} className="min-h-14" value={draft.hair ?? ""} onChange={(e) => set("hair", e.target.value)} placeholder="messy layered silver-white hair" />}</Field>
                <Field label="Outfit" hint="Name it every time. Clothes drift first.">
                  {(id) => <Textarea id={id} className="min-h-14" value={draft.outfit ?? ""} onChange={(e) => set("outfit", e.target.value)} placeholder="oversized plain black crewneck sweater" />}
                </Field>
              </div>
              <Field label="Palette" hint={<>Use exact color words like “pastel periwinkle-blue”, never just “blue”.</>}>
                {(id) => <Input id={id} value={draft.palette ?? ""} onChange={(e) => set("palette", e.target.value)} placeholder="black, silver-white, lilac-grey" />}
              </Field>
              <Field label="Notes" hint="For you and the agent. Not sent to the model.">
                {(id) => <Textarea id={id} className="min-h-12" value={draft.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />}
              </Field>

              {/* reference gallery */}
              <div className="flex flex-col gap-2">
                <p className="type-label">Reference images</p>
                <div
                  className="flex flex-wrap gap-2"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void upload(e.dataTransfer.files);
                  }}
                >
                  {(draft.refs ?? []).map((r) => (
                    <div key={r} className="group relative">
                      <Thumb src={fileUrl(story.slug, `refs/${r}`)} alt={r} className="h-20 w-16" />
                      <button
                        type="button"
                        aria-label={`Remove ${r}`}
                        onClick={() => set("refs", (draft.refs ?? []).filter((x) => x !== r))}
                        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-paper opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus:opacity-100"
                      >
                        <X size={10} weight="bold" />
                      </button>
                    </div>
                  ))}
                  <label className="pressable flex h-20 w-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-[6px] border border-dashed border-line-2 text-[11px] text-ink-2 hover:bg-wash">
                    <UploadSimple size={15} />
                    Upload
                    <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />
                  </label>
                </div>
                {story.refs.filter((r) => !(draft.refs ?? []).includes(r)).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] text-ink-2">From this project:</span>
                    {story.refs
                      .filter((r) => !(draft.refs ?? []).includes(r))
                      .map((r) => (
                        <button key={r} type="button" onClick={() => set("refs", [...(draft.refs ?? []), r])} className="pressable flex items-center gap-1.5 rounded-full border border-line bg-paper py-0.5 pr-2 pl-0.5 text-[11.5px] hover:border-line-2" title={r}>
                          <Thumb src={fileUrl(story.slug, `refs/${r}`)} alt="" className="size-5 rounded-full" />
                          <span className="max-w-[120px] truncate">{r}</span>
                        </button>
                      ))}
                  </div>
                )}
                <p className="text-[12px] text-ink-2">Drop images here. They are saved to the project's refs folder.</p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Reference sheet" hint="Panels include this sheet as an image ref.">
                  {(id) => (
                    <div className="flex gap-1.5">
                      <select
                        id={id}
                        value={draft.sheet ?? ""}
                        onChange={(e) => set("sheet", e.target.value || undefined)}
                        className="h-8 min-w-0 flex-1 rounded-[var(--radius-control)] border border-line-2 bg-paper px-2 text-[13px] outline-none focus:border-ink"
                      >
                        <option value="">None</option>
                        {sheetPanels.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title ? `${p.title} (${p.id})` : p.id}
                          </option>
                        ))}
                      </select>
                      {!draft.sheet && !isNew && (
                        <Button size="md" onClick={() => void createSheet()} title="Add a reference sheet panel for this character">
                          Create
                        </Button>
                      )}
                    </div>
                  )}
                </Field>
                <Field label="Identity seed" hint="Copilot uses it when no seed is given.">
                  {(id) => (
                    <div className="flex gap-1.5">
                      <Input id={id} className="num" type="number" value={draft.seed ?? ""} onChange={(e) => set("seed", e.target.value ? Number(e.target.value) : undefined)} />
                      <IconButton label="Random seed" onClick={() => set("seed", rand())}>
                        <DiceFive size={16} />
                      </IconButton>
                    </div>
                  )}
                </Field>
              </div>

              <div className="flex flex-col gap-1.5">
                <p className="type-label">Prompt block {overridden && <span className="text-warn">(story.yaml has a hand-written “{cid}” block, which wins)</span>}</p>
                <p className="selectable num rounded-[var(--radius-control)] bg-wash px-3 py-2 text-[12px] leading-relaxed text-ink">{preview}</p>
              </div>

              <div className="flex items-center gap-2 border-t border-line pt-3">
                {!isNew &&
                  (confirmDelete ? (
                    <>
                      <span className="text-[12.5px] text-ink-2">Remove {draft.name || sel}? Panels keep their text.</span>
                      <Button size="sm" variant="danger" onClick={() => void remove()}>
                        Remove
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" icon={<Trash size={13} />} onClick={() => setConfirmDelete(true)}>
                      Remove
                    </Button>
                  ))}
                <div className="ml-auto flex gap-2">
                  {dirty && !isNew && saved && (
                    <Button size="md" variant="ghost" onClick={() => setDraft({ ...base(), ...saved })}>
                      Revert
                    </Button>
                  )}
                  <Button variant="primary" loading={saving} disabled={!cid || !dirty} onClick={() => void save()}>
                    {isNew ? "Add character" : "Save"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
