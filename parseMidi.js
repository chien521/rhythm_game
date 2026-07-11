// Standalone CLI: converts a MIDI file into a ChartData JSON matching this
// game's public/charts/*.json schema ({ meta: { title, bpm, songLengthMs },
// notes: [{ id, time, x, type }] }). Not part of the built app — a one-off
// authoring tool, run with `node parseMidi.js <input.mid> [outputName] [title] [flags]`.
//
// A raw MIDI performance is far denser than a playable chart: every grace
// note, pedal-sustain artifact, and accompaniment voice becomes a "note",
// which reads as noise rather than rhythm. This script thins that down in
// stages, each one independently tunable so you can A/B them by ear:
//
//   Stage 1 (always on)   velocity-threshold filter + short cluster-merge
//                         — drops quiet accompaniment notes, then collapses
//                         near-simultaneous notes (chords, grace-note
//                         attacks) into a single hit.
//   Stage 2 (togglable)   minimum inter-note spacing enforcement — walks
//                         the remaining notes and enforces a floor on the
//                         gap between consecutive chart hits.
//   Stage 3 (togglable)   beat quantization — snaps note times onto the
//                         song's own beat grid (quarter/8th/16th), which
//                         collapses ornamental runs (trills, turns) onto
//                         the beat they decorate.
//   Stage 4 (opt-in)      target-density auto-tune — binary-searches the
//                         Stage 2 spacing value to land notes/sec inside a
//                         requested band, given whatever Stage 3 setting
//                         you've chosen.
//
// Usage:
//   node parseMidi.js input.mid
//   node parseMidi.js input.mid my-song "My Song Title"
//   node parseMidi.js input.mid my-song "My Song Title" --quantize=8th
//   node parseMidi.js input.mid my-song "My Song Title" --target=2-4
//   node parseMidi.js input.mid my-song "My Song Title" --report-only
//
// Flags (all optional; positional args are input/outputName/title as before):
//   --velocity-threshold=<0..1>     Stage 1: drop notes below this velocity. Default 0.25.
//   --cluster-ms=<ms>                Stage 1: merge notes within this window (keep louder). Default 30. 0 disables.
//   --min-gap=<ms>                   Stage 2: enforce this minimum gap between hits. Default 150. 0 disables.
//   --quantize=<off|quarter|8th|16th> Stage 3: snap notes to this beat subdivision. Default off.
//   --target=<min>-<max>             Stage 4: auto-tune --min-gap to land notes/sec in this band (e.g. 2-4).
//   --auto                           Shorthand for --target=2-4.
//   --report-only                    Print the stage-by-stage breakdown; don't write the chart file.
//
// Output is written to public/charts/<outputName>.json (outputName defaults
// to the input file's basename).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "@tonejs/midi";

const { Midi } = pkg; // @tonejs/midi ships as CommonJS; no named ESM export

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_VELOCITY_THRESHOLD = 0.25;
const DEFAULT_CLUSTER_MS = 30;
const DEFAULT_MIN_GAP_MS = 150;
const DEFAULT_QUANTIZE = "off";
const DEFAULT_TARGET_BAND = [2, 4];

const QUANTIZE_DIVISORS = { quarter: 1, "8th": 2, "16th": 4 };

// --- argument parsing --------------------------------------------------
// Flags (--key=value or --key) are separated from positional args so flag
// order doesn't matter relative to input/outputName/title.
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
const [inputPathArg, outputNameArg, titleArg] = positional;

if (!inputPathArg) {
  console.error("Usage: node parseMidi.js <input.mid> [outputName] [title] [flags]");
  process.exit(1);
}

const velocityThreshold = flags["velocity-threshold"] !== undefined
  ? Number(flags["velocity-threshold"])
  : DEFAULT_VELOCITY_THRESHOLD;
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

const inputPath = path.resolve(inputPathArg);
const outputName = outputNameArg ?? path.basename(inputPath, path.extname(inputPath));
const outputPath = path.join(__dirname, "public", "charts", `${outputName}.json`);

let midiBytes;
try {
  midiBytes = readFileSync(inputPath);
} catch (err) {
  console.error(`Failed to read MIDI file at ${inputPath}:`, err.message);
  process.exit(1);
}

const midi = new Midi(new Uint8Array(midiBytes));

// Flatten every track's notes into one list — the chart format has no notion
// of separate tracks/instruments, just a single timeline of lane hits.
const rawNotes = midi.tracks.flatMap((track) => track.notes);

if (rawNotes.length === 0) {
  console.error("No notes found in this MIDI file (all tracks empty).");
  process.exit(1);
}

// Pitch -> lane: rather than a fixed split point (e.g. "middle C = lane
// boundary") or a naive `pitch % 8` (which ignores melodic contour entirely
// and can put adjacent pitches in unrelated lanes), scale this file's actual
// min-max pitch range across all 8 lanes. Low notes land in lanes 0-3ish,
// high notes in 4-7ish, and it self-calibrates to whatever octave range the
// source MIDI actually uses instead of assuming one. Computed from the full,
// unfiltered pitch range so lane assignment stays stable across filter
// settings — otherwise A/B-ing two configs would also silently shuffle lanes.
const pitches = rawNotes.map((note) => note.midi);
const minPitch = Math.min(...pitches);
const maxPitch = Math.max(...pitches);
const pitchRange = maxPitch - minPitch || 1; // avoid divide-by-zero on a single-pitch file

function pitchToLane(pitch) {
  const lane = Math.floor(((pitch - minPitch) / pitchRange) * 8);
  return Math.min(7, Math.max(0, lane)); // clamp: the top pitch would otherwise land exactly on lane 8
}

// @tonejs/midi resolves each note's onset to an absolute time in seconds
// already, using the file's own tempo map (including tempo changes) — no
// manual tick math needed. Carry velocity through the pipeline; it's
// stripped when the final chart notes are built.
const timedNotes = rawNotes
  .map((note) => ({ time: note.time * 1000, velocity: note.velocity, midi: note.midi }))
  .sort((a, b) => a.time - b.time);

const songDurationSec = midi.duration;

function density(notes) {
  return notes.length / songDurationSec;
}

// Generic sequential greedy merge: walk notes in time order, and whenever a
// note falls within `windowMs` of the last *kept* note, keep whichever of
// the two is louder and drop the other. Reused for Stage 1's cluster-merge,
// Stage 2's min-gap enforcement, and Stage 3's exact-tie dedupe after
// quantization — same rule ("closer than X apart -> keep the louder one"),
// just different windows and different inputs.
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

// Beat quantization using the MIDI's own tempo map (supports tempo changes:
// each note snaps relative to the most recent tempo event at or before it).
function quantizeNotes(notesSortedByTime, subdivision) {
  const divisor = QUANTIZE_DIVISORS[subdivision];
  const tempoSegments = midi.header.tempos
    .map((t) => ({ startMs: t.time * 1000, beatMs: 60000 / t.bpm }))
    .sort((a, b) => a.startMs - b.startMs);
  if (tempoSegments.length === 0 || tempoSegments[0].startMs > 0) {
    tempoSegments.unshift({ startMs: 0, beatMs: 60000 / (midi.header.tempos[0]?.bpm ?? 120) });
  }

  function segmentFor(timeMs) {
    let seg = tempoSegments[0];
    for (const candidate of tempoSegments) {
      if (candidate.startMs <= timeMs) seg = candidate;
      else break;
    }
    return seg;
  }

  const quantized = notesSortedByTime.map((note) => {
    const seg = segmentFor(note.time);
    const stepMs = seg.beatMs / divisor;
    const snapped = seg.startMs + Math.round((note.time - seg.startMs) / stepMs) * stepMs;
    return { ...note, time: snapped };
  });
  quantized.sort((a, b) => a.time - b.time);
  // Notes that snap onto the same grid point become an exact tie; a 1ms
  // window catches only true ties since the grid spacing (stepMs) is always
  // far larger than 1ms in practice.
  return mergeByWindow(quantized, 1);
}

// Stage 4: binary-search the Stage 2 min-gap value so resulting notes/sec
// lands inside [targetMin, targetMax]. Only min-gap is searched — quantize
// stays at whatever the caller chose, since it changes the *feel* (grid
// alignment) rather than just the count, and that choice is left to the
// caller rather than picked automatically.
function autoTuneMinGap(notesSortedByTime, [targetMin, targetMax]) {
  let lo = 0;
  let hi = 5000;
  let best = { minGapMs: 0, notes: notesSortedByTime, notesPerSec: density(notesSortedByTime) };
  for (let i = 0; i < 40 && hi - lo > 1; i++) {
    const mid = (lo + hi) / 2;
    const merged = mergeByWindow(notesSortedByTime, mid);
    const notesPerSec = density(merged);
    best = { minGapMs: mid, notes: merged, notesPerSec };
    if (notesPerSec >= targetMin && notesPerSec <= targetMax) break;
    if (notesPerSec > targetMax) lo = mid; // too dense -> need a bigger gap
    else hi = mid; // too sparse -> need a smaller gap
  }
  const roundedGap = Math.round(best.minGapMs / 5) * 5;
  const finalNotes = mergeByWindow(notesSortedByTime, roundedGap);
  return { minGapMs: roundedGap, notes: finalNotes, notesPerSec: density(finalNotes) };
}

// --- pipeline ------------------------------------------------------------

function report(label, notes) {
  console.log(`  ${label}: ${notes.length} notes, ${density(notes).toFixed(2)} notes/sec`);
}

console.log(`Raw MIDI: ${timedNotes.length} notes, ${density(timedNotes).toFixed(2)} notes/sec, ${songDurationSec.toFixed(1)}s`);

// Stage 1 — always on: velocity threshold, then cluster-merge.
console.log(`\nStage 1 — velocity filter (>= ${velocityThreshold}) + cluster-merge (< ${clusterMs}ms):`);
const afterVelocity = timedNotes.filter((n) => n.velocity >= velocityThreshold);
report("after velocity filter", afterVelocity);
const afterCluster = mergeByWindow(afterVelocity, clusterMs);
report("after cluster-merge", afterCluster);

let working = afterCluster;

// Stage 3 first (if enabled) — quantize before min-gap, so min-gap operates
// on the already-snapped grid rather than the raw performance timing.
if (quantize !== "off") {
  console.log(`\nStage 3 — beat quantization (${quantize} note grid):`);
  working = quantizeNotes(working, quantize);
  report("after quantize", working);
}

// Stage 2 / Stage 4 — either a fixed min-gap, or auto-tuned to a target band.
let finalMinGapMs = minGapMs;
if (targetBand) {
  console.log(`\nStage 4 — auto-tuning min-gap to land in [${targetBand[0]}, ${targetBand[1]}] notes/sec:`);
  const beforeAuto = density(working);
  if (beforeAuto < targetBand[0]) {
    console.log(
      `  WARNING: already at ${beforeAuto.toFixed(2)} notes/sec before any spacing filter — ` +
        `below the target band. Min-gap and quantize can only remove notes, not add them; ` +
        `loosen --velocity-threshold or --cluster-ms (Stage 1) to retain more, or lower --target.`
    );
    finalMinGapMs = 0;
    working = mergeByWindow(working, 0);
  } else {
    const tuned = autoTuneMinGap(working, targetBand);
    finalMinGapMs = tuned.minGapMs;
    working = tuned.notes;
    console.log(`  converged min-gap: ${finalMinGapMs}ms`);
  }
  report("after auto-tuned min-gap", working);
} else if (minGapMs > 0) {
  console.log(`\nStage 2 — minimum inter-note spacing (${minGapMs}ms):`);
  working = mergeByWindow(working, minGapMs);
  report("after min-gap", working);
}

console.log(
  `\nFinal: ${working.length} notes, ${density(working).toFixed(2)} notes/sec ` +
    `(raw was ${density(timedNotes).toFixed(2)} notes/sec)`
);

if (reportOnly) {
  console.log("\n--report-only set: chart file not written.");
  process.exit(0);
}

const notes = working
  .map((note, i) => ({
    id: `n${i + 1}`,
    time: Math.round(note.time),
    x: pitchToLane(note.midi),
    type: "tap"
  }))
  .sort((a, b) => a.time - b.time);

const bpm = Math.round(midi.header.tempos[0]?.bpm ?? 120);
const songLengthMs = Math.max(1000, Math.round(midi.duration * 1000));

const chart = {
  meta: {
    title: titleArg ?? "Converted Track",
    bpm,
    songLengthMs
  },
  notes
};

writeFileSync(outputPath, JSON.stringify(chart, null, 2) + "\n", { encoding: "utf8" });

console.log(`\nWrote ${notes.length} notes to ${path.relative(__dirname, outputPath)}`);
console.log(`  bpm: ${bpm}, songLengthMs: ${songLengthMs}, pitch range: ${minPitch}-${maxPitch}`);
