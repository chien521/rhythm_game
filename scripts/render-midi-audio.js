// Renders a MIDI file straight to a playable WAV using a simple additive
// synth (sine fundamental + two decaying harmonics, ADSR envelope per note) —
// the same technique as generate-track.js's metronome click, just driven by
// real note-on/velocity/duration data from @tonejs/midi instead of a fixed
// beat grid. Not meant to sound like a real piano; it exists so a chart
// generated from this same MIDI file (via parseMidi.js) and its paired audio
// are GUARANTEED to agree on duration/timing, since both come from one
// source of truth. Swap in a real soundfont render later as a polish pass —
// the chart stays valid either way, since it was never derived from this
// audio file, only from the MIDI.
//
// Usage: node scripts/render-midi-audio.js <input.mid> [outputName]
// Output: public/audio/<outputName>.wav (outputName defaults to the input's basename)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "@tonejs/midi";

const { Midi } = pkg; // @tonejs/midi ships as CommonJS; no named ESM export

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [, , inputPathArg, outputNameArg] = process.argv;

if (!inputPathArg) {
  console.error("Usage: node scripts/render-midi-audio.js <input.mid> [outputName]");
  process.exit(1);
}

const inputPath = path.resolve(inputPathArg);
const outputName = outputNameArg ?? path.basename(inputPath, path.extname(inputPath));
const outputPath = path.join(__dirname, "..", "public", "audio", `${outputName}.wav`);

const midi = new Midi(new Uint8Array(readFileSync(inputPath)));
const notes = midi.tracks.flatMap((track) => track.notes);

if (notes.length === 0) {
  console.error("No notes found in this MIDI file (all tracks empty).");
  process.exit(1);
}

const SAMPLE_RATE = 44100;
const RELEASE_TAIL_SEC = 1.5; // safety margin so the last note's release/decay never gets clipped
const totalSamples = Math.ceil((midi.duration + RELEASE_TAIL_SEC) * SAMPLE_RATE);
const samples = new Float32Array(totalSamples);

const midiToFreq = (pitch) => 440 * Math.pow(2, (pitch - 69) / 12);

// Additive synth: fundamental + 2nd/3rd harmonic (each with its own faster
// decay, so the timbre brightens on attack then settles toward the
// fundamental) inside a fast-attack / note-length sustain / exponential-
// release envelope. velocity (0..1 from @tonejs/midi) scales amplitude.
function renderNote(note) {
  const freq = midiToFreq(note.midi);
  const startSample = Math.floor(note.time * SAMPLE_RATE);
  const durationSec = Math.max(0.05, note.duration);
  const attackSec = 0.005;
  const releaseSec = Math.max(0.2, durationSec * 0.3);
  const totalNoteSamples = Math.ceil((durationSec + releaseSec) * SAMPLE_RATE);
  const amp = 0.22 * note.velocity;

  for (let i = 0; i < totalNoteSamples; i++) {
    const idx = startSample + i;
    if (idx < 0 || idx >= samples.length) continue;

    const t = i / SAMPLE_RATE;
    const attackEnv = Math.min(1, t / attackSec);
    const releaseEnv = t < durationSec ? 1 : Math.exp(-(t - durationSec) / (releaseSec / 3));
    const envelope = attackEnv * releaseEnv;

    const wave =
      Math.sin(2 * Math.PI * freq * t) +
      0.5 * Math.sin(2 * Math.PI * freq * 2 * t) * Math.exp(-t * 3) +
      0.25 * Math.sin(2 * Math.PI * freq * 3 * t) * Math.exp(-t * 5);

    samples[idx] += wave * envelope * amp;
  }
}

for (const note of notes) renderNote(note);

// Peak-normalize only if summed notes clipped past [-1, 1] — leaves quiet
// passages alone, only pulls down genuinely overloaded ones.
let peak = 0;
for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
if (peak > 1) {
  const scale = 0.98 / peak;
  for (let i = 0; i < samples.length; i++) samples[i] *= scale;
}

// Encode as 16-bit PCM mono WAV (same header-writing approach as generate-track.js).
const bytesPerSample = 2;
const dataSize = samples.length * bytesPerSample;
const buffer = Buffer.alloc(44 + dataSize);

buffer.write("RIFF", 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write("WAVE", 8);
buffer.write("fmt ", 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(1, 22);
buffer.writeUInt32LE(SAMPLE_RATE, 24);
buffer.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28);
buffer.writeUInt16LE(bytesPerSample, 32);
buffer.writeUInt16LE(16, 34);
buffer.write("data", 36);
buffer.writeUInt32LE(dataSize, 40);

for (let i = 0; i < samples.length; i++) {
  const clamped = Math.max(-1, Math.min(1, samples[i]));
  buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * bytesPerSample);
}

writeFileSync(outputPath, buffer);
console.log(
  `Wrote ${path.relative(path.join(__dirname, ".."), outputPath)} ` +
    `(${(buffer.length / 1024 / 1024).toFixed(2)} MB, ${midi.duration.toFixed(2)}s + ${RELEASE_TAIL_SEC}s tail, ${notes.length} notes)`
);
