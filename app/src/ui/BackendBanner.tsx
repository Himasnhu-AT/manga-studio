import { useEffect, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { useConnected } from "../lib/live";
import { Button, Spinner } from "./kit";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** What the desktop shell knows about the backend (lib.rs `backend_status`). */
export interface BackendStatus {
  url: string;
  up: boolean;
  spawned: boolean;
  root: string;
  log: string;
  error: string | null;
  /** Installed .app (true) or a checkout (false). */
  installed: boolean;
  /** The installed app's first `uv sync` is running (installs Python packages; a minute or more). */
  first_run: boolean;
  /** Path of uv, null when it isn't installed. */
  uv: string | null;
  uv_install: string;
  stories: string | null;
  data: string;
  /** Set when the backend on the port belongs to another studio (it saves stories elsewhere). */
  foreign: string | null;
}

export async function tauri<T>(cmd: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd);
}

/** Poll the shell's backend status every `ms` while `active` (desktop app only; null in a browser). */
export function useBackendStatus(active = true, ms = 1000) {
  const [status, setStatus] = useState<BackendStatus | null>(null);
  useEffect(() => {
    if (!active || !inTauri) return;
    const poll = () => void tauri<BackendStatus>("backend_status").then(setStatus).catch(() => {});
    poll();
    const t = window.setInterval(poll, ms);
    return () => window.clearInterval(t);
  }, [active, ms]);
  return status;
}

/** Shown while the backend is unreachable, or (desktop app) when the backend on the port belongs to
 *  another studio. In the desktop app the shell starts the backend for us. */
export function BackendBanner() {
  const connected = useConnected();
  // Connected: still check now and then that the backend is ours (it saves to our stories folder).
  const status = useBackendStatus(true, connected ? 3000 : 1000);
  const [since] = useState(() => Date.now());
  const [, tick] = useState(0);
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    if (connected) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [connected]);

  if (status?.foreign) {
    // Block the app: working here would read and write another studio's stories.
    const retry = () => {
      setRetryError(null);
      void tauri("restart_backend").catch((e) => setRetryError(String(e)));
    };
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-paper/95 p-8">
        <div className="max-w-[520px] space-y-3 text-center text-[13px] text-ink-2">
          <div className="text-[15px] font-medium text-ink">Another Manga Studio is using the engine port</div>
          <p className="selectable">{status.foreign}</p>
          {retryError && retryError !== status.foreign && <p className="selectable text-err">{retryError}</p>}
          <Button size="sm" variant="ghost" icon={<ArrowClockwise size={13} />} onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (connected) return null;

  if (!inTauri) {
    return (
      <div className="border-b border-line bg-[#fbf1df] px-4 py-1.5 text-center text-[12.5px] text-warn">
        Waiting for the studio backend on 127.0.0.1:7860. Start it with <code className="num">uv run studio serve</code>.
      </div>
    );
  }

  // The first launch of the installed app installs the Python packages: give it minutes, not seconds.
  const slow = Date.now() - since > (status?.first_run ? 180000 : 20000);
  return (
    <div className="flex items-center justify-center gap-3 border-b border-line bg-paper px-4 py-1.5 text-[12.5px] text-ink-2">
      {status?.error ? (
        <span className="selectable text-err">{status.error}</span>
      ) : (
        <>
          <Spinner className="size-3" />
          <span>
            {slow
              ? "The image engine is taking a while to start. Its log is at "
              : status?.first_run
                ? "First launch: setting up the image engine. This takes a minute or two."
                : "Starting the image engine"}
          </span>
          {slow && status && <code className="num selectable text-ink">{status.log}</code>}
        </>
      )}
      {(status?.error || slow) && (
        <Button size="sm" variant="ghost" icon={<ArrowClockwise size={13} />} onClick={() => void tauri("restart_backend").catch(() => {})}>
          Restart
        </Button>
      )}
    </div>
  );
}
