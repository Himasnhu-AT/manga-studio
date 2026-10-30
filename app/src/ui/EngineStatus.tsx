import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { Api } from "../lib/api";
import { useLive } from "../lib/live";
import { useApp } from "../lib/store";
import { Spinner, cx, spring } from "./kit";

/** Toolbar chip: model state + the active job queue. Click for the queue popover. */
export function EngineStatus() {
  const status = useLive(() => Api.status(), []);
  const jobs = useLive(() => Api.jobs(undefined, true), []);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const go = useApp((s) => s.go);
  const s = status.data;
  const active = jobs.data ?? [];
  const running = active.find((j) => j.status === "running");

  let label = "Offline";
  if (s) {
    if (running) label = running.steps ? `Drawing ${running.panel} ${running.step ?? 0}/${running.steps}` : `Loading model`;
    else if (s.loading) label = "Loading model";
    else if (s.engine === "mock") label = "Mock engine";
    else label = s.loaded ? "Model ready" : "Model idle";
  }
  const busy = !!running || !!s?.loading;

  return (
    <div className="relative">
      <button
        ref={ref}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "pressable flex h-7 items-center gap-2 rounded-full border px-2.5 text-[12px] font-medium",
          busy ? "border-accent/30 bg-accent-wash text-accent-ink" : "border-line-2 bg-paper text-ink-2 hover:text-ink",
        )}
      >
        {busy ? <Spinner className="size-3" /> : <span className={cx("size-1.5 rounded-full", s?.loaded || s?.engine === "mock" ? "bg-ok" : "bg-ink-3")} />}
        <span className="num">{label}</span>
        {active.length > 1 && <span className="num text-ink-3">+{active.length - 1}</span>}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute top-9 right-0 z-30 w-72 rounded-[var(--radius-surface)] border border-line bg-paper p-2 shadow-[var(--shadow-float)]"
            style={{ transformOrigin: "top right" }}
            initial={{ opacity: 0, transform: "scale(0.96)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            exit={{ opacity: 0, transform: "scale(0.96)" }}
            transition={spring}
            onMouseLeave={() => setOpen(false)}
          >
            <p className="type-label px-2 pt-1 pb-2">Queue</p>
            {active.length === 0 ? (
              <p className="px-2 pb-2 text-[12.5px] text-ink-2">Nothing queued. {s?.model ? `${s.model} is loaded.` : ""}</p>
            ) : (
              <ul className="flex flex-col">
                {active.map((j) => (
                  <li key={j.id}>
                    <button
                      className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-[12.5px] hover:bg-wash"
                      onClick={() => {
                        go("studio", j.story);
                        useApp.getState().selectPanel(j.panel);
                        setOpen(false);
                      }}
                    >
                      <span className="truncate">
                        {j.story} / <span className="font-medium">{j.panel}</span>
                      </span>
                      <span className="num shrink-0 text-ink-2">{j.status === "running" ? `${j.step ?? 0}/${j.steps ?? "?"}` : "queued"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
