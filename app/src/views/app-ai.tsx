// "Connect an AI" controls, shared by onboarding and Settings.

import { CheckCircle, Cpu, Robot, TerminalWindow, User } from "@phosphor-icons/react";
import { useState } from "react";
import { Api, type Integrations, type Settings } from "../lib/api";
import { attempt } from "../lib/store";
import { Badge, Button, Field, Input } from "../ui/kit";
import { ChoiceCard, CopyBlock, Select, sharedIntegrations, useOnce } from "./app-common";

type Agent = Settings["agent"];

const providerFor: Record<Agent, Settings["llm"]["provider"]> = { claude: "agent", codex: "agent", ollama: "ollama", none: "heuristic" };

export const mcpCommand = (cli: "claude" | "codex", i?: Integrations) =>
  `${cli} mcp add manga-studio -- ${(i?.mcp.command ?? ["uv", "--directory", "<repo>", "run", "studio", "mcp"]).join(" ")}`;

export function AiConnect({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const ints = useOnce(() => sharedIntegrations());
  const i = ints.data;
  const [busy, setBusy] = useState<"claude" | "codex" | null>(null);

  const choose = (agent: Agent) => onChange({ ...settings, agent, llm: { ...settings.llm, provider: providerFor[agent] } });

  const connect = async (cli: "claude" | "codex") => {
    setBusy(cli);
    const r = await attempt(() => Api.connect(cli));
    setBusy(null);
    if (r && !r.ok) await attempt(() => Promise.reject(new Error(r.output || "The command failed.")));
    void sharedIntegrations(true).then(() => ints.reload());
  };

  const agentStatus = (k: "claude" | "codex") => {
    const s = i?.[k];
    if (!s) return <Checking />;
    if (s.connected) return <Badge tone="ok">Connected</Badge>;
    if (s.installed) return <Badge>Installed</Badge>;
    return <Badge tone="warn">Not found</Badge>;
  };

  const agentBody = (k: "claude" | "codex", name: string) => {
    const s = i?.[k];
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] text-ink-2">
          {name} drives the studio through the MCP bridge: it writes prompts, runs generations and works through pipeline stages. You review in this app.
        </p>
        <CopyBlock text={mcpCommand(k, i)} />
        {s?.connected ? (
          <p className="flex items-center gap-1.5 text-[12.5px] text-ok">
            <CheckCircle size={14} weight="fill" /> manga-studio is registered with {name}.
          </p>
        ) : s?.installed ? (
          <div>
            <Button size="sm" variant="primary" loading={busy === k} onClick={() => connect(k)}>
              Connect {name}
            </Button>
          </div>
        ) : (
          <p className="text-[12.5px] text-ink-2">Install {name}, then run the command above in a terminal.</p>
        )}
      </div>
    );
  };

  const models = i?.ollama.models ?? [];
  const opts = (cur: string) => {
    const list = models.map((m) => ({ value: m, label: m }));
    if (cur && !models.includes(cur)) list.unshift({ value: cur, label: `${cur} (not pulled)` });
    return list.length ? list : [{ value: "", label: "No models found" }];
  };

  return (
    <div role="radiogroup" className="flex flex-col gap-2.5">
      <ChoiceCard selected={settings.agent === "claude"} onSelect={() => choose("claude")} icon={<TerminalWindow size={17} />} title="Claude Code" body="Recommended. Writes prompts, checks every image, runs the pipeline." aside={agentStatus("claude")}>
        {agentBody("claude", "Claude Code")}
      </ChoiceCard>
      <ChoiceCard selected={settings.agent === "codex"} onSelect={() => choose("codex")} icon={<Robot size={17} />} title="Codex" body="Same MCP bridge, driven from the Codex CLI." aside={agentStatus("codex")}>
        {agentBody("codex", "Codex")}
      </ChoiceCard>
      <ChoiceCard
        selected={settings.agent === "ollama"}
        onSelect={() => choose("ollama")}
        icon={<Cpu size={17} />}
        title="Ollama"
        body="A local model runs the script and QA stages on its own."
        aside={i ? i.ollama.running ? <Badge tone="ok">Running</Badge> : i.ollama.installed ? <Badge tone="warn">Not running</Badge> : <Badge tone="warn">Not found</Badge> : <Checking />}
      >
        <div className="flex flex-col gap-3">
          {i && !i.ollama.running && (
            <p className="text-[12.5px] text-ink-2">
              Start it with <code className="num">ollama serve</code>, then pull a text model and a vision model, for example <code className="num">ollama pull qwen3:8b</code> and{" "}
              <code className="num">ollama pull qwen2.5vl:7b</code>.
            </p>
          )}
          <Field label="Server URL">{(id) => <Input id={id} value={settings.llm.ollama_url} onChange={(e) => onChange({ ...settings, llm: { ...settings.llm, ollama_url: e.target.value } })} />}</Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Text model" hint="Story analysis and script">
              {(id) => <Select id={id} value={settings.llm.text_model} onChange={(v) => onChange({ ...settings, llm: { ...settings.llm, text_model: v } })} options={opts(settings.llm.text_model)} />}
            </Field>
            <Field label="Vision model" hint="QA looks at each panel">
              {(id) => <Select id={id} value={settings.llm.vision_model} onChange={(v) => onChange({ ...settings, llm: { ...settings.llm, vision_model: v } })} options={opts(settings.llm.vision_model)} />}
            </Field>
          </div>
          <div>
            <Button size="sm" variant="ghost" onClick={() => void sharedIntegrations(true).then(() => ints.reload())}>
              Check again
            </Button>
          </div>
        </div>
      </ChoiceCard>
      <ChoiceCard selected={settings.agent === "none"} onSelect={() => choose("none")} icon={<User size={17} />} title="Just me" body="No AI. You write prompts in the Studio; the pipeline uses simple rules to split text into panels." />
    </div>
  );
}

function Checking() {
  return <span className="text-[11.5px] text-ink-3">Checking</span>;
}
