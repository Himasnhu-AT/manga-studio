import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { SITE } from "@/components/site";
import "./globals.css";

const geist = localFont({ src: "./fonts/Geist-Variable.woff2", variable: "--font-geist", weight: "100 900", display: "swap" });
const geistMono = localFont({ src: "./fonts/GeistMono-Variable.woff2", variable: "--font-geist-mono", weight: "100 900", display: "swap" });
const kalam = localFont({
  src: [
    { path: "./fonts/Kalam-400.woff2", weight: "400" },
    { path: "./fonts/Kalam-700.woff2", weight: "700" },
  ],
  variable: "--font-kalam",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: SITE.title,
  description: SITE.description,
  applicationName: "Manga Studio",
  keywords: ["manga", "webtoon", "comics", "Apple Silicon", "MLX", "Qwen-Image", "local AI", "MCP", "Claude Code"],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: SITE.title,
    description: SITE.description,
    siteName: "Manga Studio",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "An isometric drawing of a small pen plotter turning a story into a manga page." }],
  },
  twitter: { card: "summary_large_image", title: SITE.title, description: SITE.description, images: ["/og.png"] },
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = { themeColor: "#fcfcfb", colorScheme: "light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${kalam.variable}`}>
      <body>{children}</body>
    </html>
  );
}
