import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During `vite dev` there is no serverless runtime for /api, so proxy those
// calls to a locally running `vercel dev` (port 3000) if you use one.
// In production on Vercel, /api is served by the function in /api/tryon.ts.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
