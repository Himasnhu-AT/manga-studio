// Bring your own drawing into a panel: a sketch, a scan, inks or finished art becomes a new version of
// the panel and is put in use. Nothing is generated.

import { UploadSimple } from "@phosphor-icons/react";
import { Api } from "../../lib/api";
import { attempt } from "../../lib/store";
import { cx } from "../../ui/kit";

export const ART_ACCEPT = "image/png,image/jpeg,image/webp,image/tiff,image/bmp,.psd,.tif,.tiff";
const ART_EXT = /\.(png|jpe?g|webp|psd|tiff?|bmp)$/i;

export const isArtFile = (f: File) => f.type.startsWith("image/") || ART_EXT.test(f.name);

/** Import the first image of `files` into panel `pid`. Returns the new version's file name. */
export async function importArt(slug: string, pid: string, files: FileList | File[]): Promise<string | undefined> {
  const file = Array.from(files).find(isArtFile);
  if (!file) return undefined;
  const r = await attempt(() => Api.importArt(slug, pid, file), `Imported ${file.name}`);
  return r?.file;
}

/** A button that opens the file picker and imports into the panel. */
export function ImportArtButton({ slug, pid, className, children, onDone }: { slug: string; pid: string; className?: string; children?: React.ReactNode; onDone?: () => void }) {
  return (
    <label className={cx("pressable cursor-pointer", className)} onPointerDown={(e) => e.stopPropagation()}>
      {children ?? (
        <>
          <UploadSimple size={14} /> Import drawing
        </>
      )}
      <input
        type="file"
        accept={ART_ACCEPT}
        className="hidden"
        onChange={async (e) => {
          const files = e.target.files;
          if (files?.length) await importArt(slug, pid, files);
          e.target.value = "";
          onDone?.();
        }}
      />
    </label>
  );
}
