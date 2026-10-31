// Site-wide facts. Everything here comes from README.md and docs/ARCHITECTURE.md in the repo.
//
// SITE.url: the production domain; NEXT_PUBLIC_SITE_URL overrides it (e.g. for a preview deploy).
// SITE.repo: the GitHub repo; NEXT_PUBLIC_REPO_URL overrides it.
const REPO = process.env.NEXT_PUBLIC_REPO_URL ?? "https://github.com/Himasnhu-AT/manga-studio";

export const SITE = {
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://mangastudio.marlstudio.com",
  repo: REPO,
  title: "Manga Studio: draw your story as manga, on your Mac",
  description:
    "A local desktop studio for manga and webtoons on Apple Silicon. Qwen-Image 2.1 draws the panels on your Mac, you letter and export, and your AI can drive it over MCP. Nothing leaves the machine.",
};

// The macOS download. The stable asset name is uploaded to every GitHub release by
// scripts/release-mac.sh, so /releases/latest/download/ always serves the newest notarized build.
// `version` must match app/src-tauri/tauri.conf.json (scripts/release-mac.sh checks it).
export const DOWNLOAD = {
  version: "0.2.0",
  mac: `${REPO}/releases/latest/download/Manga-Studio-macOS-arm64.dmg`,
  releases: `${REPO}/releases`,
  requirements: "Apple Silicon · macOS 14+",
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
};
