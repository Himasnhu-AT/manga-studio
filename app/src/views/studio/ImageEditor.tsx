// Edit image mode: the selected panel's picture fills the canvas. Select things (Vision segment, lasso,
// brush), lift and rearrange them, erase, crop, rotate, flip, adjust, and, most of all, describe a fix
// ("show her legs") in the bar under the picture. Edits are a list of ops: the backend renders previews
// and, on Apply or Fix, saves a NEW version (the original never changes).
//
// Feel: everything answers on pointer-down; floating pieces follow the pointer 1:1 (no easing while held);
// springs are critically damped and collapse to opacity under reduced motion.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowLineDown,
  ArrowLineLeft,
  ArrowLineRight,
  ArrowLineUp,
  ArrowUUpLeft,
  ArrowUUpRight,
  ArrowsOut,
  ArrowsOutCardinal,
  Crop,
  Eraser,
  Eye,
  EyeSlash,
  FlipHorizontal,
  FlipVertical,
  ImageSquare,
  Lasso,
  MagicWand,
  PaintBrush,
  SlidersHorizontal,
  Sparkle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Api, versionUrl, type EditOp, type Panel, type StoryDetail } from "../../lib/api";
import { attempt, useApp } from "../../lib/store";
import { Lettering } from "../../ui/PanelView";
import { Button, Empty, IconButton, Kbd, Progress, Segmented, Spinner, cx, spring } from "../../ui/kit";
import { COMMANDS, parseCommand, type Side } from "./editCommands";
import * as S from "./editSelection";
import { Divider, ModeSwitch } from "./Toolbar";
import { useStudio } from "./studioState";

type Tool = "select" | "lasso" | "brush" | "move" | "crop";
type Box = { x: number; y: number; w: number; h: number };
interface Float {
  id: number;
  mask: string; // selection PNG (image px) the piece was lifted with
  cut: string; // the piece itself (data URL)
  box: Box; // where it came from (image px)
  dx: number; // offset in image px
  dy: number;
  scale: number;
  rotate: number; // deg, clockwise
  flipH: boolean;
  flipV: boolean;
}
interface Snap {
  ops: EditOp[];
  sel: string | null;
  floats: Float[];
}
type Phase =
  | { kind: "edit" }
  | { kind: "running"; jobs: number[]; source: string; label: string; progress: number; queued: boolean }
  | { kind: "compare"; source: string; candidates: string[]; active: number; label: string };

const STRENGTHS = [
  { value: "0.4", label: "Subtle", title: "Small changes, stays very close" },
  { value: "0.6", label: "Medium", title: "Clear change, same composition" },
  { value: "0.85", label: "Redraw", title: "Big change, may move things" },
];
const TINT = "rgb(210 69 47 / 0.28)";
const EDGE = "rgb(210 69 47 / 0.95)";
const PAD_X = 40;
const TOP = 116; // toolbar + context bar
const BOTTOM = 132; // fix bar

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function ImageEditor({ story, panel, pageMode }: { story: StoryDetail; panel: Panel; pageMode: boolean }) {
  if (!panel.pick)
    return (
      <Shell pageMode={pageMode}>
        <div className="flex h-full items-center justify-center">
          <Empty
            icon={<ImageSquare size={20} />}
            title="Nothing to edit yet"
            body="This panel has no picture. Generate it first, then come back to edit it."
            action={
              <Button size="sm" variant="primary" icon={<Sparkle size={13} weight="fill" />} onClick={() => void attempt(() => Api.generate(story.slug, panel.id), `Queued ${panel.id}`)}>
                Generate
              </Button>
            }
          />
        </div>
      </Shell>
    );
  return <Editor key={`${panel.id}/${panel.pick}`} story={story} panel={panel} pageMode={pageMode} file={panel.pick} />;
}

function Shell({ pageMode, children, right }: { pageMode: boolean; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="canvas-bg absolute inset-0 z-20">
      {children}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3">
        <div className="material pointer-events-auto flex items-center gap-0.5 rounded-[var(--radius-surface)] border border-line p-1 shadow-[var(--shadow-float)]">
          <ModeSwitch pageMode={pageMode} canEdit />
        </div>
        {right}
      </div>
    </div>
  );
}

function Editor({ story, panel, pageMode, file: startFile }: { story: StoryDetail; panel: Panel; pageMode: boolean; file: string }) {
  const reduce = useReducedMotion();
  const toast = useApp((s) => s.toast);
  const setEditImage = useStudio((s) => s.setEditImage);

  // ---- session state ------------------------------------------------------------------
  const [file, setFile] = useState(startFile); // the version the ops start from
  const [ops, setOps] = useState<EditOp[]>([]);
  const [floats, setFloats] = useState<Float[]>([]);
  const [activeFloat, setActiveFloat] = useState<number | null>(null);
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const [histRev, setHistRev] = useState(0);
  const [tool, setTool] = useState<Tool>("select");
  const [method, setMethod] = useState<"object" | "color">("object");
  const [tolerance, setTolerance] = useState(0.12);
  const [brush, setBrush] = useState(0.035);
  const [showLetters, setShowLetters] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const [strength, setStrength] = useState("0.6");
  const [count, setCount] = useState(2);
  const [text, setText] = useState("");
  const lastModel = useRef<{ ops: EditOp[]; label: string; file: string } | null>(null);

  // ---- image: committed render (base) and what is on screen (display) --------------------
  const srcUrl = versionUrl(story.slug, panel.id, file);
  const [base, setBase] = useState<{ url: string; w: number; h: number } | null>(null);
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const baseImg = useRef<HTMLImageElement | null>(null);
  const renderSeq = useRef(0);

  useEffect(() => {
    const n = ++renderSeq.current;
    let alive = true;
    (async () => {
      if (!ops.length) {
        const im = await S.loadImage(srcUrl).catch(() => null);
        if (!alive || n !== renderSeq.current || !im) return;
        baseImg.current = im;
        setBase({ url: srcUrl, w: im.naturalWidth, h: im.naturalHeight });
        return;
      }
      setRendering(true);
      const r = await attempt(() => Api.editPreview(story.slug, panel.id, { file, ops }));
      if (!alive || n !== renderSeq.current) return;
      setRendering(false);
      if (!r) return;
      const im = await S.loadImage(r.image);
      if (!alive || n !== renderSeq.current) return;
      baseImg.current = im;
      setBase({ url: r.image, w: r.size[0], h: r.size[1] });
    })();
    return () => {
      alive = false;
    };
  }, [ops, file, srcUrl, story.slug, panel.id]);

  // While pieces float, the screen shows the base with their holes filled (as the move op will).
  const holeSeq = useRef(0);
  useEffect(() => {
    if (!floats.length || !base) {
      setDisplayUrl(null);
      return;
    }
    const n = ++holeSeq.current;
    const holes = floats.map((f) => ({ op: "erase", mask: f.mask }));
    void Api.editPreview(story.slug, panel.id, { file, ops: [...ops, ...holes] })
      .then((r) => n === holeSeq.current && setDisplayUrl(r.image))
      .catch(() => undefined);
    // only when the set of lifted pieces changes, not on every drag frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floats.map((f) => f.id).join(","), base?.url]);

  // ---- selection --------------------------------------------------------------------------
  const sel = useRef<HTMLCanvasElement>(S.newCanvas(1, 1));
  const [selRev, setSelRev] = useState(0);
  const [selEmpty, setSelEmpty] = useState(true);
  const W = base?.w ?? 1;
  const H = base?.h ?? 1;
  useEffect(() => {
    if (!base) return;
    if (sel.current.width !== base.w || sel.current.height !== base.h) {
      sel.current = S.newCanvas(base.w, base.h);
      setSelEmpty(true);
      setSelRev((r) => r + 1);
    }
  }, [base]);
  const selChanged = useCallback(() => {
    setSelEmpty(!S.bbox(sel.current));
    setSelRev((r) => r + 1);
  }, []);

  // ---- history ----------------------------------------------------------------------------
  const snap = useCallback((): Snap => ({ ops, sel: selEmpty ? null : sel.current.toDataURL(), floats }), [ops, selEmpty, floats]);
  const record = useCallback(() => {
    past.current.push(snap());
    if (past.current.length > 60) past.current.shift();
    future.current = [];
    setHistRev((r) => r + 1);
  }, [snap]);
  const restore = useCallback(
    async (s: Snap) => {
      setOps(s.ops);
      setFloats(s.floats);
      setActiveFloat(s.floats.at(-1)?.id ?? null);
      S.clear(sel.current);
      if (s.sel) S.combine(sel.current, await S.loadImage(s.sel), "add");
      selChanged();
    },
    [selChanged],
  );
  const undo = useCallback(() => {
    const s = past.current.pop();
    if (!s) return;
    future.current.push(snap());
    setHistRev((r) => r + 1);
    void restore(s);
  }, [snap, restore]);
  const redo = useCallback(() => {
    const s = future.current.pop();
    if (!s) return;
    past.current.push(snap());
    setHistRev((r) => r + 1);
    void restore(s);
  }, [snap, restore]);
  void histRev;

  // ---- floats (lift, transform, drop) ---------------------------------------------------
  const moveOp = (f: Float): EditOp | null => {
    if (!f.dx && !f.dy && f.scale === 1 && !f.rotate && !f.flipH && !f.flipV) return null;
    return {
      op: "move",
      mask: f.mask,
      dx: round4(f.dx / W),
      dy: round4(f.dy / H),
      scale: round4(f.scale),
      rotate: Math.round(f.rotate * 10) / 10,
      ...(f.flipH !== f.flipV ? { flip: f.flipH ? "h" : "v" } : f.flipH && f.flipV ? { rotate: Math.round((f.rotate + 180) * 10) / 10 } : {}),
    };
  };
  /** Ops including any floating pieces dropped where they are. */
  const allOps = useCallback((): EditOp[] => [...ops, ...(floats.map(moveOp).filter(Boolean) as EditOp[])], [ops, floats]); // eslint-disable-line react-hooks/exhaustive-deps
  const drop = useCallback(() => {
    if (!floats.length) return;
    record();
    setOps(allOps());
    setFloats([]);
    setActiveFloat(null);
  }, [floats.length, record, allOps]);
  const putBack = () => {
    if (!floats.length) return;
    record();
    setFloats([]);
    setActiveFloat(null);
  };
  const lift = useCallback((): Float | null => {
    const b = S.bbox(sel.current);
    if (!b || !baseImg.current) return null;
    record();
    const f: Float = { id: Date.now(), mask: sel.current.toDataURL(), cut: S.cutout(baseImg.current, sel.current, b).toDataURL(), box: b, dx: 0, dy: 0, scale: 1, rotate: 0, flipH: false, flipV: false };
    setFloats((fs) => [...fs, f]);
    setActiveFloat(f.id);
    S.clear(sel.current);
    selChanged();
    setTool("move");
    return f;
  }, [record, selChanged]);
  const patchFloat = (id: number, p: Partial<Float>) => setFloats((fs) => fs.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const reorder = (dir: 1 | -1) => {
    if (activeFloat == null) return;
    setFloats((fs) => {
      const i = fs.findIndex((f) => f.id === activeFloat);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= fs.length) return fs;
      const out = [...fs];
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });
  };

  // ---- ops that change pixels right away ------------------------------------------------
  const push = useCallback(
    (op: EditOp, opts: { keepSel?: boolean } = {}) => {
      record();
      setOps([...allOps(), op]);
      setFloats([]);
      setActiveFloat(null);
      if (!opts.keepSel) {
        S.clear(sel.current);
        selChanged();
      }
    },
    [record, allOps, selChanged],
  );
  const selMask = () => (selEmpty ? undefined : sel.current.toDataURL());
  const erase = () => {
    if (selEmpty) return setNotice("Select something first, then erase it");
    push({ op: "erase", mask: sel.current.toDataURL(), fill: "local" });
  };
  const flip = (axis: "h" | "v") => (selEmpty ? push({ op: "flip", axis }) : push({ op: "flip", axis, mask: sel.current.toDataURL() }));
  const rotate = (deg: number) => push({ op: "rotate", deg });
  const [crop, setCrop] = useState<Box | null>(null); // fractions
  const applyCrop = () => {
    if (!crop || crop.w < 0.02 || crop.h < 0.02) return;
    push({ op: "crop", box: [round4(crop.x), round4(crop.y), round4(crop.w), round4(crop.h)] });
    setCrop(null);
  };
  const [adj, setAdj] = useState<{ b: number; c: number; s: number } | null>(null);
  const applyAdjust = () => {
    if (!adj) return;
    if (adj.b !== 1 || adj.c !== 1 || adj.s !== 1) push({ op: "adjust", brightness: adj.b, contrast: adj.c, saturation: adj.s, ...(selEmpty ? {} : { mask: sel.current.toDataURL() }) }, { keepSel: true });
    setAdj(null);
  };

  // ---- model work: fix / redraw / extend / AI erase ---------------------------------------
  const runModel = useCallback(
    async (modelOps: EditOp[], label: string) => {
      const r = await attempt(() => Api.edit(story.slug, panel.id, { file, ops: modelOps }));
      if (!r) return;
      lastModel.current = { ops: modelOps, label, file };
      // pixel edits (if any) were saved as r.file and now are the starting point
      setFile(r.source);
      setOps([]);
      setFloats([]);
      past.current = [];
      future.current = [];
      S.clear(sel.current);
      selChanged();
      if (!r.jobs.length) {
        toast(`Saved ${r.source}`, "ok");
        return;
      }
      setPhase({ kind: "running", jobs: r.jobs, source: r.source, label, progress: 0, queued: true });
    },
    [story.slug, panel.id, file, selChanged, toast],
  );
  const fix = (prompt: string, redraw = false) => {
    const mask = redraw ? undefined : selMask();
    const op: EditOp = { op: redraw ? "redraw" : "fix", prompt, strength: Number(strength), count, ...(mask ? { mask } : {}) };
    void runModel([...allOps(), op], prompt || "Redraw");
  };
  const extend = (side: Side, amount: number, prompt: string) =>
    void runModel([...allOps(), { op: "extend", side, amount, prompt: prompt || undefined, count }], `Extend ${side} ${Math.round(amount * 100)}%${prompt ? `: ${prompt}` : ""}`);
  const eraseAI = () => {
    if (selEmpty) return setNotice("Select something first, then erase it");
    void runModel([...allOps(), { op: "erase", mask: sel.current.toDataURL(), fill: "model", count }], "Remove and repaint");
  };

  // progress polling
  useEffect(() => {
    if (phase.kind !== "running") return;
    let alive = true;
    const tick = async () => {
      const js = await Promise.all(phase.jobs.map((id) => Api.job(id).catch(() => null)));
      if (!alive) return;
      const done = js.filter((j) => j && ["done", "error", "cancelled"].includes(j.status));
      if (done.length === phase.jobs.length) {
        const files = js.filter((j) => j?.status === "done" && j.file).map((j) => j!.file!);
        const err = js.find((j) => j?.status === "error");
        if (!files.length) {
          toast(err?.error ? `Fix failed: ${err.error}` : "Nothing came back from the model", "error");
          setPhase({ kind: "edit" });
        } else {
          if (err) toast(`${files.length} of ${phase.jobs.length} finished; one failed`, "info");
          setPhase({ kind: "compare", source: phase.source, candidates: files, active: 0, label: phase.label });
        }
        return;
      }
      const prog = js.reduce((a, j) => a + (j?.status === "done" ? 1 : j?.steps ? (j.step ?? 0) / j.steps : 0), 0) / phase.jobs.length;
      const queued = js.every((j) => j?.status === "queued");
      setPhase((p) => (p.kind === "running" ? { ...p, progress: prog, queued } : p));
      window.setTimeout(tick, 500);
    };
    void tick();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind === "running" ? phase.jobs.join(",") : ""]);

  const keep = async (cand: string) => {
    const ok = await attempt(() => Api.pick(story.slug, panel.id, cand), `Using ${cand} for ${panel.id}`);
    if (ok === undefined) return;
    setFile(cand);
    setPhase({ kind: "edit" });
    setText("");
  };

  // ---- apply / cancel ---------------------------------------------------------------------
  const pending = allOps();
  const [saving, setSaving] = useState(false);
  const apply = async () => {
    if (!pending.length) return setEditImage(false);
    setSaving(true);
    const r = await attempt(() => Api.edit(story.slug, panel.id, { file, ops: pending }));
    setSaving(false);
    if (!r) return;
    if (r.file) await attempt(() => Api.pick(story.slug, panel.id, r.file!), `Saved as ${r.file}. The original is still in Versions.`);
    if (r.jobs.length) {
      setFile(r.source);
      setOps([]);
      setFloats([]);
      setPhase({ kind: "running", jobs: r.jobs, source: r.source, label: "Fill", progress: 0, queued: true });
      return;
    }
    setEditImage(false);
  };
  const cancel = () => {
    if (pending.length) toast("Edits discarded. The picture is unchanged.", "info");
    setEditImage(false);
  };

  // ---- commands ------------------------------------------------------------------------------
  const inputRef = useRef<HTMLInputElement>(null);
  const runCommand = (raw: string) => {
    const c = parseCommand(raw);
    if (!c) return;
    setNotice(null);
    switch (c.kind) {
      case "fix":
        fix(c.prompt);
        break;
      case "redraw":
        fix(c.prompt, true);
        break;
      case "extend":
        extend(c.side, c.amount, c.prompt);
        break;
      case "tool":
        setTool(c.tool);
        break;
      case "erase":
        if (c.ai) eraseAI();
        else erase();
        break;
      case "flip":
        flip(c.axis);
        break;
      case "rotate":
        if (c.deg) rotate(c.deg);
        break;
      case "adjust":
        if (c.brightness != null || c.contrast != null || c.saturation != null)
          push({ op: "adjust", brightness: c.brightness ?? 1, contrast: c.contrast ?? 1, saturation: c.saturation ?? 1, ...(selEmpty ? {} : { mask: sel.current.toDataURL() }) }, { keepSel: true });
        else setAdj({ b: 1, c: 1, s: 1 });
        break;
      case "simple":
        ({
          undo,
          redo,
          apply: () => void apply(),
          cancel,
          deselect: () => (S.clear(sel.current), selChanged()),
          invert: () => (record(), S.invert(sel.current), selChanged()),
          all: () => (record(), S.fillAll(sel.current), selChanged()),
          bubbles: () => setShowLetters((v) => !v),
          lift: () => void lift(),
        })[c.name]();
        break;
      case "error":
        setNotice(c.message);
        return;
    }
    setText("");
    inputRef.current?.blur();
  };

  // ---- keyboard -------------------------------------------------------------------------------
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      inputRef.current?.focus();
      if (!text) setText("/");
      return;
    }
    if (isTyping(e.target)) return;
    if (phase.kind === "compare") {
      if (e.key === "Escape") (e.preventDefault(), setPhase({ kind: "edit" }));
      else if (e.key === "Enter") (e.preventDefault(), void keep(phase.candidates[phase.active] ?? phase.source));
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const n = phase.candidates.length;
        setPhase({ ...phase, active: (phase.active + (e.key === "ArrowRight" ? 1 : n - 1)) % n });
      }
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod) return;
    if (e.key === "/") {
      e.preventDefault();
      inputRef.current?.focus();
      setText("/");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (adj) setAdj(null);
      else if (crop) setCrop(null);
      else if (floats.length) putBack();
      else if (!selEmpty) (S.clear(sel.current), selChanged());
      else cancel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (crop) applyCrop();
      else if (floats.length) drop();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      erase();
      return;
    }
    if (e.key === "[" || e.key === "]") {
      setBrush((b) => Math.min(0.2, Math.max(0.005, b * (e.key === "]" ? 1.25 : 0.8))));
      return;
    }
    const t = ({ w: "select", l: "lasso", b: "brush", m: "move", c: "crop" } as const)[e.key.toLowerCase() as "w"];
    if (t) setTool(t);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => {
    if (tool !== "crop") setCrop(null);
    if (tool !== "move" && floats.length) drop();
    setNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // ---- layout: fit the picture between the bars ----------------------------------------------
  const area = useRef<HTMLDivElement>(null);
  const [areaSize, setAreaSize] = useState({ w: 800, h: 600 });
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setAreaSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const k = base ? Math.min((areaSize.w - PAD_X * 2) / W, (areaSize.h - TOP - BOTTOM) / H, 2) : 1;
  const dispW = Math.max(1, Math.round(W * k));
  const dispH = Math.max(1, Math.round(H * k));

  // selection tint
  const tintRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = tintRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(dispW * dpr);
    c.height = Math.round(dispH * dpr);
    S.paintTint(c, sel.current, TINT, EDGE);
  }, [selRev, dispW, dispH]);

  // ---- pointer on the picture -------------------------------------------------------------------
  const stage = useRef<HTMLDivElement>(null);
  const [pending1, setPending1] = useState<{ x: number; y: number } | null>(null); // segment in flight
  const [lasso, setLasso] = useState<[number, number][] | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const frac = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] as [number, number];
  };
  const combineMode = (e: React.PointerEvent): S.Combine => (e.shiftKey ? "add" : e.altKey ? "subtract" : "replace");

  const segmentAt = async (p: [number, number], mode: S.Combine) => {
    setPending1({ x: p[0], y: p[1] });
    const r = await attempt(() =>
      Api.segment(story.slug, panel.id, { file, point: p, method: method === "object" ? "auto" : "color", tolerance, ops: allOps() }),
    );
    setPending1(null);
    if (!r) return;
    const m = await S.lumToAlpha(r.mask, W, H);
    record();
    S.combine(sel.current, m, mode);
    selChanged();
    if (method === "object" && r.method === "color") setNotice(r.vision ? "No object there, so similar colours were selected. Raise or lower Tolerance under Colour." : "Object detection needs macOS 14. Selected by colour instead.");
    else setNotice(null);
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || phase.kind !== "edit" || !base) return;
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers */
    }
    const p = frac(e);
    if (tool === "select") {
      void segmentAt(p, combineMode(e));
      return;
    }
    if (tool === "lasso") {
      const mode = combineMode(e);
      const pts: [number, number][] = [p];
      setLasso(pts);
      const move = (ev: PointerEvent) => {
        pts.push(frac(ev));
        setLasso([...pts]);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        setLasso(null);
        if (pts.length < 3) return;
        record();
        S.combine(sel.current, S.polygonMask(W, H, pts), mode);
        selChanged();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      return;
    }
    if (tool === "brush") {
      record();
      const eraseMode = e.altKey;
      const r = brush * W;
      let last: [number, number] = [p[0] * W, p[1] * H];
      S.brushDab(sel.current, last, last, r, eraseMode);
      selChanged();
      const move = (ev: PointerEvent) => {
        const q = frac(ev);
        const cur: [number, number] = [q[0] * W, q[1] * H];
        S.brushDab(sel.current, last, cur, r, eraseMode);
        last = cur;
        setSelRev((v) => v + 1);
        setHover({ x: q[0], y: q[1] });
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        selChanged();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      return;
    }
    if (tool === "crop") {
      const start = p;
      const move = (ev: PointerEvent) => {
        const q = frac(ev).map((v) => Math.min(1, Math.max(0, v))) as [number, number];
        setCrop({ x: Math.min(start[0], q[0]), y: Math.min(start[1], q[1]), w: Math.abs(q[0] - start[0]), h: Math.abs(q[1] - start[1]) });
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      return;
    }
    if (tool === "move") {
      // press on the selection lifts it and starts dragging in the same gesture
      if (!selEmpty && S.hit(sel.current, p[0] * W, p[1] * H)) {
        const f = lift();
        if (f) dragFloat(e, f, "move");
        return;
      }
      if (floats.length) drop();
      else if (selEmpty) setNotice("Select something first (W), then drag it here");
    }
  };

  /** 1:1 transforms of a floating piece: move, uniform scale from the centre, rotate about the centre. */
  const dragFloat = (e: React.PointerEvent | PointerEvent, f: Float, kind: "move" | "scale" | "rotate") => {
    e.stopPropagation();
    const target = (e.currentTarget ?? stage.current) as HTMLElement;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers */
    }
    setActiveFloat(f.id);
    const r = stage.current!.getBoundingClientRect();
    const kk = r.width / W;
    const cx = r.left + (f.box.x + f.box.w / 2 + f.dx) * kk;
    const cy = r.top + (f.box.y + f.box.h / 2 + f.dy) * kk;
    const sx = e.clientX;
    const sy = e.clientY;
    const d0 = Math.max(4, Math.hypot(sx - cx, sy - cy));
    const a0 = Math.atan2(sy - cy, sx - cx);
    const start = { ...f };
    let recorded = false;
    const move = (ev: PointerEvent) => {
      if (!recorded) {
        recorded = true;
        if (kind !== "move" || f.dx || f.dy) record(); // a fresh lift already recorded itself
      }
      if (kind === "move") patchFloat(f.id, { dx: start.dx + (ev.clientX - sx) / kk, dy: start.dy + (ev.clientY - sy) / kk });
      else if (kind === "scale") patchFloat(f.id, { scale: Math.min(10, Math.max(0.05, (start.scale * Math.hypot(ev.clientX - cx, ev.clientY - cy)) / d0)) });
      else {
        let deg = start.rotate + ((Math.atan2(ev.clientY - cy, ev.clientX - cx) - a0) * 180) / Math.PI;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        patchFloat(f.id, { rotate: ((deg % 360) + 540) % 360 - 180 });
      }
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const cursor = tool === "brush" ? "none" : tool === "move" ? (selEmpty && !floats.length ? "default" : "move") : "crosshair";
  const shown = phase.kind === "compare" ? (phase.active < 0 ? versionUrl(story.slug, panel.id, phase.source) : versionUrl(story.slug, panel.id, phase.candidates[phase.active])) : displayUrl ?? base?.url;
  const scope = !selEmpty || floats.length ? "selection" : "whole";
  const placeholder = scope === "selection" ? "Describe a fix for the selected area" : "Describe a fix, e.g. show the girl's legs";

  const cmdList = useMemo(() => {
    if (!text.startsWith("/")) return [];
    const q = text.slice(1).split(/\s/)[0].toLowerCase();
    if (text.includes(" ")) return COMMANDS.filter((c) => c.name === q);
    return COMMANDS.filter((c) => c.name.startsWith(q));
  }, [text]);
  const [cmdIdx, setCmdIdx] = useState(0);
  useEffect(() => setCmdIdx(0), [text]);

  const busy = phase.kind === "running";
  const editing = phase.kind === "edit";

  return (
    <div ref={area} className="canvas-bg absolute inset-0 z-20 overflow-hidden" onPointerDown={(e) => e.target === e.currentTarget && floats.length && drop()}>
      {/* ---- picture -------------------------------------------------------------------- */}
      {base ? (
        <motion.div
          className="absolute"
          style={{ left: (areaSize.w - dispW) / 2, top: TOP + (areaSize.h - TOP - BOTTOM - dispH) / 2, width: dispW, height: dispH }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          transition={spring}
        >
          <div
            ref={stage}
            className="relative size-full touch-none bg-paper shadow-[var(--shadow-page)]"
            style={{ cursor: editing ? cursor : "default" }}
            onPointerDown={onDown}
            onPointerMove={(e) => tool === "brush" && setHover({ x: frac(e)[0], y: frac(e)[1] })}
            onPointerLeave={() => setHover(null)}
          >
            {shown && <img src={shown} alt={`${panel.id} being edited`} draggable={false} className="absolute inset-0 size-full object-fill select-none" />}
            {adj && shown && editing && (
              <img
                src={shown}
                alt=""
                draggable={false}
                className="pointer-events-none absolute inset-0 size-full object-fill"
                style={{
                  filter: `brightness(${adj.b}) contrast(${adj.c}) saturate(${adj.s})`,
                  ...(selEmpty ? {} : { maskImage: `url(${sel.current.toDataURL()})`, WebkitMaskImage: `url(${sel.current.toDataURL()})`, maskSize: "100% 100%", WebkitMaskSize: "100% 100%" }),
                }}
              />
            )}
            {showLetters && (
              <div className={cx("pointer-events-none absolute inset-0", editing && "opacity-80")}>
                <Lettering bubbles={panel.bubbles ?? []} sfx={panel.sfx ?? []} W={W} H={H} />
              </div>
            )}
            {editing && <canvas ref={tintRef} className="pointer-events-none absolute inset-0 size-full" aria-hidden />}

            {editing &&
              floats.map((f) => <FloatPiece key={f.id} f={f} k={dispW / W} active={f.id === activeFloat} onDrag={(e, kind) => dragFloat(e, f, kind)} />)}

            {lasso && (
              <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 1 1" preserveAspectRatio="none">
                <polyline points={lasso.map((p) => p.join(",")).join(" ")} fill="rgb(210 69 47 / 0.12)" stroke={EDGE} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray="4 3" />
              </svg>
            )}
            {crop && <CropFrame c={crop} />}
            {pending1 && (
              <span className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent" style={{ left: `${pending1.x * 100}%`, top: `${pending1.y * 100}%`, animation: reduce ? undefined : "seg-ping 0.9s var(--ease-out) infinite" }} />
            )}
            {tool === "brush" && hover && editing && (
              <span className="pointer-events-none absolute rounded-full border border-ink/70 shadow-[0_0_0_1px_rgb(252_252_251/0.8)]" style={{ left: `${hover.x * 100}%`, top: `${hover.y * 100}%`, width: brush * 2 * dispW, height: brush * 2 * dispW, transform: "translate(-50%, -50%)" }} />
            )}
            {busy && <RunningVeil phase={phase} />}
          </div>
        </motion.div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="skeleton" style={{ width: 360, height: 480 }} />
        </div>
      )}

      {/* ---- top: toolbar + context ------------------------------------------------------------ */}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col items-start gap-2">
        <div className="flex w-full items-start justify-between gap-3">
          <div className="material pointer-events-auto flex items-center gap-0.5 rounded-[var(--radius-surface)] border border-line p-1 shadow-[var(--shadow-float)]">
            <ModeSwitch pageMode={pageMode} canEdit />
            <Divider />
            <ToolBtn on={tool === "select"} label="Select object (W)" onClick={() => setTool("select")} disabled={!editing}>
              <MagicWand size={16} />
            </ToolBtn>
            <ToolBtn on={tool === "lasso"} label="Lasso (L)" onClick={() => setTool("lasso")} disabled={!editing}>
              <Lasso size={16} />
            </ToolBtn>
            <ToolBtn on={tool === "brush"} label="Brush selection (B)" onClick={() => setTool("brush")} disabled={!editing}>
              <PaintBrush size={16} />
            </ToolBtn>
            <ToolBtn on={tool === "move"} label="Move (M)" onClick={() => setTool("move")} disabled={!editing}>
              <ArrowsOutCardinal size={16} />
            </ToolBtn>
            <ToolBtn on={tool === "crop"} label="Crop (C)" onClick={() => setTool("crop")} disabled={!editing}>
              <Crop size={16} />
            </ToolBtn>
            <Divider />
            <IconButton label="Rotate 90°" onClick={() => rotate(90)} disabled={!editing}>
              <ArrowClockwise size={16} />
            </IconButton>
            <IconButton label={selEmpty ? "Flip picture" : "Flip selection"} onClick={() => flip("h")} disabled={!editing}>
              <FlipHorizontal size={16} />
            </IconButton>
            <IconButton label={selEmpty ? "Flip picture upside down" : "Flip selection upside down"} onClick={() => flip("v")} disabled={!editing}>
              <FlipVertical size={16} />
            </IconButton>
            <IconButton label="Adjust tone" active={!!adj} onClick={() => setAdj(adj ? null : { b: 1, c: 1, s: 1 })} disabled={!editing}>
              <SlidersHorizontal size={16} />
            </IconButton>
            <ExtendMenu disabled={!editing} onExtend={(side, amt) => extend(side, amt, text.startsWith("/") ? "" : text.trim())} />
            <Divider />
            <IconButton label="Undo (⌘Z)" onClick={undo} disabled={!editing || !past.current.length}>
              <ArrowUUpLeft size={16} />
            </IconButton>
            <IconButton label="Redo (⇧⌘Z)" onClick={redo} disabled={!editing || !future.current.length}>
              <ArrowUUpRight size={16} />
            </IconButton>
            <IconButton label={showLetters ? "Hide bubbles" : "Show bubbles"} active={!showLetters} onClick={() => setShowLetters((v) => !v)}>
              {showLetters ? <Eye size={16} /> : <EyeSlash size={16} />}
            </IconButton>
          </div>
          <div className="material pointer-events-auto flex items-center gap-1 rounded-[var(--radius-surface)] border border-line p-1 shadow-[var(--shadow-float)]">
            {rendering && <Spinner className="mx-1.5 text-ink-3" />}
            <span className="num px-1.5 text-[12px] text-ink-2" title="The version these edits start from">
              {panel.id} · {file.split("-")[0]}
            </span>
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void apply()} loading={saving} disabled={!editing || !pending.length} title="Save as a new version and use it">
              Apply{pending.length ? <span className="num opacity-70">{pending.length}</span> : null}
            </Button>
          </div>
        </div>

        {editing && (
          <ContextBar>
            {adj ? (
              <>
                <span className="text-[12.5px] text-ink-2">{selEmpty ? "Whole picture" : "Selection only"}</span>
                <Mini label="Brightness" v={adj.b} on={(b) => setAdj({ ...adj, b })} />
                <Mini label="Contrast" v={adj.c} on={(c) => setAdj({ ...adj, c })} />
                <Mini label="Saturation" v={adj.s} on={(s) => setAdj({ ...adj, s })} />
                <Button size="sm" variant="ghost" onClick={() => setAdj({ b: 1, c: 1, s: 1 })}>
                  Reset
                </Button>
                <Button size="sm" variant="primary" onClick={applyAdjust}>
                  Done
                </Button>
              </>
            ) : floats.length ? (
              <>
                <Hint>Drag to move, corners to scale, the top dot to rotate (Shift snaps).</Hint>
                <Button size="sm" variant="ghost" icon={<FlipHorizontal size={13} />} onClick={() => activeFloat != null && patchFloat(activeFloat, { flipH: !floats.find((f) => f.id === activeFloat)?.flipH })}>
                  Flip
                </Button>
                {floats.length > 1 && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => reorder(1)}>
                      Forward
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => reorder(-1)}>
                      Back
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost" icon={<ArrowCounterClockwise size={13} />} onClick={putBack}>
                  Put back
                </Button>
                <Button size="sm" variant="secondary" onClick={drop} trailing={<Kbd>↵</Kbd>}>
                  Drop
                </Button>
              </>
            ) : tool === "crop" ? (
              <>
                <Hint>{crop ? "Drag again to redraw the frame." : "Drag over the picture to frame what to keep."}</Hint>
                {crop && (
                  <Button size="sm" variant="primary" onClick={applyCrop} trailing={<Kbd>↵</Kbd>}>
                    Crop
                  </Button>
                )}
              </>
            ) : (
              <>
                {tool === "select" && (
                  <>
                    <Segmented
                      size="sm"
                      value={method}
                      onChange={setMethod}
                      options={[
                        { value: "object", label: "Object", title: "Finds people and things (Apple Vision)" },
                        { value: "color", label: "Colour", title: "Similar colours that touch the click" },
                      ]}
                    />
                    {method === "color" && <Mini label="Tolerance" v={tolerance} min={0.02} max={0.5} step={0.01} on={setTolerance} />}
                    <Hint>Click a thing. Shift adds, Option subtracts.</Hint>
                  </>
                )}
                {tool === "lasso" && <Hint>Draw around an area. Shift adds, Option subtracts.</Hint>}
                {tool === "brush" && (
                  <>
                    <Mini label="Size" v={brush} min={0.005} max={0.2} step={0.005} on={setBrush} fmt={(v) => `${Math.round(v * 200)}%`} />
                    <Hint>Paint to add. Hold Option to remove. [ and ] resize.</Hint>
                  </>
                )}
                {tool === "move" && <Hint>{selEmpty ? "Select something first, then drag it." : "Drag the selection to lift it."}</Hint>}
                {!selEmpty && (
                  <>
                    <span className="mx-1 h-5 w-px bg-line" />
                    <Button size="sm" variant="ghost" icon={<ArrowsOutCardinal size={13} />} onClick={() => (lift(), undefined)}>
                      Lift
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Eraser size={13} />} onClick={erase} title="Remove and fill from the surroundings (Delete)">
                      Erase
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => (record(), S.invert(sel.current), selChanged())}>
                      Invert
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => (record(), S.clear(sel.current), selChanged())}>
                      Clear
                    </Button>
                  </>
                )}
              </>
            )}
            {notice && <span className="text-[12.5px] text-warn">{notice}</span>}
          </ContextBar>
        )}
      </div>

      {/* ---- bottom: fix bar / progress / compare ------------------------------------------------- */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
        <AnimatePresence mode="popLayout" initial={false}>
          {phase.kind === "compare" ? (
            <Bar key="compare">
              <CompareBar
                slug={story.slug}
                pid={panel.id}
                phase={phase}
                onActive={(i) => setPhase({ ...phase, active: i })}
                onKeep={(f) => void keep(f)}
                onOriginal={() => setPhase({ kind: "edit" })}
                onAgain={() => lastModel.current && void runModel(lastModel.current.ops, lastModel.current.label)}
              />
            </Bar>
          ) : phase.kind === "running" ? (
            <Bar key="running">
              <div className="flex w-[min(640px,calc(100vw-48px))] flex-col gap-2 px-2 py-1.5">
                <div className="flex items-center gap-2 text-[13px]">
                  <Sparkle size={14} weight="fill" className="text-accent" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{phase.label}</span>
                    <span className="text-ink-2"> · {phase.queued ? "waiting for the model" : `painting ${phase.jobs.length} version${phase.jobs.length > 1 ? "s" : ""}`}</span>
                  </span>
                  <span className="num text-[12px] text-ink-2">{Math.round(phase.progress * 100)}%</span>
                </div>
                <Progress value={phase.progress} />
              </div>
            </Bar>
          ) : (
            <Bar key="fix">
              <div className="relative flex w-[min(760px,calc(100vw-48px))] flex-col gap-1.5 p-1">
                <AnimatePresence>
                  {cmdList.length > 0 && (
                    <motion.div
                      className="absolute right-0 bottom-full left-0 mb-2 max-h-[320px] overflow-y-auto rounded-[var(--radius-surface)] border border-line bg-paper p-1 shadow-[var(--shadow-float)]"
                      style={{ transformOrigin: "bottom center" }}
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.98 }}
                      transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
                      role="listbox"
                    >
                      {cmdList.map((c, i) => (
                        <button
                          key={c.name}
                          role="option"
                          aria-selected={i === cmdIdx}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            setText(`/${c.name}${c.args ? " " : ""}`);
                            if (!c.args) runCommand(`/${c.name}`);
                          }}
                          className={cx("flex w-full items-baseline gap-2 rounded-[var(--radius-control)] px-2 py-1.5 text-left text-[13px]", i === cmdIdx ? "bg-wash" : "hover:bg-wash")}
                        >
                          <span className="num font-medium">/{c.name}</span>
                          {c.args && <span className="num text-[12px] text-ink-3">{c.args}</span>}
                          <span className="ml-auto truncate text-[12px] text-ink-2">{c.desc}</span>
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (cmdList.length && !text.includes(" ") && cmdList[cmdIdx]) {
                      const c = cmdList[cmdIdx];
                      if (c.args) return setText(`/${c.name} `);
                      return runCommand(`/${c.name}`);
                    }
                    runCommand(text);
                  }}
                >
                  <Sparkle size={15} weight="fill" className="ml-2 shrink-0 text-accent" />
                  <input
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        if (text) setText("");
                        else e.currentTarget.blur();
                      } else if (cmdList.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                        e.preventDefault();
                        setCmdIdx((i) => (i + (e.key === "ArrowDown" ? 1 : cmdList.length - 1)) % cmdList.length);
                      } else if (cmdList.length && e.key === "Tab") {
                        e.preventDefault();
                        const c = cmdList[cmdIdx];
                        if (c) setText(`/${c.name}${c.args ? " " : ""}`);
                      }
                    }}
                    placeholder={placeholder}
                    aria-label="Describe a fix or type a command"
                    className="h-9 min-w-0 flex-1 bg-transparent px-1 text-[14px] text-ink outline-none placeholder:text-ink-3"
                  />
                  <Segmented size="sm" value={strength} onChange={setStrength} options={STRENGTHS} />
                  <Segmented size="sm" value={String(count)} onChange={(v) => setCount(Number(v))} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: <span className="num">{n}</span>, title: `${n} version${n > 1 ? "s" : ""}` }))} />
                  <Button type="submit" variant="primary" size="md" disabled={!text.trim()} icon={<Sparkle size={13} weight="fill" />}>
                    {text.startsWith("/") ? "Run" : "Fix"}
                  </Button>
                </form>
                <p className="flex items-center gap-1.5 px-2 pb-0.5 text-[12px] text-ink-2">
                  <span className={cx("size-1.5 rounded-full", scope === "selection" ? "bg-accent" : "bg-ink-3")} />
                  {scope === "selection" ? "Repaints only the selected area. The rest stays pixel for pixel." : "Reworks the whole picture, keeping the cast on model."}
                  <span className="ml-auto flex items-center gap-1 text-ink-3">
                    <Kbd>/</Kbd> commands <Kbd>⌘K</Kbd>
                  </span>
                </p>
              </div>
            </Bar>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

// ---- pieces ----------------------------------------------------------------------------------------

function FloatPiece({ f, k, active, onDrag }: { f: Float; k: number; active: boolean; onDrag: (e: React.PointerEvent, kind: "move" | "scale" | "rotate") => void }) {
  const cx0 = (f.box.x + f.box.w / 2 + f.dx) * k;
  const cy0 = (f.box.y + f.box.h / 2 + f.dy) * k;
  const w = f.box.w * k;
  const h = f.box.h * k;
  const fw = w * f.scale;
  const fh = h * f.scale;
  return (
    <>
      <img
        src={f.cut}
        alt=""
        draggable={false}
        className="absolute touch-none drop-shadow-[0_6px_14px_rgb(23_23_26/0.22)]"
        style={{ left: cx0 - w / 2, top: cy0 - h / 2, width: w, height: h, transform: `rotate(${f.rotate}deg) scale(${f.scale * (f.flipH ? -1 : 1)}, ${f.scale * (f.flipV ? -1 : 1)})`, cursor: "move" }}
        onPointerDown={(e) => onDrag(e, "move")}
      />
      <div className="pointer-events-none absolute" style={{ left: cx0 - fw / 2, top: cy0 - fh / 2, width: fw, height: fh, transform: `rotate(${f.rotate}deg)` }}>
        <div className={cx("absolute inset-0 border", active ? "border-accent" : "border-ink/40 border-dashed")} />
        {active && (
          <>
            <span className="absolute left-1/2 -top-6 h-6 w-px bg-accent" />
            <Handle style={{ left: "50%", top: -26 }} cursor="grab" onDown={(e) => onDrag(e, "rotate")} round />
            {(
              [
                [0, 0, "nwse-resize"],
                [1, 0, "nesw-resize"],
                [0, 1, "nesw-resize"],
                [1, 1, "nwse-resize"],
              ] as const
            ).map(([x, y, c]) => (
              <Handle key={`${x}${y}`} style={{ left: `${x * 100}%`, top: `${y * 100}%` }} cursor={c} onDown={(e) => onDrag(e, "scale")} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

function Handle({ style, cursor, onDown, round }: { style: React.CSSProperties; cursor: string; onDown: (e: React.PointerEvent) => void; round?: boolean }) {
  return (
    <span
      className="pointer-events-auto absolute flex size-5 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center"
      style={{ ...style, cursor }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onDown(e);
      }}
    >
      <span className={cx("size-2.5 border border-accent bg-paper shadow-[0_1px_2px_rgb(23_23_26/0.2)]", round ? "rounded-full" : "rounded-[2px]")} />
    </span>
  );
}

function CropFrame({ c }: { c: Box }) {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute border border-paper shadow-[0_0_0_9999px_rgb(23_23_26/0.45)]" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}>
        <div className="absolute inset-0 border border-dashed border-ink/50" />
      </div>
    </div>
  );
}

function RunningVeil({ phase }: { phase: Extract<Phase, { kind: "running" }> }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-end justify-center bg-paper/25 pb-4">
      <span className="material flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[12.5px] shadow-[var(--shadow-float)]">
        <Spinner className="text-accent" />
        {phase.queued ? "Waiting for the model" : "Painting"}
      </span>
    </div>
  );
}

function CompareBar({
  slug,
  pid,
  phase,
  onActive,
  onKeep,
  onOriginal,
  onAgain,
}: {
  slug: string;
  pid: string;
  phase: Extract<Phase, { kind: "compare" }>;
  onActive: (i: number) => void;
  onKeep: (file: string) => void;
  onOriginal: () => void;
  onAgain: () => void;
}) {
  const active = phase.candidates[phase.active];
  const items = [{ file: phase.source, label: "Before", i: -1 }, ...phase.candidates.map((f, i) => ({ file: f, label: String(i + 1), i }))];
  return (
    <div className="flex items-center gap-3 p-1.5">
      <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Compare">
        {items.map((it) => (
          <button
            key={it.file + it.i}
            role="radio"
            aria-checked={phase.active === it.i}
            onPointerDown={() => onActive(it.i)}
            className={cx(
              "pressable relative h-[64px] w-[48px] overflow-hidden rounded-[6px] bg-wash",
              phase.active === it.i ? "ring-2 ring-accent ring-offset-2 ring-offset-paper" : "ring-1 ring-line hover:ring-line-2",
            )}
            title={it.i < 0 ? "Before the fix" : it.file}
          >
            <img src={versionUrl(slug, pid, it.file)} alt={it.label} draggable={false} className="size-full object-cover" />
            <span className="num absolute inset-x-0 bottom-0 bg-[rgb(23_23_26/0.55)] text-center text-[10px] text-paper">{it.label}</span>
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="max-w-[260px] truncate text-[13px] font-medium">{phase.label}</span>
        <span className="text-[12px] text-ink-2">Press Before to compare. Arrow keys switch.</span>
      </div>
      <div className="ml-2 flex items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={onAgain} icon={<ArrowClockwise size={13} />}>
          Try again
        </Button>
        <Button size="sm" variant="ghost" onClick={onOriginal} trailing={<Kbd>esc</Kbd>}>
          Keep original
        </Button>
        <Button size="sm" variant="primary" disabled={phase.active < 0 || !active} onClick={() => active && onKeep(active)} trailing={<Kbd>↵</Kbd>}>
          Use this one
        </Button>
      </div>
    </div>
  );
}

function ExtendMenu({ disabled, onExtend }: { disabled: boolean; onExtend: (side: Side, amount: number) => void }) {
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState("0.2");
  const sides: { s: Side; icon: React.ReactNode; label: string }[] = [
    { s: "up", icon: <ArrowLineUp size={15} />, label: "Up" },
    { s: "down", icon: <ArrowLineDown size={15} />, label: "Down" },
    { s: "left", icon: <ArrowLineLeft size={15} />, label: "Left" },
    { s: "right", icon: <ArrowLineRight size={15} />, label: "Right" },
  ];
  return (
    <div className="relative">
      <IconButton label="Extend the canvas" active={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <ArrowsOut size={16} />
      </IconButton>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-30" onPointerDown={() => setOpen(false)} />
            <motion.div
              className="absolute top-10 left-1/2 z-40 flex w-60 -translate-x-1/2 flex-col gap-2 rounded-[var(--radius-surface)] border border-line bg-paper p-2.5 shadow-[var(--shadow-float)]"
              style={{ transformOrigin: "top center" }}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
            >
              <p className="text-[12.5px] text-ink-2">Grow the picture and paint what is out of frame. Text in the fix bar guides it.</p>
              <Segmented size="sm" value={amt} onChange={setAmt} options={["0.1", "0.2", "0.3", "0.5"].map((v) => ({ value: v, label: <span className="num">{Math.round(Number(v) * 100)}%</span> }))} />
              <div className="grid grid-cols-4 gap-1">
                {sides.map((x) => (
                  <button
                    key={x.s}
                    className="pressable flex h-12 flex-col items-center justify-center gap-0.5 rounded-[var(--radius-control)] text-[11.5px] text-ink-2 hover:bg-wash hover:text-ink"
                    onClick={() => {
                      setOpen(false);
                      onExtend(x.s, Number(amt));
                    }}
                  >
                    {x.icon}
                    {x.label}
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function Bar({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="material pointer-events-auto rounded-[var(--radius-surface)] border border-line shadow-[var(--shadow-float)]"
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, transform: "translateY(0px)" }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" }}
      transition={spring}
    >
      {children}
    </motion.div>
  );
}

function ContextBar({ children }: { children: React.ReactNode }) {
  return <div className="material pointer-events-auto flex min-h-10 flex-wrap items-center gap-2 rounded-[var(--radius-surface)] border border-line px-2.5 py-1 shadow-[var(--shadow-float)]">{children}</div>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span className="text-[12.5px] text-ink-2">{children}</span>;
}

function ToolBtn({ on, label, onClick, disabled, children }: { on: boolean; label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <IconButton label={label} active={on} onPointerDown={onClick} disabled={disabled}>
      {children}
    </IconButton>
  );
}

function Mini({ label, v, on, min = 0.5, max = 1.5, step = 0.01, fmt }: { label: string; v: number; on: (v: number) => void; min?: number; max?: number; step?: number; fmt?: (v: number) => string }) {
  return (
    <label className="flex items-center gap-2 text-[12.5px]">
      <span className="text-ink-2">{label}</span>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => on(Number(e.target.value))} className="w-24 accent-[var(--color-accent)]" />
      <span className="num w-9 text-[11.5px] text-ink-2">{fmt ? fmt(v) : v.toFixed(2)}</span>
    </label>
  );
}
