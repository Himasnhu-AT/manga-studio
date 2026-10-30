// Export: PNG pages, layered SVG, print-ready PDF. Files land in stories/<slug>/final/export/.

import { FileImage, FilePdf, FileSvg, ArrowSquareOut } from "@phosphor-icons/react";
import { useState } from "react";
import { Api, fileUrl } from "../lib/api";
import { attempt } from "../lib/store";
import { Button, Field, Input, Segmented, Sheet, cx } from "../ui/kit";
import { inTauri } from "./app-common";

type Fmt = "png" | "svg" | "pdf";
type Preset = "digital" | "print-b5" | "print-a5";

const FORMATS: { id: Fmt; label: string; body: string; icon: React.ReactNode }[] = [
  { id: "png", label: "PNG pages", body: "One image per page with lettering.", icon: <FileImage size={18} /> },
  { id: "svg", label: "Layered SVG", body: "Artwork plus editable vector bubbles.", icon: <FileSvg size={18} /> },
  { id: "pdf", label: "Print PDF", body: "All pages, sized for the preset.", icon: <FilePdf size={18} /> },
];

/** Path relative to stories/<slug>/ for a file the server returned (relative or absolute). */
function relPath(slug: string, f: string) {
  const marker = `/stories/${slug}/`;
  const i = f.indexOf(marker);
  return i >= 0 ? f.slice(i + marker.length) : f.replace(/^\/+/, "");
}

async function openInOs(url: string) {
  try {
    const op = await import("@tauri-apps/plugin-opener");
    await op.openUrl(new URL(url, location.href).href);
    return true;
  } catch {
    return false;
  }
}

export function ExportSheet({ slug, open, onClose }: { slug: string; open: boolean; onClose: () => void }) {
  const [formats, setFormats] = useState<Fmt[]>(["png", "pdf"]);
  const [preset, setPreset] = useState<Preset>("digital");
  const [bleed, setBleed] = useState("3");
  const [margin, setMargin] = useState("10");
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const print = preset !== "digital";

  const toggle = (f: Fmt) => setFormats((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  const run = async () => {
    setBusy(true);
    const r = await attempt(
      () =>
        Api.exportStory(slug, {
          formats,
          preset,
          ...(print ? { bleed_mm: Number(bleed) || 0, margin_mm: Number(margin) || 0 } : {}),
        }),
      "Export finished",
    );
    setBusy(false);
    if (r) setFiles(r.files);
  };

  const close = () => {
    onClose();
    window.setTimeout(() => setFiles(null), 300);
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Export"
      width={520}
      footer={
        files ? (
          <>
            <Button variant="ghost" onClick={() => setFiles(null)}>
              Export again
            </Button>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={formats.length === 0} onClick={run}>
              Export
            </Button>
          </>
        )
      }
    >
      {files ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-ink-2">{files.length === 1 ? "1 file" : `${files.length} files`} in final/export/.</p>
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {files.map((f) => {
              const rel = relPath(slug, f);
              const name = rel.split("/").pop();
              return (
                <li key={f} className="flex items-center justify-between gap-3 py-2">
                  <span className="num truncate text-[12.5px]">{name}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {inTauri() ? (
                      <Button size="sm" variant="ghost" icon={<ArrowSquareOut size={13} />} onClick={() => void openInOs(fileUrl(slug, rel, Date.now()))}>
                        Open
                      </Button>
                    ) : (
                      <a href={fileUrl(slug, rel, Date.now())} target="_blank" rel="noreferrer" className="pressable inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-wash hover:text-ink">
                        <ArrowSquareOut size={13} /> Open
                      </a>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <span className="type-label">Formats</span>
            <div className="grid grid-cols-3 gap-2">
              {FORMATS.map((f) => {
                const on = formats.includes(f.id);
                return (
                  <button
                    key={f.id}
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(f.id)}
                    className={cx(
                      "pressable flex flex-col gap-1.5 rounded-[var(--radius-surface)] border px-3 py-3 text-left",
                      on ? "border-ink bg-paper shadow-[0_0_0_3px_rgb(23_23_26/0.06)]" : "border-line-2 bg-paper text-ink-2 hover:border-ink-3",
                    )}
                  >
                    <span className={on ? "text-ink" : "text-ink-3"}>{f.icon}</span>
                    <span className="text-[13px] font-semibold text-ink">{f.label}</span>
                    <span className="text-[11.5px] leading-snug text-ink-2">{f.body}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <Field label="Preset" hint={print ? "Pages are sized to the trim with bleed added on every side." : "Screen resolution, no bleed."}>
            {() => (
              <Segmented
                className="self-start"
                value={preset}
                onChange={setPreset}
                options={[
                  { value: "digital", label: "Digital" },
                  { value: "print-b5", label: "Print B5" },
                  { value: "print-a5", label: "Print A5" },
                ]}
              />
            )}
          </Field>
          <div className={cx("grid grid-cols-2 gap-3 transition-opacity duration-150", !print && "opacity-50")}>
            <Field label="Bleed (mm)">{(id) => <Input id={id} type="number" min={0} step={0.5} disabled={!print} value={bleed} onChange={(e) => setBleed(e.target.value)} />}</Field>
            <Field label="Margin (mm)">{(id) => <Input id={id} type="number" min={0} step={1} disabled={!print} value={margin} onChange={(e) => setMargin(e.target.value)} />}</Field>
          </div>
        </div>
      )}
    </Sheet>
  );
}
