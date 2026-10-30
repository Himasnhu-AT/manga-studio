import { AnimatePresence, motion } from "motion/react";
import { BookOpen, CaretLeft, FlowArrow, GearSix, PaintBrushBroad } from "@phosphor-icons/react";
import { useEffect } from "react";
import { Api, type Settings as SettingsT } from "./lib/api";
import { useLive } from "./lib/live";
import { useApp, type View } from "./lib/store";
import { IconButton, Segmented, Toasts, cx } from "./ui/kit";
import { EngineStatus } from "./ui/EngineStatus";
import { BackendBanner } from "./ui/BackendBanner";
import { Library } from "./views/Library";
import { Studio } from "./views/studio/Studio";
import { Pipeline } from "./views/Pipeline";
import { Reader } from "./views/Reader";
import { Settings } from "./views/Settings";
import { Onboarding } from "./views/Onboarding";

const PROJECT_VIEWS: { value: View; label: string; icon: React.ReactNode }[] = [
  { value: "studio", label: "Studio", icon: <PaintBrushBroad size={14} /> },
  { value: "pipeline", label: "Pipeline", icon: <FlowArrow size={14} /> },
  { value: "reader", label: "Reader", icon: <BookOpen size={14} /> },
];

export function App() {
  const { view, slug, go, onboarding, setOnboarding } = useApp();
  const settings = useLive<SettingsT>(() => Api.settings(), []);
  const story = useLive(slug && view !== "library" && view !== "settings" ? () => Api.story(slug) : null, [slug, view]);

  // First run: onboarding until the backend says we're set up.
  useEffect(() => {
    if (settings.data && !settings.data.onboarded) setOnboarding(true);
  }, [settings.data, setOnboarding]);

  const inProject = view === "studio" || view === "pipeline" || view === "reader";

  return (
    <div className="flex h-full flex-col">
      <header data-tauri-drag-region className="material relative z-20 flex h-12 shrink-0 items-center gap-3 border-b border-line pr-3 pl-[84px]">
        {/* pl clears the macOS traffic lights (titleBarStyle: Overlay) */}
        <div className="flex min-w-0 items-center gap-1.5" data-tauri-drag-region>
          {inProject ? (
            <>
              <IconButton label="All projects" size="sm" onClick={() => go("library")}>
                <CaretLeft size={15} />
              </IconButton>
              <span className="truncate text-[13px] font-semibold tracking-[-0.01em]">{story.data?.title ?? slug}</span>
            </>
          ) : (
            <span className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em]">
              <span className="inline-block size-3 rounded-[3px] bg-accent" aria-hidden />
              Manga Studio
            </span>
          )}
        </div>

        <div className="absolute left-1/2 -translate-x-1/2">
          {inProject && <Segmented size="sm" value={view} onChange={(v) => go(v)} options={PROJECT_VIEWS.map((o) => ({ value: o.value, label: <>{o.icon}{o.label}</> }))} />}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <EngineStatus />
          <IconButton label="Settings" size="sm" active={view === "settings"} onClick={() => go(view === "settings" ? "library" : "settings")}>
            <GearSix size={16} />
          </IconButton>
        </div>
      </header>

      <BackendBanner />

      <main className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view + (inProject ? slug : "")}
            className={cx("absolute inset-0", view === "studio" ? "overflow-hidden" : "overflow-y-auto")}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
          >
            {view === "library" && <Library />}
            {view === "settings" && <Settings />}
            {view === "studio" && slug && <Studio />}
            {view === "pipeline" && slug && <Pipeline />}
            {view === "reader" && slug && <Reader />}
          </motion.div>
        </AnimatePresence>
      </main>

      <AnimatePresence>{onboarding && <Onboarding onDone={() => { setOnboarding(false); void settings.reload(); }} />}</AnimatePresence>
      <Toasts />
    </div>
  );
}
