// Score JSON -> playable chart JSON. Ports the staged density-thinning
// pipeline that parseMidi.js proved out, now operating on the score files
// parse-sheet.js emits (which carry hand data) instead of raw MIDI:
//
//   Stage 1 (always on)   velocity-threshold filter + short cluster-merge.
//                         Both merge stages below run PER HAND: a left-hand
//                         bass note and a right-hand melody note landing
//                         together is a deliberate two-hand chord (a core
//                         Deemo gameplay moment), never noise to collapse.
//   Stage 2 (togglable)   minimum inter-note spacing enforcement, per hand.
//   Stage 3 (togglable)   beat quantization onto meta.bpm's grid. OFF by
//                         default and discouraged: playback uses the SCORE's
//                         real timing, so quantizing the chart moves judged
//                         times away from what the piano audibly plays —
//                         grid feel at the cost of exact audio sync. Charts
//                         built with it are stamped meta.quantized so
//                         validate-charts.js knows to skip its exact-time check.
//   Stage 4 (opt-in)      target-density auto-tune — binary-searches the
//                         Stage 2 spacing to land total notes/sec in a band.
//
// Thinning only ever REMOVES notes (quantize aside); every surviving chart
// note keeps its exact score onset, so what you hit is exactly what you hear.
//
// Lane mapping: hand L -> lanes 0-3, hand R -> lanes 4-7; within each hand,
// pitch position scaled across that hand's full-score min-max range picks the
// lane inside the 4-lane block. Computed from the UNfiltered score so lane
// assignment stays stable across filter settings.
//
// Usage:
//   node scripts/generate-chart.js <score.json|scoreId> [flags]
// Flags:
//   --velocity-threshold=<0..1>       Stage 1: drop notes below this velocity. Default 0.25.
//   --cluster-ms=<ms>                 Stage 1: per-hand merge window (keep louder). Default 30. 0 disables.
//   --min-gap=<ms>                    Stage 2: per-hand minimum gap between hits. Default 150. 0 disables.
//   --quantize=<off|quarter|8th|16th> Stage 3: snap to meta.bpm's beat grid. Default off (see above).
//   --target=<min>-<max>              Stage 4: auto-tune --min-gap to land total notes/sec in this band.
//   --auto                            Shorthand for --target=2-4.
//   --out=<id>                        Output chart id. Defaults to the score's id.
//   --report-only                     Print the stage breakdown; don't write the chart.
//
// Output: public/charts/<id>.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const DEFAULT_VELOCITY_THRESHOLD = 0.25;
const DEFAULT_CLUSTER_MS = 30;
const DEFAULT_MIN_GAP_MS = 150;
const DEFAULT_QUANTIZE = "off";
const DEFAULT_TARGET_BAND = [2, 4];

const QUANTIZE_DIVISORS = { quarter: 1, "8th": 2, "16th": 4 };
const LANES_PER_HAND = 4;
const HAND_LANE_BASE = { L: 0, R: 4 }; // L -> 0-3, R -> 4-7 (CLAUDE.md convention)

// --- argument parsing --------------------------------------------------------
const rawArgs = process.argv.slice(2);
const positional = [];
const flags = {};
for (const arg of rawArgs) {
  if (arg.startsWith("--")) {
    const [key, value] = arg.slice(2).split(/=(.*)/s);
    flags[key] = value ?? true;
  } else {
    positional.push(arg);
  }
}
const [scoreArg] = positional;

if (!scoreArg) {
  console.error("Usage: node scripts/generate-chart.js <score.json|scoreId> [flags]");
  process.exit(1);
}

// Accept either a path to a score file or a bare id under public/scores/.
const scorePath = existsSync(path.resolve(scoreArg))
  ? path.resolve(scoreArg)
  : path.join(rootDir, "public", "scores", `${scoreArg}.json`);
if (!existsSync(scorePath)) {
  console.error(`Score not found: ${scoreArg} (looked for ${scorePath})`);
  process.exit(1);
}
const scoreId = path.basename(scorePath, ".json");
const outId = flags["out"] !== undefined ? String(flags["out"]) : scoreId;
const outputPath = path.join(rootDir, "public", "charts", `${outId}.json`);

const velocityThreshold =
  flags["velocity-threshold"] !== undefined ? Number(flags["velocity-threshold"]) : DEFAULT_VELOCITY_THRESHOLD;
const clusterMs = flags["cluster-ms"] !== undefined ? Number(flags["cluster-ms"]) : DEFAULT_CLUSTER_MS;
const minGapMs = flags["min-gap"] !== undefined ? Number(flags["min-gap"]) : DEFAULT_MIN_GAP_MS;
const quantize = flags["quantize"] !== undefined ? String(flags["quantize"]) : DEFAULT_QUANTIZE;
const reportOnly = Boolean(flags["report-only"]);

let targetBand = null;
if (flags["auto"] && flags["target"] === undefined) {
  targetBand = DEFAULT_TARGET_BAND;
} else if (flags["target"] !== undefined) {
  const [min, max] = String(flags["target"]).split("-").map(Number);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    console.error(`Invalid --target=${flags["target"]}; expected e.g. --target=2-4`);
    process.exit(1);
  }
  targetBand = [min, max];
}

if (quantize !== "off" && !(quantize in QUANTIZE_DIVISORS)) {
  console.error(`Invalid --quantize=${quantize}; expected off, quarter, 8th, or 16th`);
  process.exit(1);
}

// --- load score --------------------------------------------------------------

const score = JSON.parse(readFileSync(scorePath, "utf8"));
const songDurationSec = score.meta.durationMs / 1000;

// Lane assignment from the FULL score's per-hand pitch ranges (stable across
// any filter settings below).
const handRanges = {};
for (const hand of ["L", "R"]) {
  const pitches = score.notes.filter((n) => n.hand === hand).map((n) => n.midi);
  if (pitches.length > 0) {
    const min = Math.min(...pitches);
    const max = Math.max(...pitches);
    handRanges[hand] = { min, range: max - min || 1 };
  }
}

function noteToLane(note) {
  const base = HAND_LANE_BASE[note.hand];
  const range = handRanges[note.hand];
  const idx = Math.floor(((note.midi - range.min) / range.range) * LANES_PER_HAND);
  return base + Math.min(LANES_PER_HAND - 1, Math.max(0, idx));
}

function density(notes) {
  return notes.length / songDurationSec;
}

// Generic sequential greedy merge (same rule parseMidi.js used): walk notes in
// time order and whenever one falls within `windowMs` of the last KEPT note,
// keep whichever of the two is louder.
function mergeByWindow(notesSortedByTime, windowMs) {
  if (windowMs <= 0) return notesSortedByTime;
  const kept = [];
  for (const note of notesSortedByTime) {
    const last = kept[kept.length - 1];
    if (last && note.time - last.time < windowMs) {
      if (note.velocity > last.velocity) kept[kept.length - 1] = note;
    } else {
      kept.push(note);
    }
  }
  return kept;
}

// Per-hand wrapper: L and R are thinned independently so cross-hand chords
// survive, then re-interleaved by time.
function mergeByWindowPerHand(notes, windowMs) {
  if (windowMs <= 0) return notes;
  const merged = ["L", "R"].flatMap((hand) => mergeByWindow(notes.filter((n) => n.hand === hand), windowMs));
  return merged.sort((a, b) => a.time - b.time);
}

// Stage 3: snap onto meta.bpm's fixed grid. (Score files carry a single bpm;
// parse-sheet.js already resolved any mid-piece tempo changes into absolute
// ms, so a piece with real tempo changes should simply not use --quantize.)
function quantizeNotes(notes, subdivision) {
  const stepMs = 60000 / score.meta.bpm / QUANTIZE_DIVISORS[subdivision];
  const snapped = notes.map((n) => ({ ...n, time: Math.round(n.time / stepMs) * stepMs }));
  snapped.sort((a, b) => a.time - b.time);
  // Same-grid-point collisions become exact ties; a 1ms per-hand window
  // catches only true ties (stepMs is always far larger than 1ms).
  return mergeByWindowPerHand(snapped, 1);
}

// Stage 4: binary-search the per-hand min-gap so TOTAL notes/sec lands inside
// the band. Monotonic: bigger gap -> fewer notes.
function autoTuneMinGap(notes, [targetMin, targetMax]) {
  let lo = 0;
  let hi = 5000;
  let best = { minGapMs: 0, notes, notesPerSec: density(notes) };
  for (let i = 0; i < 40 && hi - lo > 1; i++) {
    const mid = (lo + hi) / 2;
    const merged = mergeByWindowPerHand(notes, mid);
    const notesPerSec = density(merged);
    best = { minGapMs: mid, notes: merged, notesPerSec };
    if (notesPerSec >= targetMin && notesPerSec <= targetMax) break;
    if (notesPerSec > targetMax) lo = mid; // too dense -> need a bigger gap
    else hi = mid; // too sparse -> need a smaller gap
  }
  const roundedGap = Math.round(best.minGapMs / 5) * 5;
  const finalNotes = mergeByWindowPerHand(notes, roundedGap);
  return { minGapMs: roundedGap, notes: finalNotes, notesPerSec: density(finalNotes) };
}

// --- pipeline ------------------------------------------------------------

function report(label, notes) {
  console.log(`  ${label}: ${notes.length} notes, ${density(notes).toFixed(2)} notes/sec`);
}

const sorted = [...score.notes].sort((a, b) => a.time - b.time);
console.log(
  `Score ${scoreId}: ${sorted.length} notes, ${density(sorted).toFixed(2)} notes/sec, ${songDurationSec.toFixed(1)}s`
);

console.log(`\nStage 1 — velocity filter (>= ${velocityThreshold}) + per-hand cluster-merge (< ${clusterMs}ms):`);
const afterVelocity = sorted.filter((n) => n.velocity >= velocityThreshold);
report("after velocity filter", afterVelocity);
const afterCluster = mergeByWindowPerHand(afterVelocity, clusterMs);
report("after cluster-merge", afterCluster);

let working = afterCluster;

// Stage 3 before min-gap (if enabled), so spacing operates on the snapped grid.
if (quantize !== "off") {
  console.log(`\nStage 3 — beat quantization (${quantize} grid @ ${score.meta.bpm} bpm):`);
  console.log("  NOTE: quantized chart times no longer match score playback times exactly.");
  working = quantizeNotes(working, quantize);
  report("after quantize", working);
}

let finalMinGapMs = minGapMs;
if (targetBand) {
  console.log(`\nStage 4 — auto-tuning per-hand min-gap to land in [${targetBand[0]}, ${targetBand[1]}] notes/sec:`);
  const beforeAuto = density(working);
  if (beforeAuto < targetBand[0]) {
    console.log(
      `  WARNING: already at ${beforeAuto.toFixed(2)} notes/sec before any spacing filter — ` +
        `below the target band. Thinning can only remove notes; loosen --velocity-threshold ` +
        `or --cluster-ms to retain more, or lower --target.`
    );
    finalMinGapMs = 0;
  } else {
    const tuned = autoTuneMinGap(working, targetBand);
    finalMinGapMs = tuned.minGapMs;
    working = tuned.notes;
    console.log(`  converged min-gap: ${finalMinGapMs}ms`);
  }
  report("after auto-tuned min-gap", working);
} else if (minGapMs > 0) {
  console.log(`\nStage 2 — per-hand minimum spacing (${minGapMs}ms):`);
  working = mergeByWindowPerHand(working, minGapMs);
  report("after min-gap", working);
}

const perHand = working.reduce((acc, n) => ((acc[n.hand] = (acc[n.hand] ?? 0) + 1), acc), {});
console.log(
  `\nFinal: ${working.length} notes (L: ${perHand.L ?? 0}, R: ${perHand.R ?? 0}), ` +
    `${density(working).toFixed(2)} notes/sec (score was ${density(sorted).toFixed(2)})`
);

if (reportOnly) {
  console.log("\n--report-only set: chart file not written.");
  process.exit(0);
}

const notes = working
  .map((note, i) => ({
    id: `n${i + 1}`,
    time: Math.round(note.time),
    x: noteToLane(note),
    type: "tap"
  }))
  .sort((a, b) => a.time - b.time);

const chart = {
  meta: {
    title: score.meta.title,
    bpm: score.meta.bpm,
    songLengthMs: score.meta.durationMs,
    ...(quantize !== "off" ? { quantized: true } : {})
  },
  notes
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(chart, null, 2) + "\n", { encoding: "utf8" });
console.log(`\nWrote ${notes.length} notes to ${path.relative(rootDir, outputPath)}`);
