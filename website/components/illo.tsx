import { existsSync } from "node:fs";
import { join } from "node:path";

// The five onboarding illustrations from the app (480 x 360, transparent). They live in public/art/<name>.svg.
// Checked at build time: a missing file renders nothing, and the section's layout still reads without it.
export type IlloName = "welcome" | "mac" | "model" | "ai" | "project";

export function hasIllo(name: IlloName) {
  return existsSync(join(process.cwd(), "public", "art", `${name}.svg`));
}

export function Illo({ name, className = "" }: { name: IlloName; className?: string }) {
  if (!hasIllo(name)) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/art/${name}.svg`} alt="" aria-hidden="true" width={480} height={360} loading="lazy" decoding="async" className={`illo block h-auto w-full ${className}`} />
  );
}
