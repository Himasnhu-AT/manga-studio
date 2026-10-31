"use client";

import * as React from "react";
import { Check, Copy } from "@phosphor-icons/react/dist/ssr";

// A shell snippet with a copy button. Lines starting with "#" are comments and are not copied.
export function Command({ lines, label }: { lines: string[]; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const text = lines.filter((line) => !line.trimStart().startsWith("#")).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="group relative rounded-[14px] border border-line bg-paper">
      <pre className="overflow-x-auto px-4 py-3.5 pr-14 font-mono text-[13px] leading-[1.75] text-ink">
        <code>
          {lines.map((line, index) => (
            <span key={index} className={`block ${line.trimStart().startsWith("#") ? "text-ink-3" : ""}`}>
              {line.trimStart().startsWith("#") ? line : <><span className="select-none text-ink-3">$ </span>{line}</>}
            </span>
          ))}
        </code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? `Copied: ${label}` : `Copy: ${label}`}
        className="copy-btn absolute top-2.5 right-2.5 grid size-8 place-items-center rounded-[8px] text-ink-2 hover:bg-wash hover:text-ink"
      >
        <span className="copy-icon" data-on={copied ? undefined : ""}>
          <Copy size={16} weight="regular" />
        </span>
        <span className="copy-icon text-accent-ink" data-on={copied ? "" : undefined}>
          <Check size={16} weight="bold" />
        </span>
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to the clipboard" : ""}
      </span>
    </div>
  );
}
