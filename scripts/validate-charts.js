// Guards against the exact bug that prompted this script: a chart's
// meta.songLengthMs silently drifting away from its paired audio file's real
// duration (e.g. a placeholder chart covering 60s of a 187s track, or a
// chart re-timed against a different performance than the audio actually
// in the build). Run after any audio/chart change — `npm run validate:charts`.
// Fails loudly (non-zero exit) if any song is outside tolerance, instead of
// this surfacing later as "the game feels subtly wrong".
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFile } from "music-metadata";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const TOLERANCE_MS = 3000;

function resolvePublicPath(url) {
  return path.join(publicDir, url.replace(/^\//, ""));
}

async function main() {
  const manifest = JSON.parse(readFileSync(path.join(publicDir, "songs.json"), "utf8"));
  let failed = false;

  for (const song of manifest) {
    let audioDurationMs;
    try {
      const meta = await parseFile(resolvePublicPath(song.audioUrl));
      audioDurationMs = Math.round((meta.format.duration ?? 0) * 1000);
    } catch (err) {
      console.error(`FAIL [${song.id}] could not read audio file ${song.audioUrl}: ${err.message}`);
      failed = true;
      continue;
    }

    for (const [difficulty, chartUrl] of Object.entries(song.charts)) {
      let chart;
      try {
        chart = JSON.parse(readFileSync(resolvePublicPath(chartUrl), "utf8"));
      } catch (err) {
        console.error(`FAIL [${song.id}/${difficulty}] could not read chart ${chartUrl}: ${err.message}`);
        failed = true;
        continue;
      }

      const chartMs = chart.meta.songLengthMs;
      const diffMs = Math.abs(audioDurationMs - chartMs);
      const status = diffMs <= TOLERANCE_MS ? "PASS" : "FAIL";
      if (status === "FAIL") failed = true;

      console.log(
        `${status} [${song.id}/${difficulty}] audio=${audioDurationMs}ms chart=${chartMs}ms ` +
          `diff=${diffMs}ms (tolerance ${TOLERANCE_MS}ms)`
      );
    }
  }

  if (failed) {
    console.error("\nOne or more songs failed duration validation.");
    process.exit(1);
  }
  console.log("\nAll songs passed duration validation.");
}

main().catch((err) => {
  console.error("Validation script crashed:", err);
  process.exit(1);
});
