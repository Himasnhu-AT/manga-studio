import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backend = process.env.STUDIO_URL ?? "http://127.0.0.1:7860";

// Tauri expects a fixed port; the backend API is proxied so dev and `studio serve` share one origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/files": { target: backend, changeOrigin: true },
    },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "safari16", outDir: "dist", emptyOutDir: true },
});
