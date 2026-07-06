import zip from "bestzip";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const zipPath = path.join(root, "viverse-prototype.zip");

if (!existsSync(distDir)) {
  console.error("dist/ not found — run `vite build` first.");
  process.exit(1);
}

if (existsSync(zipPath)) {
  rmSync(zipPath);
}

// cwd: distDir means "*" is relative to dist/, so index.html etc. land at the
// zip's root instead of being nested under a dist/ folder — what VIVERSE expects.
await zip({
  source: "*",
  destination: zipPath,
  cwd: distDir
});

console.log(`Bundled ${path.relative(root, distDir)} -> ${path.relative(root, zipPath)}`);
