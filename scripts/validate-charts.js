// Sync/integrity gate for every song in the manifest — run after any score or
// chart change (`npm run validate:charts`); the Stop hook also runs it before
// auto-pushing. Fails loudly (non-zero exit) on any violation.
//
// Since charts are now generated FROM score files (the same files the in-game
// piano plays), this can assert much stronger guarantees than the old
// audio-duration probe:
//   1. chart meta.songLengthMs === score meta.durationMs (tight tolerance)
//   2. every chart note's time is an EXACT onset in the score — i.e. every
//      note you're asked to hit is a note the piano actually plays. Skipped
//      for charts stamped meta.quantized (grid-snapped on purpose).
//   3. structural sanity: lanes 0-7, notes sorted by time, unique ids,
//      note times within [0, songLengthMs].
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const LENGTH_TOLERANCE_MS = 10;

function resolvePublicPath(url) {
  return path.join(publicDir, url.replace(/^\//, ""));
}

function loadJson(url) {
  return JSON.parse(readFileSync(resolvePublicPath(url), "utf8"));
}

const manifest = loadJson("/songs.json");
let failed = false;

function fail(label, message) {
  console.error(`FAIL [${label}] ${message}`);
  failed = true;
}

for (const song of manifest) {
  let score;
  try {
    score = loadJson(song.scoreUrl);
  } catch (err) {
    fail(song.id, `could not read score ${song.scoreUrl}: ${err.message}`);
    continue;
  }

  const scoreOnsets = new Set(score.notes.map((n) => n.time));

  for (const [difficulty, chartUrl] of Object.entries(song.charts)) {
    const label = `${song.id}/${difficulty}`;
    let chart;
    try {
      chart = loadJson(chartUrl);
    } catch (err) {
      fail(label, `could not read chart ${chartUrl}: ${err.message}`);
      continue;
    }

    const problems = [];

    // 1. Length agreement with the score.
    const lengthDiff = Math.abs(chart.meta.songLengthMs - score.meta.durationMs);
    if (lengthDiff > LENGTH_TOLERANCE_MS) {
      problems.push(
        `songLengthMs=${chart.meta.songLengthMs} vs score durationMs=${score.meta.durationMs} (diff ${lengthDiff}ms > ${LENGTH_TOLERANCE_MS}ms)`
      );
    }

    // 2. Every chart note time must be an exact score onset (unless quantized).
    if (chart.meta.quantized) {
      console.log(`NOTE [${label}] chart is quantized — skipping exact-onset check`);
    } else {
      const orphaned = chart.notes.filter((n) => !scoreOnsets.has(n.time));
      if (orphaned.length > 0) {
        problems.push(
          `${orphaned.length} note(s) whose time matches no score onset ` +
            `(first: id=${orphaned[0].id} time=${orphaned[0].time})`
        );
      }
    }

    // 3. Structural sanity.
    const ids = new Set();
    let prevTime = -Infinity;
    for (const note of chart.notes) {
      if (note.x < 0 || note.x > 7) problems.push(`note ${note.id}: lane ${note.x} out of range 0-7`);
      if (note.time < prevTime) problems.push(`note ${note.id}: notes not sorted by time`);
      if (note.time < 0 || note.time > chart.meta.songLengthMs)
        problems.push(`note ${note.id}: time ${note.time} outside [0, ${chart.meta.songLengthMs}]`);
      if (ids.has(note.id)) problems.push(`duplicate note id ${note.id}`);
      ids.add(note.id);
      prevTime = note.time;
      if (problems.length > 5) break; // enough to diagnose; don't flood
    }

    if (problems.length > 0) {
      for (const p of problems) fail(label, p);
    } else {
      console.log(
        `PASS [${label}] ${chart.notes.length} notes, length=${chart.meta.songLengthMs}ms, all onsets in score`
      );
    }
  }
}

if (failed) {
  console.error("\nOne or more songs failed validation.");
  process.exit(1);
}
console.log("\nAll songs passed validation.");
