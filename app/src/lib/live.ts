import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { eventsUrl } from "./api";

// One shared SSE connection. The backend sends an integer revision whenever anything changes
// (jobs, story.yaml edits by an agent, picks). Hooks refetch when it moves.

let rev = 0;
let connected = false;
const listeners = new Set<() => void>();
let es: EventSource | null = null;
let retry: number | undefined;

function emit() {
  listeners.forEach((l) => l());
}

function connect() {
  if (es) return;
  es = new EventSource(eventsUrl());
  es.onopen = () => {
    connected = true;
    emit();
  };
  es.onmessage = (e) => {
    const n = Number(e.data);
    if (n !== rev) {
      rev = n;
      emit();
    }
  };
  es.onerror = () => {
    connected = false;
    es?.close();
    es = null;
    emit();
    window.clearTimeout(retry);
    retry = window.setTimeout(connect, 1500);
  };
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  connect();
  return () => listeners.delete(fn);
}

export const useRev = () => useSyncExternalStore(subscribe, () => rev);
export const useConnected = () => useSyncExternalStore(subscribe, () => connected);

/**
 * Fetch `fn` and refetch whenever the backend revision moves (or deps change).
 * Keeps the previous data while refetching so the UI never flashes empty.
 */
export function useLive<T>(fn: (() => Promise<T>) | null, deps: unknown[] = []) {
  const r = useRev();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // `gen` changes only when deps change: a response from older deps is stale and dropped.
  // Revision bumps never drop a response; while one request is in flight, further bumps
  // coalesce into a single follow-up fetch (so slow endpoints still land during busy runs).
  const gen = useRef(0);
  const inFlight = useRef(false);
  const again = useRef(false);

  const reload = useCallback(async () => {
    const f = fnRef.current;
    if (!f) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    const my = gen.current;
    try {
      const d = await f();
      if (my === gen.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === gen.current) setError(e as Error);
    } finally {
      inFlight.current = false;
      if (my === gen.current) setLoading(false);
      if (again.current || my !== gen.current) {
        again.current = false;
        void reload();
      }
    }
  }, []);

  useEffect(() => {
    gen.current++;
    setLoading(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, reload, ...deps]);

  return { data, error, loading: loading && data === undefined, reload, setData };
}

/**
 * Debounced callback: for fields that save as you type. A pending call is flushed (not dropped)
 * when the component unmounts or the window is hidden, so switching panels or closing the app
 * right after typing still saves. The flush uses the last render's callback, which belongs to
 * the component being unmounted (inspectors are keyed by panel id).
 */
export function useDebounced<A extends unknown[]>(fn: (...a: A) => void, ms = 400) {
  const t = useRef<number | undefined>(undefined);
  const pending = useRef<A | null>(null);
  const f = useRef(fn);
  f.current = fn;

  const flush = useCallback(() => {
    window.clearTimeout(t.current);
    const a = pending.current;
    pending.current = null;
    if (a) f.current(...a);
  }, []);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  return useCallback(
    (...a: A) => {
      window.clearTimeout(t.current);
      pending.current = a;
      t.current = window.setTimeout(flush, ms);
    },
    [ms, flush],
  );
}
