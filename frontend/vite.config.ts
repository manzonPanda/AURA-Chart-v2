import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Hono backend runs on :8787. During development Vite proxies every /api
// request to it, so the browser never talks to IG directly and no CORS is
// needed in the UI. The /ws WebSocket is proxied too (ws probe).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/ws": {
        target: "http://localhost:8787",
        ws: true,
      },
    },
  },
});
