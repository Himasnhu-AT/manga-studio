import { PressFigure } from "@/art/press/figure";
import { Command } from "@/components/command";
import { Illo, hasIllo } from "@/components/illo";
import { AppleLogo } from "@phosphor-icons/react/dist/ssr";
import { DOWNLOAD, SITE } from "@/components/site";

const STAGES = ["Analysis", "Script", "Layout", "Artwork", "Lettering", "QA"];

function Mark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6 shrink-0">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="#d2452f" />
      <path d="M12 6.2c-3.6 0-6.3 2.1-6.3 4.8 0 1.7 1 3.1 2.6 4l-.6 2.8 3-2.2c.4.1.9.1 1.3.1 3.6 0 6.3-2.1 6.3-4.8S15.6 6.2 12 6.2Z" fill="#fcfcfb" />
    </svg>
  );
}

// The notarized DMG from the latest GitHub release, with the version and what it runs on.
function DownloadButton({ className = "" }: { className?: string }) {
  return (
    <a className={`btn btn-primary ${className}`} href={DOWNLOAD.mac} aria-label={`Download Manga Studio ${DOWNLOAD.version} for Mac (DMG)`}>
      <AppleLogo size={17} weight="fill" aria-hidden="true" className="-mt-px" />
      Download for Mac
    </a>
  );
}

function DownloadMeta({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[13.5px] text-ink-3 ${className}`}>
      Version {DOWNLOAD.version} · {DOWNLOAD.requirements} ·{" "}
      <a className="link whitespace-nowrap underline decoration-line-2 underline-offset-4 hover:decoration-ink-3" href={DOWNLOAD.releases}>
        All releases
      </a>
    </p>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-20 border-b border-line/70 bg-paper/90 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-6 px-5 sm:px-8" aria-label="Main">
        <a href="#top" className="flex items-center gap-2.5" aria-label="Manga Studio, back to top">
          <Mark />
          <span className="hand text-[21px] leading-none">Manga Studio</span>
        </a>
        <div className="flex items-center gap-7">
          <ul className="hidden items-center gap-7 text-[14.5px] md:flex">
            <li>
              <a className="link" href="#make">
                Studio and Pipeline
              </a>
            </li>
            <li>
              <a className="link" href="#agents">
                AI agents
              </a>
            </li>
            <li>
              <a className="link" href="#mac">
                Requirements
              </a>
            </li>
          </ul>
          <a className="btn btn-primary h-9 px-3.5 text-[14px]" href={DOWNLOAD.mac} aria-label={`Download Manga Studio ${DOWNLOAD.version} for Mac`}>
            <AppleLogo size={15} weight="fill" aria-hidden="true" className="-mt-px" />
            Download
          </a>
        </div>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section id="top" className="mx-auto max-w-[1240px] px-5 pt-10 pb-16 sm:px-8 md:pt-14 lg:pb-24">
      <h1 className="hand rise max-w-[15ch] text-[44px] leading-[1.06] text-balance sm:text-[60px] lg:max-w-none lg:text-[68px]">
        Draw your story as manga,
        <br className="hidden lg:block" /> <span className="mark">on your Mac</span>.
      </h1>
      <div className="mt-8 grid items-center gap-10 lg:mt-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-12">
      <div className="max-w-[440px] lg:pb-16">
        <p className="rise max-w-[40ch] text-[18px] leading-[1.6] text-ink-2" style={{ ["--rise-delay" as string]: "60ms" }}>
          Paste a story. Qwen-Image draws the panels on your Mac, you letter and export. Nothing leaves the machine.
        </p>
        <div className="rise mt-8" style={{ ["--rise-delay" as string]: "120ms" }}>
          <div className="flex flex-wrap gap-3">
            <DownloadButton />
            <a className="btn btn-quiet" href="#start">
              Get started
            </a>
          </div>
          <DownloadMeta className="mt-3" />
        </div>
      </div>
      <div className="rise min-w-0" style={{ ["--rise-delay" as string]: "80ms" }}>
        <PressFigure />
      </div>
      </div>
    </section>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="mt-[11px] h-px w-3 shrink-0 bg-ink-3" />
      <span>{children}</span>
    </li>
  );
}

function Make() {
  const studioArt = hasIllo("welcome");
  const pipeArt = hasIllo("project");
  return (
    <section id="make" className="border-t border-line bg-canvas">
      <div className="mx-auto max-w-[1240px] px-5 py-20 sm:px-8 md:py-28">
        <h2 className="hand text-balance max-w-[18ch] text-[36px] leading-[1.1] sm:text-[44px]">Two ways to make a story</h2>
        <p className="mt-4 max-w-[58ch] text-[17px] text-ink-2">Draw it panel by panel, or hand over a chapter and fix what you want after. Both write the same project files.</p>

        <div className="mt-12 grid gap-5 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
          <article id="studio" className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-paper">
            {studioArt ? (
              <div className="border-b border-line px-8 pt-6">
                <Illo name="welcome" className="mx-auto max-w-[400px]" />
              </div>
            ) : null}
            <div className="p-7 sm:p-9">
              <h3 className="hand text-[28px] leading-tight">Studio</h3>
              <p className="mt-2 max-w-[52ch] text-ink-2">Lay out pages by hand. Every panel has layers, and lettering stays vector, so editing a line of dialogue never touches the art.</p>
              <ul className="mt-6 space-y-2.5 text-[15px] text-ink">
                <Bullet>Manga grids read right to left or left to right, with diagonal gutters, or a vertical webtoon scroll.</Bullet>
                <Bullet>Panel layers: background, character, screentone and FX, and an SVG lettering layer.</Bullet>
                <Bullet>Speech, shout, thought and caption bubbles, with horizontal or vertical text.</Bullet>
                <Bullet>A cast studio that keeps each face, outfit, palette, reference sheet and seed.</Bullet>
                <Bullet>An in-panel copilot for text to image, image to image and inpainting.</Bullet>
              </ul>
            </div>
          </article>

          <article id="pipeline" className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-paper">
            {pipeArt ? (
              <div className="border-b border-line px-8 pt-6">
                <Illo name="project" className="mx-auto max-w-[360px]" />
              </div>
            ) : null}
            <div className="flex flex-1 flex-col p-7 sm:p-9">
              <h3 className="hand text-[28px] leading-tight">Pipeline</h3>
              <p className="mt-2 max-w-[48ch] text-ink-2">Paste a chapter. Six stages turn it into lettered pages, and a coverage map makes sure no beat of the source is skipped.</p>
              <ol className="mt-6 flex flex-wrap gap-2" aria-label="The six stages, in order">
                {STAGES.map((stage, index) => (
                  <li key={stage} className="flex items-center gap-2 text-[14px]">
                    <span className={`rounded-full border px-3 py-1 ${index === 3 ? "border-accent/40 bg-accent-wash text-accent-ink" : "border-line-2 text-ink"}`}>{stage}</span>
                    {index < STAGES.length - 1 ? <span aria-hidden="true" className="h-px w-2.5 bg-line-2" /> : null}
                  </li>
                ))}
              </ol>
              <ul className="mt-6 space-y-2.5 text-[15px] text-ink">
                <Bullet>Bubbles are placed in quiet areas of each panel, away from faces.</Bullet>
                <Bullet>QA retries a panel up to 3 times, then flags it for you to fix.</Bullet>
                <Bullet>Language stages run on your agent, a local Ollama model, or a heuristic with no LLM.</Bullet>
                <Bullet>The finished pages open in Studio.</Bullet>
              </ul>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function ReadExport() {
  return (
    <section id="export" className="border-t border-line">
      <div className="mx-auto grid max-w-[1240px] gap-10 px-5 py-20 sm:px-8 md:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] md:py-24">
        <h2 className="hand text-balance text-[36px] leading-[1.1] sm:text-[44px]">Read it, then print it</h2>
        <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
          <div className="border-t border-ink pt-4">
            <dt className="font-medium">Reader</dt>
            <dd className="mt-1.5 text-ink-2">Page through right to left or left to right, or scroll a webtoon top to bottom.</dd>
          </div>
          <div className="border-t border-ink pt-4">
            <dt className="font-medium">Print PDF</dt>
            <dd className="mt-1.5 text-ink-2">B5 or A5 with bleed and margins, or a digital PDF.</dd>
          </div>
          <div className="border-t border-line-2 pt-4">
            <dt className="font-medium">Layered SVG</dt>
            <dd className="mt-1.5 text-ink-2">One file per page: raster panels under vector lettering you can still edit.</dd>
          </div>
          <div className="border-t border-line-2 pt-4">
            <dt className="font-medium">PNG and video</dt>
            <dd className="mt-1.5 text-ink-2">PNG pages or webtoon slices, and an mp4 of the panels with slow zooms and crossfades.</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function Agents() {
  const art = hasIllo("ai");
  return (
    <section id="agents" className="border-t border-line bg-canvas">
      <div className={`mx-auto grid max-w-[1240px] items-center gap-12 px-5 py-20 sm:px-8 md:py-28 ${art ? "lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" : ""}`}>
        {art ? <Illo name="ai" className="mx-auto max-w-[460px]" /> : null}
        <div className="min-w-0">
          <h2 className="hand text-balance max-w-[16ch] text-[36px] leading-[1.1] sm:text-[44px]">Let your AI hold the pen</h2>
          <p className="mt-4 max-w-[54ch] text-[17px] text-ink-2">
            Claude Code, Codex or any MCP client drives the studio through 24 tools: it writes prompts, draws panels, reads your notes and runs pipeline stages. You pick and star in the app.
          </p>
          <figure className="mt-8 max-w-[480px]">
            <blockquote className="relative rounded-[22px] border-[1.5px] border-ink bg-paper px-5 py-3.5 text-[16px] leading-snug">
              <span className="hand block text-[19px] font-normal text-balance">“make the character sheet for cheek-squish, 4 seeds”</span>
              <span aria-hidden="true" className="absolute -bottom-[9px] left-9 size-4 rotate-45 border-r-[1.5px] border-b-[1.5px] border-ink bg-paper" />
            </blockquote>
            <figcaption className="mt-4 pl-1 text-[13.5px] text-ink-3">An example request from the README.</figcaption>
          </figure>
          <div className="mt-8 space-y-3">
            <Command label="connect Claude Code" lines={["# from the repo folder", 'claude mcp add --scope user manga-studio -- uv --directory "$PWD" run studio mcp']} />
            <Command label="connect Codex" lines={['codex mcp add manga-studio -- uv --directory "$PWD" run studio mcp']} />
          </div>
          <p className="mt-4 text-[14px] text-ink-3">No agent? A local Ollama model can run the language stages instead.</p>
        </div>
      </div>
    </section>
  );
}

const SPECS = [
  { k: "Apple Silicon", v: "An M-series Mac on macOS 14 or later. MLX runs the model on the GPU and unified memory." },
  { k: "24 GB memory", v: "Recommended. It runs Turbo at 4-bit; with less, use smaller panels." },
  { k: "About 32 GB disk", v: "For Qwen-Image 2.1 Turbo, downloaded once from Hugging Face." },
  { k: "Your files, your Mac", v: "Stories, references and every generated version stay in the project folder." },
];

function Requirements() {
  const art = hasIllo("mac") || hasIllo("model");
  return (
    <section id="mac" className="border-t border-line">
      <div className={`mx-auto grid max-w-[1240px] items-center gap-12 px-5 py-20 sm:px-8 md:py-28 ${art ? "lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]" : ""}`}>
        <div className="min-w-0">
          <h2 className="hand text-balance max-w-[18ch] text-[36px] leading-[1.1] sm:text-[44px]">Runs on the Mac in front of you</h2>
          <p className="mt-4 max-w-[56ch] text-[17px] text-ink-2">Qwen-Image 2.1 draws every panel locally through mflux and MLX, kept loaded between jobs. No account and no upload.</p>
          <dl className="mt-10 grid gap-x-8 gap-y-7 sm:grid-cols-2">
            {SPECS.map((spec) => (
              <div key={spec.k}>
                <dt className="hand text-[22px] leading-tight">{spec.k}</dt>
                <dd className="mt-1.5 text-[15px] text-ink-2">{spec.v}</dd>
              </div>
            ))}
          </dl>
        </div>
        {art ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <Illo name="mac" className="mx-auto max-w-[400px]" />
            <Illo name="model" className="mx-auto max-w-[400px]" />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Start() {
  return (
    <section id="start" className="border-t border-line bg-canvas">
      <div className="mx-auto max-w-[860px] px-5 py-20 sm:px-8 md:py-28">
        <h2 className="hand text-balance text-[36px] leading-[1.1] sm:text-[44px]">Get started</h2>
        <p className="mt-4 max-w-[58ch] text-[17px] text-ink-2">
          The first launch checks the Mac, downloads the model if it isn&apos;t cached (about 32 GB, once), connects an AI and creates a first project.
        </p>

        <div className="mt-12 space-y-10">
          <div className="rounded-[14px] border border-line bg-paper p-6 sm:p-7">
            <h3 className="font-medium">Download the app</h3>
            <p className="mt-1 max-w-[60ch] text-[15px] text-ink-2">
              Signed and notarized by Apple. Open the DMG and drag Manga Studio to Applications. Its image engine runs on{" "}
              <a className="link underline decoration-line-2 underline-offset-4 hover:decoration-ink-3" href={DOWNLOAD.uv}>
                <code className="font-mono text-[14px]">uv</code>
              </a>
              , so install that first.
            </p>
            <div className="mt-4">
              <Command label="install uv" lines={["curl -LsSf https://astral.sh/uv/install.sh | sh"]} />
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3">
              <DownloadButton />
              <DownloadMeta />
            </div>
          </div>
          <div>
            <h3 className="font-medium">Or build it from source</h3>
            <p className="mt-1 text-[15px] text-ink-2">
              From a clone of the repo, with <code className="font-mono text-[14px]">uv</code> and <code className="font-mono text-[14px]">pnpm</code>. The app sets up its image engine on first launch.
            </p>
            <div className="mt-4">
              <Command label="install and open the app" lines={["uv sync", "cd app && pnpm install", "pnpm tauri dev"]} />
            </div>
          </div>
          <div>
            <h3 className="font-medium">Connect an agent</h3>
            <p className="mt-1 text-[15px] text-ink-2">Then ask it to run the pipeline for your story, or to draw a character sheet.</p>
            <div className="mt-4">
              <Command label="connect Claude Code" lines={['claude mcp add --scope user manga-studio -- uv --directory "$PWD" run studio mcp']} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-6 px-5 py-10 text-[14px] text-ink-2 sm:px-8 md:flex-row md:items-start md:justify-between">
        <div className="flex items-center gap-2.5">
          <Mark />
          <span className="hand text-[19px] leading-none text-ink">Manga Studio</span>
        </div>
        <div className="max-w-[60ch] space-y-2 md:text-right">
          <p>
            <a className="link underline decoration-line-2 underline-offset-4 hover:decoration-ink-3" href={SITE.repo}>
              Read the README
            </a>
          </p>
          <p className="text-ink-3">Qwen-Image 2.1 is under the Qwen Research License (research and evaluation use). Fonts: Geist and Kalam (SIL OFL).</p>
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <>
      <a href="#make" className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-30 focus:rounded-[8px] focus:bg-paper focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Nav />
      <main>
        <Hero />
        <Make />
        <ReadExport />
        <Agents />
        <Requirements />
        <Start />
      </main>
      <Footer />
    </>
  );
}
