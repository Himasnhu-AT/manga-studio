import { useEffect, useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { useConnected } from "../lib/live";
import { Button, Spinner } from "./kit";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface BackendStatus {
  url: string;
  up: boolean;
  spawned: boolean;
  root: string;
  log: string;
  error: string | null;
}

async function tauri<T>(cmd: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd);
}

/** Shown only while the backend is unreachable. In the desktop app the shell starts it for us. */
export function BackendBanner() {
  const connected = useConnected();
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [since] = useState(() => Date.now());
  const [, tick] = useState(0);

  useEffect(() => {
    if (connected || !inTauri) return;
    const t = window.setInterval(() => {
      void tauri<BackendStatus>("backend_status").then(setStatus).catch(() => {});
      tick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(t);
  }, [connected]);

  if (connected) return null;

  if (!inTauri) {
    return (
      <div className="border-b border-line bg-[#fbf1df] px-4 py-1.5 text-center text-[12.5px] text-warn">
        Waiting for the studio backend on 127.0.0.1:7860. Start it with <code className="num">uv run studio serve</code>.
      </div>
    );
  }

  const slow = Date.now() - since > 20000;
  return (
    <div className="flex items-center justify-center gap-3 border-b border-line bg-paper px-4 py-1.5 text-[12.5px] text-ink-2">
      {status?.error ? (
        <span className="text-err">{status.error}</span>
      ) : (
        <>
          <Spinner className="size-3" />
          <span>{slow ? "The backend is taking a while. Its log is at " : "Starting the studio backend"}</span>
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
