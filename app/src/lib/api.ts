// Typed client for the Python backend (docs/ARCHITECTURE.md is the contract).
// In dev (Vite :1420) and when served by `studio serve`, calls are same-origin. Inside a Tauri
// production build the page origin is tauri://, so we fall back to the absolute backend URL.

const ABS = (import.meta.env.VITE_API as string | undefined) ?? "http://127.0.0.1:7860";
export const API_BASE = location.protocol.startsWith("http") ? "" : ABS;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method: opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET"),
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    throw new ApiError(0, "The image engine isn't running.");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

/** URL for a file inside stories/<slug>/. `v` busts the cache for files that change in place. */
export const fileUrl = (slug: string, rel: string, v?: number | string | null) =>
  `${API_BASE}/files/${encodeURIComponent(slug)}/${rel.split("/").map(encodeURIComponent).join("/")}${v ? `?v=${v}` : ""}`;

export const versionUrl = (slug: string, pid: string, file: string) => fileUrl(slug, `out/${pid}/${file}`);

/** URL of one drawing layer's pixels, cache-busted by its mtime. */
export const layerUrl = (slug: string, pid: string, lid: string, v?: number | null) => fileUrl(slug, `out/${pid}/drawing/${lid}.png`, v ?? undefined);

/** The panel's cut-out character mask (served path + cache-buster from the server). */
export const subjectUrl = (slug: string, subject: string | null | undefined) => {
  if (!subject) return null;
  const [rel, q] = subject.split("?");
  return fileUrl(slug, rel, q?.replace(/^v=/, ""));
};

export const eventsUrl = () => `${API_BASE}/api/events`;

// ---- types -------------------------------------------------------------

export type Vec2 = [number, number];
export type Box = [number, number, number, number]; // x, y, w, h (fractions)

export type BubbleStyle = "speech" | "shout" | "thought" | "caption";
export interface Bubble {
  id?: string;
  text: string;
  at: Vec2;
  w?: number;
  tail?: Vec2 | null;
  style?: BubbleStyle;
  size?: number;
  vertical?: boolean;
}
export interface Sfx {
  text: string;
  at: Vec2;
  size?: number;
  rotate?: number;
  color?: string;
}

export type FxItem =
  | { type: "screentone"; density?: number; opacity?: number; angle?: number; region?: Box }
  | { type: "speedlines"; density?: number; opacity?: number; angle?: number; region?: Box }
  | { type: "focuslines"; density?: number; opacity?: number; center?: Vec2; region?: Box };

export interface Layers {
  background?: { visible?: boolean; color?: string; image?: string };
  art?: { visible?: boolean };
  fx?: { visible?: boolean; items?: FxItem[] };
  lettering?: { visible?: boolean };
}

export interface Version {
  file: string;
  seed?: number;
  seconds?: number;
  created?: string;
  prompt?: string;
  [k: string]: unknown;
}

export interface ResolvedRef {
  name: string;
  path: string;
  version: string | null;
  label: string;
}

export interface Panel {
  id: string;
  title?: string;
  strip?: boolean;
  refs?: (string | { ref: string; label?: string })[];
  use?: string[];
  cast?: string[];
  action?: string;
  seed?: number;
  strength?: number;
  width?: number;
  height?: number;
  ref_label?: string;
  crop?: { x: number; y: number; scale: number };
  layers?: Layers;
  protect?: Box[];
  bubbles?: Bubble[];
  sfx?: Sfx[];
  // computed by the server
  prompt: string | null;
  resolved_refs: ResolvedRef[];
  plan_error: string | null;
  versions: Version[];
  pick: string | null;
  explicit_pick: string | null;
  final: number | null;
  /** The cut-out character mask for the picked version (out/<pid>/masks/...), if one was made. */
  subject: string | null;
  /** Hand-drawn layers, bottom to top (pixels in out/<pid>/drawing/<id>.png). */
  drawing?: DrawLayer[];
  /** Layer id -> file mtime, for layers that have pixels. */
  drawing_files?: Record<string, number | null>;
  /** Where the panel is in the traditional production order. */
  stage?: Stage;
}

export interface DrawLayer {
  id: string;
  name: string;
  opacity?: number;
  visible?: boolean;
}

export const STAGES = ["name", "pencils", "inks", "blacks", "tone", "finish", "letters"] as const;
export type Stage = (typeof STAGES)[number];

export interface CastMember {
  name: string;
  role?: string;
  face?: string;
  hair?: string;
  outfit?: string;
  palette?: string;
  notes?: string;
  refs?: string[];
  sheet?: string;
  seed?: number;
}

/** Panel border weight. Default "normal"; "none" is a borderless panel that fades into the page. */
export type SlotBorder = "normal" | "bold" | "thin" | "none";
/**
 * How the panel's character (its subject mask) relates to the frame:
 * "pop" draws the character again over the border so it breaks out of the panel;
 * "cutout" drops the frame and art background: only the character floats on the page.
 */
export type SlotSubject = "pop" | "cutout";

export interface PageSlot {
  panel: string; // "" = an empty slot
  box: Box;
  poly?: Vec2[];
  border?: SlotBorder;
  /** Edges touching the live area run off the page edge (tachikiri). */
  bleed?: boolean;
  subject?: SlotSubject;
}
/** Full-bleed art behind every panel on the page: a giant face, a mood, a skyline. */
export interface PageBackground {
  panel: string;
  opacity?: number; // 0..1, default 0.35
  crop?: { x: number; y: number; scale: number };
}
export interface Page {
  id: string;
  panels: PageSlot[];
  background?: PageBackground;
  /** Page and gutter colour. "black" for flashback / dramatic pages. */
  paper?: "white" | "black";
}

export interface Format {
  mode: "page" | "webtoon";
  direction: "rtl" | "ltr";
  page?: { width: number; height: number };
  gutter?: number;
  margin?: number;
}

export interface Note {
  panel: string | null;
  file: string | null;
  text: string;
  at: string;
  done: boolean;
  reply?: string;
}

export type StageId = "analysis" | "script" | "layout" | "artwork" | "lettering" | "qa";
export type StageStatus = "idle" | "running" | "awaiting_agent" | "done" | "error" | "flagged";
export interface PipelineStage {
  id: StageId;
  name: string;
  status: StageStatus;
  detail?: string;
  progress?: { done: number; total: number };
  updated?: string;
  output?: unknown;
}
export interface PipelineState {
  provider: "agent" | "ollama" | "heuristic";
  running: boolean;
  stages: PipelineStage[];
  task?: { stage: string; instructions: string } | null;
  qa?: { panels: Record<string, { ok: boolean; issues: string[]; attempts: number; flagged: boolean }> };
}

export interface StoryDetail {
  slug: string;
  title: string;
  notes_md?: string | null;
  settings: Record<string, unknown>;
  refs: string[];
  panels: Panel[];
  state: { picks: Record<string, string>; stars: Record<string, boolean>; notes: Note[] };
  strip: boolean;
  format: Format;
  cast: Record<string, CastMember>;
  blocks: Record<string, string>;
  avoid?: string | null;
  pages: Page[];
  has_source: boolean;
  pipeline: { stages: { id: StageId; status: StageStatus }[] } | null;
}

export interface StorySummary {
  slug: string;
  title: string;
  panels: number;
  error?: string;
  // optional extras the server may add for the library
  cover?: string | null;
  mode?: "page" | "webtoon";
  updated?: number;
}

export interface Job {
  id: number;
  story: string;
  panel: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  step?: number;
  steps?: number;
  file?: string;
  error?: string;
  seed: number;
}

/** Image edit ops (docs/ARCHITECTURE.md, "Image editing"). Masks are PNG data URLs, white/opaque = selected. */
export type EditOp = { op: string; [k: string]: unknown };
export interface SegmentResult {
  file: string;
  mask: string;
  method: "vision" | "color";
  instance: number | null;
  instances: { index: number; bbox: Box; area: number }[];
  area: number;
  size: [number, number];
  vision: boolean;
}
export interface EditResult {
  file: string | null;
  source: string;
  edited_from: string;
  jobs: number[];
  seeds: number[];
  size: [number, number];
}

export interface Status {
  rev: number;
  engine: string;
  loaded: boolean;
  loading?: boolean;
  model: string | null;
  queued: number;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  apple_silicon: boolean;
  ram_gb: number;
  disk_free_gb: number;
  python: string;
  ffmpeg: boolean;
  engine: string;
}

export interface Settings {
  onboarded: boolean;
  agent: "claude" | "codex" | "ollama" | "none";
  llm: { provider: "agent" | "ollama" | "heuristic"; ollama_url: string; text_model: string; vision_model: string };
  image: { model: string; quantize: number };
}

export interface ModelInfo {
  id: string;
  repo: string;
  approx_gb: number;
  cached: boolean;
  cached_bytes: number;
  downloading: boolean;
  progress?: { done_bytes: number; total_bytes: number } | null;
  error?: string | null;
}

export interface Integrations {
  claude: { installed: boolean; connected: boolean };
  codex: { installed: boolean; connected: boolean };
  ollama: { installed: boolean; running: boolean; models: string[] };
  /** `add`: the exact, shell-quoted `claude mcp add` / `codex mcp add` the Connect button runs. */
  mcp: { command: string[]; env?: Record<string, string>; add?: { claude: string; codex: string }; json: unknown };
}

export interface Coverage {
  length: number;
  spans: { start: number; end: number; panels: string[] }[];
  covered_ratio: number;
  gaps: { start: number; end: number }[];
}

// ---- calls -------------------------------------------------------------

const s = (slug: string) => `/api/stories/${encodeURIComponent(slug)}`;

export const Api = {
  status: () => api<Status>("/api/status"),
  stories: () => api<StorySummary[]>("/api/stories"),
  story: (slug: string) => api<StoryDetail>(s(slug)),
  jobs: (story?: string, active = false) =>
    api<Job[]>(`/api/jobs?${new URLSearchParams({ ...(story ? { story } : {}), ...(active ? { active: "true" } : {}) })}`),
  cancelJob: (id: number) => api(`/api/jobs/${id}`, { method: "DELETE" }),
  generate: (story: string, panel: string, count = 1, seeds?: number[]) =>
    api<{ jobs: number[]; seeds: number[] }>("/api/generate", { body: { story, panel, count, seeds } }),

  createProject: (b: { title: string; slug?: string; mode: Format["mode"]; direction: Format["direction"]; template: "blank" | "sample" }) =>
    api<{ slug: string }>("/api/projects", { body: b }),
  patchStory: (slug: string, b: Partial<{ title: string; notes: string; format: Format; blocks: Record<string, string>; avoid: string }>) =>
    api(s(slug), { method: "PATCH", body: b }),
  addPanel: (slug: string, b: { id?: string; title?: string; after?: string; page?: string } = {}) =>
    api<{ id: string }>(`${s(slug)}/panels`, { body: b }),
  patchPanel: (slug: string, pid: string, b: Record<string, unknown>) => api(`${s(slug)}/panels/${pid}`, { method: "PATCH", body: b }),
  deletePanel: (slug: string, pid: string) => api(`${s(slug)}/panels/${pid}`, { method: "DELETE" }),
  putPages: (slug: string, pages: Page[]) => api(`${s(slug)}/pages`, { method: "PUT", body: { pages } }),
  autoPages: (slug: string, per_page?: number) => api<{ pages: Page[] }>(`${s(slug)}/pages/auto`, { body: { per_page } }),
  putCast: (slug: string, cid: string, c: CastMember) => api(`${s(slug)}/cast/${cid}`, { method: "PUT", body: c }),
  deleteCast: (slug: string, cid: string) => api(`${s(slug)}/cast/${cid}`, { method: "DELETE" }),
  refine: (slug: string, pid: string, b: { preset: "clean" | "inks" | "tone" | "color"; strength?: number; count?: number; source?: string; prompt?: string }) =>
    api<{ jobs: number[]; seeds: number[]; source: string; strength: number }>(`${s(slug)}/panels/${pid}/refine`, { body: b }),
  putLayer: (slug: string, pid: string, lid: string, png: string) => api(`${s(slug)}/panels/${pid}/drawing/${lid}`, { method: "PUT", body: { png } }),
  deleteLayer: (slug: string, pid: string, lid: string) => api(`${s(slug)}/panels/${pid}/drawing/${lid}`, { method: "DELETE" }),
  mergeDrawing: (slug: string, pid: string) => api<{ file: string }>(`${s(slug)}/panels/${pid}/drawing/merge`, { body: {} }),
  importArt: (slug: string, pid: string, file: File) => {
    const f = new FormData();
    f.append("file", file);
    return api<{ file: string }>(`${s(slug)}/panels/${pid}/import`, { form: f });
  },
  uploadRef: (slug: string, file: File) => {
    const f = new FormData();
    f.append("file", file);
    return api<{ name: string }>(`${s(slug)}/refs`, { form: f });
  },
  copilot: (
    slug: string,
    pid: string,
    b: { mode: "txt2img" | "img2img" | "inpaint"; prompt?: string; source?: string; mask?: string; strength?: number; count?: number },
  ) => api<{ jobs: number[]; seeds: number[] }>(`${s(slug)}/panels/${pid}/copilot`, { body: b }),
  subject: (slug: string, pid: string, b: { point?: [number, number]; clear?: boolean }) =>
    api<{ subject: string | null; method: string | null; area: number }>(`${s(slug)}/panels/${pid}/subject`, { body: b }),
  segment: (slug: string, pid: string, b: { point: [number, number]; file?: string; method?: "auto" | "vision" | "color"; tolerance?: number; ops?: EditOp[] }) =>
    api<SegmentResult>(`${s(slug)}/panels/${pid}/segment`, { body: b }),
  edit: (slug: string, pid: string, b: { ops: EditOp[]; file?: string }) => api<EditResult>(`${s(slug)}/panels/${pid}/edit`, { body: b }),
  editPreview: (slug: string, pid: string, b: { ops: EditOp[]; file?: string }) =>
    api<{ file: string; image: string; size: [number, number]; holes: boolean }>(`${s(slug)}/panels/${pid}/edit`, { body: { ...b, preview: true } }),
  job: (id: number) => api<Job>(`/api/jobs/${id}`),
  pick: (slug: string, panel: string, file: string | null) => api(`${s(slug)}/pick`, { body: { panel, file } }),
  star: (slug: string, panel: string, file: string, value: boolean) => api(`${s(slug)}/star`, { body: { panel, file, value } }),
  addNote: (slug: string, b: { panel?: string | null; file?: string | null; text: string }) => api(`${s(slug)}/notes`, { body: b }),
  noteDone: (slug: string, index: number, done = true) => api(`${s(slug)}/notes/done`, { body: { index, done } }),
  letter: (slug: string, panels?: string[], overwrite = false) =>
    api<{ placed: Record<string, number> }>(`${s(slug)}/letter`, { body: { panels, overwrite } }),
  exportStory: (slug: string, b: { formats: ("png" | "svg" | "pdf")[]; preset: "digital" | "print-b5" | "print-a5"; bleed_mm?: number; margin_mm?: number }) =>
    api<{ files: string[] }>(`${s(slug)}/export`, { body: b }),
  compose: (slug: string) => api(`${s(slug)}/compose`, { body: {} }),

  system: () => api<SystemInfo>("/api/system"),
  settings: () => api<Settings>("/api/settings"),
  putSettings: (b: Partial<Settings>) => api<Settings>("/api/settings", { method: "PUT", body: b }),
  models: () => api<ModelInfo[]>("/api/models"),
  downloadModel: (id: string) => api(`/api/models/${id}/download`, { body: {} }),
  integrations: () => api<Integrations>("/api/integrations"),
  connect: (agent: "claude" | "codex") => api<{ ok: boolean; command: string; output: string }>(`/api/integrations/${agent}/connect`, { body: {} }),

  pipelineNew: (b: { title: string; text: string; mode: Format["mode"]; direction: Format["direction"]; provider?: PipelineState["provider"] }) =>
    api<{ slug: string }>("/api/pipeline/new", { body: b }),
  source: (slug: string) => api<{ text: string }>(`${s(slug)}/source`),
  putSource: (slug: string, text: string) => api(`${s(slug)}/source`, { method: "PUT", body: { text } }),
  pipeline: (slug: string) => api<PipelineState>(`${s(slug)}/pipeline`),
  runPipeline: (slug: string, b: { from?: StageId; to?: StageId; provider?: PipelineState["provider"] } = {}) =>
    api<PipelineState>(`${s(slug)}/pipeline/run`, { body: b }),
  cancelPipeline: (slug: string) => api(`${s(slug)}/pipeline/cancel`, { body: {} }),
  overrideStage: (slug: string, stage: StageId, output: unknown) =>
    api<PipelineState>(`${s(slug)}/pipeline/stages/${stage}`, { method: "PUT", body: { output } }),
  coverage: (slug: string) => api<Coverage>(`${s(slug)}/coverage`),
};
