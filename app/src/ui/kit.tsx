// Shared primitives. One radius scale (8px controls, 14px surfaces), one accent, Phosphor icons.
// Motion: press feedback on pointer-down (.pressable), sheets/popovers use critically damped springs
// (bounce 0) via motion/react, and everything collapses to opacity under reduced motion.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";
import {
  Component,
  forwardRef,
  useEffect,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { useApp } from "../lib/store";

/**
 * Render overlays at the document root. A transformed ancestor (e.g. a panel that slid in with
 * `transform`) becomes the containing block for `position: fixed`, which would trap a modal inside it.
 */
export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Apple-style default spring: critically damped, ~0.35s response. */
export const spring = { type: "spring", bounce: 0, duration: 0.35 } as const;
/** For momentum-driven motion only (drag release, flick). */
export const springBouncy = { type: "spring", bounce: 0.18, duration: 0.4 } as const;

// ---- Button ---------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  trailing?: ReactNode;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary: "bg-ink text-paper hover:bg-[#2a2a2f] disabled:bg-ink-3",
  secondary: "bg-paper text-ink border border-line-2 hover:bg-wash disabled:text-ink-3",
  ghost: "text-ink-2 hover:text-ink hover:bg-wash disabled:text-ink-3",
  danger: "bg-paper text-err border border-line-2 hover:bg-[#fdeeee]",
};
const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12.5px] gap-1.5",
  md: "h-8 px-3 text-[13px] gap-2",
  lg: "h-10 px-4 text-[14px] gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, trailing, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "pressable inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] font-medium select-none disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {trailing}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: "sm" | "md" }>(
  function IconButton({ label, active, size = "md", className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        aria-label={label}
        title={label}
        aria-pressed={active}
        className={cx(
          "pressable inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] disabled:opacity-40",
          size === "sm" ? "size-7" : "size-8",
          active ? "bg-ink text-paper" : "text-ink-2 hover:bg-wash hover:text-ink",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent", className)}
    />
  );
}

// ---- Fields -------------------------------------------------------------

const inputCls =
  "w-full rounded-[var(--radius-control)] border border-line-2 bg-paper px-2.5 text-[13px] text-ink placeholder:text-ink-3 outline-none transition-[border-color,box-shadow] duration-150 focus:border-ink focus:shadow-[0_0_0_3px_rgb(23_23_26/0.08)]";

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="type-label">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-[12px] text-err">{error}</p> : hint ? <p className="text-[12px] text-ink-2">{hint}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(inputCls, "h-8", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(inputCls, "min-h-20 resize-y py-2 leading-relaxed", className)} {...rest} />;
});

// ---- Segmented control (sliding indicator, shared layout) --------------------

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  size?: "sm" | "md";
  className?: string;
}) {
  const id = useId();
  const reduce = useReducedMotion();
  return (
    <div role="radiogroup" className={cx("inline-flex rounded-[var(--radius-control)] bg-wash p-0.5", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative flex items-center gap-1.5 rounded-[6px] font-medium whitespace-nowrap transition-colors duration-150",
              size === "sm" ? "h-6 px-2 text-[12px]" : "h-7 px-2.5 text-[12.5px]",
              on ? "text-ink" : "text-ink-2 hover:text-ink",
            )}
          >
            {on && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={reduce ? { duration: 0 } : spring}
                className="absolute inset-0 rounded-[6px] bg-paper shadow-[0_1px_2px_rgb(23_23_26/0.08),0_0_0_0.5px_rgb(23_23_26/0.06)]"
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---- Sheet (modal dialog). Centered, dims the background; scale 0.97 -> 1 ------

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <div className="fixed inset-0 z-40 flex items-center justify-center p-6">
            <motion.div
              className="absolute inset-0 bg-[rgb(23_23_26/0.28)]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={onClose}
            />
            <motion.div
              role="dialog"
              aria-modal
              className="relative flex max-h-full w-full flex-col overflow-hidden rounded-[var(--radius-surface)] bg-paper shadow-[var(--shadow-sheet)]"
              style={{ maxWidth: width }}
              initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px) scale(0.97)" }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, transform: "translateY(0px) scale(1)" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px) scale(0.97)" }}
              transition={reduce ? { duration: 0.15 } : spring}
            >
              <div className="flex items-center justify-between gap-4 px-5 pt-4 pb-3">
                <h2 className="type-title">{title}</h2>
                <IconButton label="Close" size="sm" onClick={onClose}>
                  <X size={15} />
                </IconButton>
              </div>
              <div className="min-h-0 overflow-y-auto px-5 pb-5">{children}</div>
              {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </Portal>
  );
}

// ---- Toasts (bottom-center, enter and exit from the bottom) -------------------

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  const reduce = useReducedMotion();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout={!reduce}
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(12px) scale(0.98)" }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, transform: "translateY(0px) scale(1)" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(12px) scale(0.98)" }}
            transition={spring}
            className="pointer-events-auto flex max-w-[520px] items-start gap-2.5 rounded-[var(--radius-surface)] bg-ink px-3.5 py-2.5 text-[13px] text-paper shadow-[var(--shadow-float)]"
          >
            <span className="mt-0.5 shrink-0">
              {t.kind === "ok" ? <CheckCircle size={16} weight="fill" className="text-[#7fd6a6]" /> : t.kind === "error" ? <WarningCircle size={16} weight="fill" className="text-[#ff9a8a]" /> : <Info size={16} />}
            </span>
            <span className="selectable">{t.text}</span>
            <button className="ml-1 shrink-0 text-paper/60 hover:text-paper" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ---- Small display pieces --------------------------------------------------

export function Empty({ icon, title, body, action }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-wash text-ink-2">{icon}</div>
      <div className="flex flex-col gap-1">
        <p className="type-title">{title}</p>
        {body && <p className="max-w-[44ch] text-[13px] text-ink-2">{body}</p>}
      </div>
      {action}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="num inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line-2 bg-paper px-1 text-[11px] text-ink-2">{children}</kbd>;
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "ok" | "warn" | "err"; children: ReactNode }) {
  const tones = {
    neutral: "bg-wash text-ink-2",
    accent: "bg-accent-wash text-accent-ink",
    ok: "bg-[#e7f4ec] text-ok",
    warn: "bg-[#fbf1df] text-warn",
    err: "bg-[#fdeeee] text-err",
  };
  return <span className={cx("inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium", tones[tone])}>{children}</span>;
}

/** Progress without a filled background track (thin accent line). */
export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx("h-[2px] w-full overflow-hidden", className)}>
      <div className="h-full origin-left bg-accent transition-transform duration-300 ease-[var(--ease-out)]" style={{ transform: `scaleX(${Math.max(0, Math.min(1, value))})` }} />
    </div>
  );
}

export function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("flex flex-col gap-2.5", className)}>
      <div className="flex items-center justify-between">
        <h3 className="type-label">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Catches a render error below it and shows `fallback` instead of blanking the whole app. `resetKey`
 *  changing gives the children another try (e.g. the panel's data was fixed). */
export class ErrorBoundary extends Component<{ fallback: (error: Error, retry: () => void) => ReactNode; resetKey?: unknown; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("[Manga Studio] render error:", error);
  }
  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    return this.state.error ? this.props.fallback(this.state.error, () => this.setState({ error: null })) : this.props.children;
  }
}
