// App settings: AI connection, image model, MCP command for other clients.

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Api, type Settings as SettingsT } from "../lib/api";
import { useLive } from "../lib/live";
import { attempt, useApp } from "../lib/store";
import { Badge, Button, Field, Segmented } from "../ui/kit";
import { AiConnect } from "./app-ai";
import { CopyBlock, fmtBytes, sharedIntegrations, useOnce } from "./app-common";
import { mergeSettings, useModels } from "./Onboarding";

export function Settings() {
  const remote = useLive(() => Api.settings(), []);
  const ints = useOnce(() => sharedIntegrations());
  const sys = useLive(() => Api.system(), []);
  const models = useModels();
  const [draft, setDraft] = useState<SettingsT | null>(null);
  const [saving, setSaving] = useState(false);
  const setOnboarding = useApp((s) => s.setOnboarding);
  const base = useRef<string>("");

  useEffect(() => {
    if (remote.data && draft === null) {
      const m = mergeSettings(remote.data);
      base.current = JSON.stringify(m);
      setDraft(m);
    }
  }, [remote.data, draft]);

  if (!draft) {
    return (
      <div className="mx-auto flex max-w-[680px] flex-col gap-4 px-8 pt-10">
        <div className="skeleton h-8 w-40" />
        <div className="skeleton h-40" />
        <div className="skeleton h-40" />
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== base.current;
  const save = async () => {
    setSaving(true);
    const r = await attempt(() => Api.putSettings(draft), "Settings saved");
    setSaving(false);
    if (r) {
      const m = mergeSettings(r);
      base.current = JSON.stringify(m);
      setDraft(m);
    }
  };

  const ram = sys.data?.ram_gb;
  const mcpJson = ints.data ? JSON.stringify(ints.data.mcp.json, null, 2) : "";

  return (
    <div className="mx-auto w-full max-w-[680px] px-8 pt-10 pb-24">
      <div className="mb-8 flex items-end justify-between gap-4">
        <h1 className="type-display">Settings</h1>
        <Button variant="ghost" icon={<ArrowCounterClockwise size={14} />} onClick={() => setOnboarding(true)}>
          Run setup again
        </Button>
      </div>

      <div className="flex flex-col gap-12">
        <Group title="AI connection" body="The AI that writes prompts and runs pipeline stages. Ollama and Just me work offline without an agent.">
          <AiConnect settings={draft} onChange={setDraft} />
          <Field label="Pipeline stages use" hint="Agent waits for Claude Code or Codex to pick up each stage. Heuristic splits text with simple rules.">
            {() => (
              <Segmented
                  className="self-start"
                value={draft.llm.provider}
                onChange={(provider) => setDraft({ ...draft, llm: { ...draft.llm, provider } })}
                options={[
                  { value: "agent", label: "Agent" },
                  { value: "ollama", label: "Ollama" },
                  { value: "heuristic", label: "Heuristic" },
                ]}
              />
            )}
          </Field>
        </Group>

        <Group title="Image model" body="Runs locally through mflux. The model stays loaded between panels.">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Model">
              {() => (
                <Segmented
                  className="self-start"
                  value={draft.image.model}
                  onChange={(model) => setDraft({ ...draft, image: { ...draft.image, model } })}
                  options={[
                    { value: "qwen-image-2.1-turbo", label: "Turbo" },
                    { value: "qwen-image-2.1", label: "Base" },
                  ]}
                />
              )}
            </Field>
            <Field label="Quantize" hint={ram ? (ram >= 32 ? "This Mac has room for 6 or 8-bit." : "On this Mac, keep 4-bit.") : "4-bit fits a 24 GB Mac."}>
              {() => (
                <Segmented
                  className="self-start"
                  value={String(draft.image.quantize)}
                  onChange={(q) => setDraft({ ...draft, image: { ...draft.image, quantize: Number(q) } })}
                  options={[
                    { value: "4", label: "4-bit" },
                    { value: "6", label: "6-bit" },
                    { value: "8", label: "8-bit" },
                  ]}
                />
              )}
            </Field>
          </div>
          <p className="text-[12.5px] text-ink-2">Turbo takes 8 steps, about a minute per panel. Base takes 40 steps and is worth it for finals only.</p>
          <div className="flex flex-col divide-y divide-line border-y border-line">
            {(models.data ?? []).map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 flex-col">
                  <span className="text-[13.5px] font-medium">{m.id}</span>
                  <span className="num truncate text-[12px] text-ink-2">{m.repo}</span>
                </div>
                {m.cached ? (
                  <Badge tone="ok">Downloaded</Badge>
                ) : m.downloading ? (
                  <span className="num text-[12px] text-ink-2">{m.progress ? `${fmtBytes(m.progress.done_bytes)} of ${fmtBytes(m.progress.total_bytes)}` : "Starting"}</span>
                ) : (
                  <Button size="sm" onClick={() => void attempt(() => Api.downloadModel(m.id))}>
                    Download {m.approx_gb} GB
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Group>

        <Group title="Other MCP clients" body="Any MCP client can drive the studio. Add this server to its config.">
          {mcpJson ? <CopyBlock text={mcpJson} /> : <div className="skeleton h-28" />}
        </Group>
      </div>

      {dirty && (
        <div className="material fixed inset-x-0 bottom-0 z-10 border-t border-line">
          <div className="mx-auto flex max-w-[680px] items-center justify-end gap-2 px-8 py-3">
            <span className="mr-auto text-[12.5px] text-ink-2">Unsaved changes</span>
            <Button
              variant="ghost"
              onClick={() => setDraft(JSON.parse(base.current) as SettingsT)}
            >
              Discard
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Group({ title, body, children }: { title: string; body?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="type-title">{title}</h2>
        {body && <p className="max-w-[60ch] text-[13px] text-ink-2">{body}</p>}
      </div>
      {children}
    </section>
  );
}
