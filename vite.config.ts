import { defineConfig } from "vite";

// Base is relative so the build drops cleanly into a VIVERSE HTML5/WebGL app bundle.
export default defineConfig({
  base: "./",
  server: {
    port: 5173
  },
  build: {
    outDir: "dist",
    target: "es2020"
  }
});
