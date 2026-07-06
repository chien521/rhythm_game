// One-off generator for public/audio/track.wav — a synthesized 120bpm metronome
// click track, standing in for a real licensed music asset. WAV is a real,
// decodable audio file (fetch + decodeAudioData handles it exactly like MP3),
// so this satisfies "async load + decode a real audio file" without needing
// an external encoder (ffmpeg/lame aren't available in this environment).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "..", "public", "audio", "track.wav");

const SAMPLE_RATE = 44100;
const DURATION_SEC = 30;
const BPM = 120;
const BEAT_INTERVAL_SEC = 60 / BPM;

const totalSamples = Math.ceil(SAMPLE_RATE * DURATION_SEC);
const samples = new Float32Array(totalSamples);

for (let beatTime = 0; beatTime < DURATION_SEC; beatTime += BEAT_INTERVAL_SEC) {
  const startSample = Math.floor(beatTime * SAMPLE_RATE);
  const clickDurationSec = 0.1;
  const clickSamples = Math.floor(clickDurationSec * SAMPLE_RATE);

  for (let i = 0; i < clickSamples; i++) {
    const idx = startSample + i;
    if (idx >= totalSamples) break;
    const t = i / SAMPLE_RATE;
    // Same envelope shape as the old OfflineAudioContext synth: fast attack, exponential-ish decay.
    const attack = Math.min(1, t / 0.005);
    const decay = Math.exp(-t / 0.03);
    const envelope = attack * decay;
    samples[idx] += Math.sin(2 * Math.PI * 880 * t) * envelope * 0.6;
  }
}

// Encode as 16-bit PCM mono WAV.
const bytesPerSample = 2;
const dataSize = totalSamples * bytesPerSample;
const buffer = Buffer.alloc(44 + dataSize);

buffer.write("RIFF", 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write("WAVE", 8);
buffer.write("fmt ", 12);
buffer.writeUInt32LE(16, 16); // fmt chunk size
buffer.writeUInt16LE(1, 20); // PCM format
buffer.writeUInt16LE(1, 22); // mono
buffer.writeUInt32LE(SAMPLE_RATE, 24);
buffer.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28); // byte rate
buffer.writeUInt16LE(bytesPerSample, 32); // block align
buffer.writeUInt16LE(16, 34); // bits per sample
buffer.write("data", 36);
buffer.writeUInt32LE(dataSize, 40);

for (let i = 0; i < totalSamples; i++) {
  const clamped = Math.max(-1, Math.min(1, samples[i]));
  buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * bytesPerSample);
}

writeFileSync(outPath, buffer);
console.log(`Wrote ${outPath} (${(buffer.length / 1024).toFixed(1)} KB, ${DURATION_SEC}s @ ${SAMPLE_RATE}Hz)`);
