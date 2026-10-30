import { create } from "zustand";

// App-level navigation + transient UI state. Server data lives in useLive hooks, not here.

export type View = "library" | "studio" | "pipeline" | "reader" | "settings";

export interface Toast {
  id: number;
  kind: "info" | "ok" | "error";
  text: string;
}

interface AppState {
  view: View;
  slug: string | null;
  panel: string | null; // selected panel in Studio
  page: number; // current page index in Studio / Reader
  onboarding: boolean;
  toasts: Toast[];
  go: (view: View, slug?: string | null) => void;
  selectPanel: (pid: string | null) => void;
  setPage: (n: number) => void;
  setOnboarding: (v: boolean) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
}

let tid = 0;

export const useApp = create<AppState>((set, get) => ({
  view: (["library", "studio", "pipeline", "reader", "settings"].includes(localStorage.getItem("ms.view") ?? "")
    ? localStorage.getItem("ms.view")
    : "library") as View,
  slug: localStorage.getItem("ms.slug"),
  panel: null,
  page: 0,
  onboarding: false,
  toasts: [],
  go: (view, slug) => {
    const next = slug === undefined ? get().slug : slug;
    if (next) localStorage.setItem("ms.slug", next);
    localStorage.setItem("ms.view", view);
    set({ view, slug: next, ...(next !== get().slug ? { panel: null, page: 0 } : {}) });
  },
  selectPanel: (panel) => set({ panel }),
  setPage: (page) => set({ page }),
  setOnboarding: (onboarding) => set({ onboarding }),
  toast: (text, kind = "info") => {
    const id = ++tid;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    window.setTimeout(() => get().dismiss(id), kind === "error" ? 6000 : 3200);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Run an async action and surface failures as a toast. Returns undefined on error. */
export async function attempt<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) useApp.getState().toast(ok, "ok");
    return r;
  } catch (e) {
    useApp.getState().toast((e as Error).message, "error");
    return undefined;
  }
}
