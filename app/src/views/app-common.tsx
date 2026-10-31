// Small pieces shared by Onboarding, Settings, Library and Pipeline.

import { Check, Copy } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Api } from "../lib/api";
import { useConnected } from "../lib/live";
import { cx } from "../ui/kit";

export function CopyBlock({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cx("group relative rounded-[var(--radius-control)] border border-line bg-wash/60", className)}>
      <pre className="num selectable overflow-x-auto px-3 py-2.5 pr-10 text-[12px] leading-relaxed whitespace-pre-wrap break-all text-ink">{text}</pre>
      <button
        className="pressable absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-[6px] text-ink-2 hover:bg-paper hover:text-ink"
        aria-label="Copy"
        title="Copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          } catch {
            /* clipboard blocked */
          }
        }}
      >
        {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** A row in a check list: icon + label + detail. */
export function CheckRow({ tone, icon, label, detail }: { tone: "ok" | "warn" | "err" | "neutral"; icon: ReactNode; label: ReactNode; detail?: ReactNode }) {
  const tones = { ok: "text-ok", warn: "text-warn", err: "text-err", neutral: "text-ink-3" };
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className={cx("mt-0.5 shrink-0", tones[tone])}>{icon}</span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium text-ink">{label}</span>
        {detail && <span className="text-[12.5px] text-ink-2">{detail}</span>}
      </div>
    </div>
  );
}

/** Selectable card used for choices (AI agent, first project). */
export function ChoiceCard({
  selected,
  onSelect,
  icon,
  title,
  body,
  aside,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "rounded-[var(--radius-surface)] border bg-paper transition-[border-color,box-shadow] duration-150",
        selected ? "border-ink shadow-[0_0_0_3px_rgb(23_23_26/0.06)]" : "border-line-2 hover:border-ink-3",
      )}
    >
      <button role="radio" aria-checked={selected} onClick={onSelect} className="flex w-full items-start gap-3 px-4 py-3.5 text-left">
        <span className={cx("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-control)]", selected ? "bg-ink text-paper" : "bg-wash text-ink-2")}>
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink">{title}</span>
          {body && <span className="text-[12.5px] text-ink-2">{body}</span>}
        </span>
        {aside && <span className="shrink-0">{aside}</span>}
      </button>
      {selected && children && <div className="border-t border-line px-4 py-3.5">{children}</div>}
    </div>
  );
}

export const fmtBytes = (n: number) => {
  if (!n) return "0 MB";
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
};

export const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function Select({ value, onChange, options, id, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; id?: string; className?: string }) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx(
        "h-8 w-full rounded-[var(--radius-control)] border border-line-2 bg-paper px-2 text-[13px] text-ink outline-none focus:border-ink focus:shadow-[0_0_0_3px_rgb(23_23_26/0.08)]",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Fetch once (plus manual reload). For slow endpoints like /api/integrations, which shell out to
 * the claude/codex CLIs: useLive would restart them on every backend revision and never finish.
 */
export function useOnce<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const ref = useRef(fn);
  ref.current = fn;
  const reload = useCallback(async () => {
    try {
      setData(await ref.current());
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Asked before the backend was up (first launch installs packages for minutes): ask again once it is.
  const online = useConnected();
  useEffect(() => {
    if (online && error) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);
  return { data, error, reload };
}

// One shared /api/integrations request: the backend answers these one at a time (each shells out to
// the claude/codex CLIs, ~6s), so components must not each fire their own.
let integrationsP: ReturnType<typeof Api.integrations> | null = null;
let integrationsAt = 0;
export function sharedIntegrations(force = false) {
  if (force || !integrationsP || Date.now() - integrationsAt > 30_000) {
    integrationsAt = Date.now();
    integrationsP = Api.integrations();
    integrationsP.catch(() => {
      integrationsP = null;
    });
  }
  return integrationsP;
}
