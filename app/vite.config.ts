import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { cpSync, existsSync } from "node:fs";
const host = process.env.TAURI_DEV_HOST;

/**
 * pdf.js loads its character maps, standard fonts, color profiles and image decoders at run
 * time. Copy them into public/pdfjs (ignored by git) so dev and the bundled app serve them.
 */
function pdfjsResources(): Plugin {
  return {
    name: "pdfjs-resources",
    config() {
      for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
        const target = new URL(`public/pdfjs/${dir}`, import.meta.url);
        const source = new URL(`node_modules/pdfjs-dist/${dir}`, import.meta.url);
        if (!existsSync(target)) cpSync(source, target, { recursive: true });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), pdfjsResources()],

  // The bundle ships inside the app and loads from disk, so its size costs no download.
  build: {
    chunkSizeWarningLimit: 1500,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
