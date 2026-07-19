import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { wardrobeImportApi } from "./scripts/import-job-api.mjs";
import { responsiveImageApi } from "./scripts/responsive-image-api.mjs";
import { authMiddleware } from "./scripts/auth.mjs";

// Auth is a normal Vite plugin: middleware registered *before* the API plugins
// so unauthenticated requests are rejected before touching OpenAI keys or user
// data. It's a no-op unless AUTH_MODE is set (LOGIN_EMAIL + LOGIN_CODE).
function auth(env) {
  const middleware = authMiddleware({
    env,
    // Static assets and the login/logout endpoints are exempt.
    exemptPrefixes: ["/assets", "/icon.svg", "/manifest.webmanifest"],
  });
  return {
    name: "wardrobe-auth",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const allowedHosts = (env.ALLOWED_HOSTS || "terminal.local,localhost")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      host: "0.0.0.0",
      allowedHosts,
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    preview: {
      host: "0.0.0.0",
      port: Number(env.PORT || 4173),
      allowedHosts,
    },
    plugins: [react(), auth(env), responsiveImageApi(), wardrobeImportApi({ env })],
  };
});
