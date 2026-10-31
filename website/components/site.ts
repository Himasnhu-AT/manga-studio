// Site-wide facts. Everything here comes from README.md and docs/ARCHITECTURE.md in the repo.
//
// SITE.url: set NEXT_PUBLIC_SITE_URL at build time to the real domain so OG/Twitter image URLs are absolute.
// SITE.repo: there is no public repo URL yet. Point it at the repo (or its README) once one exists.
export const SITE = {
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  repo: process.env.NEXT_PUBLIC_REPO_URL ?? "#",
  title: "Manga Studio: draw your story as manga, on your Mac",
  description:
    "A local desktop studio for manga and webtoons on Apple Silicon. Qwen-Image 2.1 draws the panels on your Mac, you letter and export, and your AI can drive it over MCP. Nothing leaves the machine.",
};
