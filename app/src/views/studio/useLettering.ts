import { useCallback, useEffect, useRef, useState } from "react";
import { Api, type Bubble, type Panel, type Sfx } from "../../lib/api";
import { useApp } from "../../lib/store";

interface LetterState {
  pid: string | null;
  bubbles: Bubble[];
  sfx: Sfx[];
}

const fromPanel = (p: Panel | null): LetterState => ({ pid: p?.id ?? null, bubbles: p?.bubbles ?? [], sfx: p?.sfx ?? [] });

/**
 * Optimistic lettering for the selected panel. Edits apply to local state immediately (the SVG
 * re-renders, the raster is never touched) and are saved with a 300ms debounce. Server data only
 * replaces local state when nothing is pending, so a refetch can't yank a bubble mid-drag.
 *
 * The state carries its own panel id and is swapped during render when the selection changes, so
 * an edit fired by a freshly mounted editor can never land on the previous panel's bubbles.
 */
export function useLettering(slug: string, panel: Panel | null) {
  const pid = panel?.id ?? null;
  const [st, setSt] = useState<LetterState>(() => fromPanel(panel));
  const latest = useRef(st);
  const pending = useRef<{ pid: string; bubbles: Bubble[]; sfx: Sfx[] } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const busy = useRef(false); // a drag is in progress

  // Panel switch: adopt the new panel right away (render-phase update). The previous panel's
  // pending save keeps its own pid and is flushed by the effect below.
  let cur = st;
  if (st.pid !== pid) {
    cur = fromPanel(panel);
    latest.current = cur;
    setSt(cur);
  }

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    try {
      await Api.patchPanel(slug, p.pid, { bubbles: p.bubbles, sfx: p.sfx });
    } catch (e) {
      useApp.getState().toast(`Couldn't save lettering: ${(e as Error).message}`, "error");
    }
  }, [slug]);

  useEffect(() => {
    if (pending.current && pending.current.pid !== pid) void flush();
  }, [pid, flush]);

  // Server changed (agent edit, auto-letter): adopt it when we're idle.
  const serverKey = JSON.stringify([pid, panel?.bubbles ?? [], panel?.sfx ?? []]);
  useEffect(() => {
    if (pending.current || busy.current) return;
    const next = fromPanel(panel);
    latest.current = next;
    setSt(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  useEffect(() => () => void flush(), [flush]);

  const schedule = useCallback(
    (s: LetterState) => {
      if (!s.pid) return;
      pending.current = { pid: s.pid, bubbles: s.bubbles, sfx: s.sfx };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 300);
    },
    [flush],
  );

  const updateBubbles = useCallback(
    (fn: (b: Bubble[]) => Bubble[]) => {
      const next = { ...latest.current, bubbles: fn(latest.current.bubbles) };
      latest.current = next;
      setSt(next);
      schedule(next);
    },
    [schedule],
  );

  const updateSfx = useCallback(
    (fn: (s: Sfx[]) => Sfx[]) => {
      const next = { ...latest.current, sfx: fn(latest.current.sfx) };
      latest.current = next;
      setSt(next);
      schedule(next);
    },
    [schedule],
  );

  const setBusy = useCallback((v: boolean) => {
    busy.current = v;
  }, []);

  return { bubbles: cur.bubbles, sfx: cur.sfx, updateBubbles, updateSfx, setBusy, flush };
}

export type LetteringApi = ReturnType<typeof useLettering>;
