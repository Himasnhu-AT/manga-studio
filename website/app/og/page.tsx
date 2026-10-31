import type { Metadata } from "next";
import { PressFigure } from "@/art/press/figure";

// A 1200 x 630 card used to render public/og.png (see art/README in the report: capture #og-card at 1200 wide).
export const metadata: Metadata = { title: "Manga Studio share card", robots: { index: false, follow: false } };

export default function OgCard() {
  return (
    <div id="og-card" className="og-card grid h-[630px] w-[1200px] grid-cols-[430px_1fr] items-center gap-6 overflow-hidden bg-paper px-14">
      <div>
        <p className="flex items-center gap-2.5">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="size-8">
            <rect x="1" y="1" width="22" height="22" rx="6" fill="#d2452f" />
            <path d="M12 6.2c-3.6 0-6.3 2.1-6.3 4.8 0 1.7 1 3.1 2.6 4l-.6 2.8 3-2.2c.4.1.9.1 1.3.1 3.6 0 6.3-2.1 6.3-4.8S15.6 6.2 12 6.2Z" fill="#fcfcfb" />
          </svg>
          <span className="hand text-[28px] leading-none">Manga Studio</span>
        </p>
        <h1 className="hand mt-8 text-[60px] leading-[1.05]">
          Draw your story as manga, <span className="mark">on your Mac</span>.
        </h1>
        <p className="mt-6 text-[21px] leading-snug text-ink-2">Qwen-Image 2.1 on Apple Silicon. Nothing leaves the machine.</p>
      </div>
      <div className="og-figure">
        <PressFigure />
      </div>
    </div>
  );
}
