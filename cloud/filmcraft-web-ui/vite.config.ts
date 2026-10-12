import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for FilmCraft's web UI (M1.7). In `npm run dev` mode we
// forward `/api/v1/*` to the local axum server on :8080 so the browser
// can talk to it directly; in production the same paths are served by
// filmcraft-server from the same origin (no proxy needed).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
