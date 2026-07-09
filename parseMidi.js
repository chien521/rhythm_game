// Standalone CLI: converts a MIDI file into a ChartData JSON matching this
// game's public/charts/*.json schema ({ meta: { title, bpm, songLengthMs },
// notes: [{ id, time, x, type }] }). Not part of the built app — a one-off
// authoring tool, run with `node parseMidi.js <input.mid> [outputName] [title]`.
//
// Usage:
//   node parseMidi.js input.mid
//   node parseMidi.js input.mid my-song "My Song Title"
//
// Output is written to public/charts/<outputName>.json (outputName defaults
// to the input file's basename).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "@tonejs/midi";

const { Midi } = pkg; // @tonejs/midi ships as CommonJS; no named ESM export

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [, , inputPathArg, outputNameArg, titleArg] = process.argv;

if (!inputPathArg) {
  console.error("Usage: node parseMidi.js <input.mid> [outputName] [title]");
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
// source MIDI actually uses instead of assuming one.
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
// manual tick math needed.
const notes = rawNotes
  .map((note, i) => ({
    id: `n${i + 1}`,
    time: Math.round(note.time * 1000),
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

console.log(`Wrote ${notes.length} notes to ${path.relative(__dirname, outputPath)}`);
console.log(`  bpm: ${bpm}, songLengthMs: ${songLengthMs}, pitch range: ${minPitch}-${maxPitch}`);
