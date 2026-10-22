import { defineConfig } from "vite";

// The landing page: a static site built from site/index.html.
export default defineConfig({
  root: "site",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 1430,
  },
});
