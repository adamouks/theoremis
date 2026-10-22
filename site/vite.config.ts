import { defineConfig } from "vite";

// theoremis.com: a static site built from index.html.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 1430,
  },
});
