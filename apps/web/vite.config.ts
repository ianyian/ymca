import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A monotonically increasing build id (ms timestamp). It is baked into the
// bundle (__BUILD_ID__) AND written to version.json, so a running client can
// detect when a newer build has been deployed and reload itself — this is what
// stops phones/desktops from getting stuck on a stale cached bundle after a
// deploy.
const buildId = Date.now().toString();

export default defineConfig({
  base: "/ymca/",
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [
    react(),
    {
      name: "emit-version-json",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({ id: buildId }),
        });
      },
    },
  ],
  server: {
    port: 5173,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
