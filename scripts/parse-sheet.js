// Sheet -> score JSON: the single source of truth every song is built from.
// Converts a piano sheet (.musicxml/.xml, or .mid as fallback) into
// public/scores/<id>.json — the FULL performance: every note's onset (ms),
// duration (ms), MIDI pitch, velocity (0..1), and hand ("L"|"R").
//
// The score is what the in-browser PianoSynth actually plays at runtime, and
// what generate-chart.js thins into a playable chart — both derive from this
// one file, which is what guarantees audio/chart sync by construction.
//
// Hand detection (drives the lane 0-3 = left hand / 4-7 = right hand split):
//   MusicXML: <staff> element — staff 1 = R (treble), staff 2 = L (bass).
//             Single-staff multi-part files fall back to per-part avg pitch.
//   MIDI:     with >= 2 note-bearing tracks, track names ("treble"/"upper"/
//             "right" vs "bass"/"lower"/"left") or, failing that, average
//             pitch decide which track is which hand. A single-track MIDI
//             falls back to a global median pitch split — heuristic, warned
//             loudly, since a performance MIDI has no real hand data.
//
// MusicXML v1 scope: score-partwise, divisions, note/chord/rest, backup/
// forward, tie merging, <sound tempo> changes, <sound dynamics> velocity.
// Repeats/voltas and grace notes are SKIPPED WITH A WARNING, never silently.
//
// Usage: node scripts/parse-sheet.js <input.musicxml|.xml|.mid> [id] [title]
// Output: public/scores/<id>.json (id defaults to the input's basename)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import pkg from "@tonejs/midi";

const { Midi } = pkg; // @tonejs/midi ships as CommonJS; no named ESM export

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [, , inputPathArg, idArg, titleArg] = process.argv;

if (!inputPathArg) {
  console.error("Usage: node scripts/parse-sheet.js <input.musicxml|.xml|.mid> [id] [title]");
  process.exit(1);
}

const inputPath = path.resolve(inputPathArg);
const ext = path.extname(inputPath).toLowerCase();
const id = idArg ?? path.basename(inputPath, path.extname(inputPath));
const outputPath = path.join(__dirname, "..", "public", "scores", `${id}.json`);

// --- shared helpers --------------------------------------------------------

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Right-hand-ish vs left-hand-ish track/part names, checked case-insensitively.
const RIGHT_HINTS = ["treble", "upper", "right", "rh"];
const LEFT_HINTS = ["bass", "lower", "left", "lh"];

function handFromName(name) {
  const n = (name ?? "").toLowerCase();
  if (RIGHT_HINTS.some((h) => n.includes(h))) return "R";
  if (LEFT_HINTS.some((h) => n.includes(h))) return "L";
  return null;
}

// Fallback for note groups with no structural hand data: split at the global
// median pitch. Crude (real hands cross), hence the loud warning at the call site.
function assignHandsByPitchSplit(notes) {
  const sorted = notes.map((n) => n.midi).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  for (const note of notes) note.hand = note.midi >= median ? "R" : "L";
}

// --- MIDI path ---------------------------------------------------------------

function parseMidiFile(bytes) {
  const midi = new Midi(new Uint8Array(bytes));
  const noteTracks = midi.tracks.filter((t) => t.notes.length > 0);

  if (noteTracks.length === 0) {
    console.error("No notes found in this MIDI file (all tracks empty).");
    process.exit(1);
  }

  // Decide each note-bearing track's hand: name hints first, then average
  // pitch (higher of the two = right hand). One track only -> pitch split.
  const trackHands = noteTracks.map((t) => handFromName(t.name));

  if (noteTracks.length >= 2 && trackHands.some((h) => h === null)) {
    const avgPitch = (t) => t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length;
    const avgs = noteTracks.map(avgPitch);
    // Tracks whose average pitch sits in the upper half of the avg-pitch range
    // become R, the rest L — for the common 2-track grand-staff export this is
    // exactly "upper staff = R, lower staff = L".
    const midpoint = (Math.min(...avgs) + Math.max(...avgs)) / 2;
    for (let i = 0; i < noteTracks.length; i++) {
      if (trackHands[i] === null) trackHands[i] = avgs[i] >= midpoint ? "R" : "L";
    }
  }

  const notes = [];
  noteTracks.forEach((track, i) => {
    for (const n of track.notes) {
      notes.push({
        time: Math.round(n.time * 1000),
        durationMs: Math.max(1, Math.round(n.duration * 1000)),
        midi: n.midi,
        velocity: clamp01(n.velocity),
        hand: trackHands[i] // null for the single-track case, filled below
      });
    }
  });

  if (noteTracks.length === 1) {
    console.warn(
      "WARNING: single-track MIDI has no hand data — assigning hands by a global " +
        "median pitch split. Prefer a two-staff (treble/bass) source if one exists."
    );
    assignHandsByPitchSplit(notes);
  } else {
    const hands = trackHands.map((h, i) => `track ${i} "${noteTracks[i].name}" -> ${h}`).join(", ");
    console.log(`Hand assignment: ${hands}`);
  }

  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  return {
    title: midi.header.name || null,
    bpm: Math.round(midi.header.tempos[0]?.bpm ?? 120),
    durationMs: Math.round(midi.duration * 1000),
    notes
  };
}

// --- MusicXML path -----------------------------------------------------------

// fast-xml-parser with preserveOrder so <note>/<backup>/<forward> sequence
// within a measure survives — their document order IS the timing information.
function parseMusicXmlFile(text) {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseTagValue: false // keep values as strings; we convert numbers explicitly
  });
  const doc = parser.parse(text);

  // preserveOrder shape: array of { tagName: children[], ":@": attrs }.
  const findAll = (nodes, tag) => (nodes ?? []).filter((n) => n[tag] !== undefined);
  const findFirst = (nodes, tag) => findAll(nodes, tag)[0];
  const children = (node) => (node ? node[Object.keys(node).find((k) => k !== ":@")] : []);
  const attrs = (node) => node?.[":@"] ?? {};
  const textOf = (node) => {
    // A leaf like <duration>4</duration> parses to { duration: [{ "#text": "4" }] }
    const kids = children(node);
    const t = kids?.find((k) => k["#text"] !== undefined);
    return t ? String(t["#text"]) : "";
  };
  const numOf = (node) => Number(textOf(node));

  const root = findFirst(doc, "score-partwise");
  if (!root) {
    console.error("Unsupported MusicXML: only score-partwise documents are handled (score-timewise is not).");
    process.exit(1);
  }
  const rootKids = children(root);

  // Title, if present.
  const workNode = findFirst(rootKids, "work");
  const title = workNode ? textOf(findFirst(children(workNode), "work-title")) || null : null;

  const STEP_TO_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  const parts = findAll(rootKids, "part");
  if (parts.length === 0) {
    console.error("No <part> elements found in this MusicXML file.");
    process.exit(1);
  }

  // All times below are tracked in BEATS (quarter notes) — divisions-agnostic —
  // then converted to ms at the end via the collected tempo map.
  const tempoEvents = []; // { beat, bpm }
  const allNotes = []; // { beat, durationBeats, midi, velocity, staff, partIndex }
  let skippedGraceNotes = 0;
  let sawRepeats = false;

  parts.forEach((partNode, partIndex) => {
    let divisions = 1; // divisions per quarter note; updated by <attributes>
    let beat = 0; // current position in quarter notes
    let lastOnsetBeat = 0; // onset of the most recent non-chord note; chord notes reuse it
    let currentDynamicsVelocity = null; // from <sound dynamics>, 0..1
    // Open ties keyed by midi+staff, so a tie's stop-note extends the start-note.
    const openTies = new Map();

    for (const measure of findAll(children(partNode), "measure")) {
      for (const el of children(measure)) {
        if (el.attributes !== undefined) {
          const divNode = findFirst(children(el), "divisions");
          if (divNode) divisions = numOf(divNode) || divisions;
        } else if (el.direction !== undefined || el.sound !== undefined) {
          // <sound> can appear directly in the measure or nested in <direction>.
          const soundNodes = el.sound !== undefined ? [el] : findAll(children(el), "sound");
          for (const s of soundNodes) {
            const a = attrs(s);
            if (a.tempo !== undefined) tempoEvents.push({ beat, bpm: Number(a.tempo) });
            // sound dynamics = percentage of MIDI forte (90); normalize to 0..1 velocity.
            if (a.dynamics !== undefined) currentDynamicsVelocity = clamp01((Number(a.dynamics) / 100) * (90 / 127));
          }
        } else if (el.backup !== undefined) {
          beat -= numOf(findFirst(children(el), "duration")) / divisions;
        } else if (el.forward !== undefined) {
          beat += numOf(findFirst(children(el), "duration")) / divisions;
        } else if (el.barline !== undefined) {
          if (findFirst(children(el), "repeat")) sawRepeats = true;
        } else if (el.note !== undefined) {
          const kids = children(el);
          const isGrace = findFirst(kids, "grace") !== undefined;
          const isChord = findFirst(kids, "chord") !== undefined;
          const isRest = findFirst(kids, "rest") !== undefined;
          const durationDiv = numOf(findFirst(kids, "duration")) || 0;
          const durationBeats = durationDiv / divisions;

          if (isGrace) {
            skippedGraceNotes++;
            continue; // grace notes have no duration; skipped (warned once below)
          }

          // A chord note sounds at the PREVIOUS note's onset — time doesn't advance
          // for it, and it doesn't advance time itself.
          const onsetBeat = isChord ? lastOnsetBeat : beat;

          if (!isRest) {
            const pitchNode = findFirst(kids, "pitch");
            if (pitchNode) {
              const pk = children(pitchNode);
              const step = textOf(findFirst(pk, "step"));
              const alter = findFirst(pk, "alter") ? numOf(findFirst(pk, "alter")) : 0;
              const octave = numOf(findFirst(pk, "octave"));
              const midi = (octave + 1) * 12 + STEP_TO_SEMITONE[step] + alter;

              const staffNode = findFirst(kids, "staff");
              const staff = staffNode ? numOf(staffNode) : null;

              const tieTypes = findAll(kids, "tie").map((t) => attrs(t).type);
              const tieKey = `${midi}|${staff ?? "-"}`;

              if (tieTypes.includes("stop") && openTies.has(tieKey)) {
                // Extend the tied-from note instead of emitting a new onset.
                const started = openTies.get(tieKey);
                started.durationBeats = onsetBeat + durationBeats - started.beat;
                if (!tieTypes.includes("start")) openTies.delete(tieKey);
              } else {
                const note = {
                  beat: onsetBeat,
                  durationBeats,
                  midi,
                  velocity: currentDynamicsVelocity ?? 0.7,
                  staff,
                  partIndex
                };
                allNotes.push(note);
                if (tieTypes.includes("start")) openTies.set(tieKey, note);
              }
            }
          }

          if (!isChord) {
            lastOnsetBeat = beat;
            beat += durationBeats;
          }
        }
      }
    }
  });

  if (allNotes.length === 0) {
    console.error("No pitched notes found in this MusicXML file.");
    process.exit(1);
  }
  if (skippedGraceNotes > 0) {
    console.warn(`WARNING: skipped ${skippedGraceNotes} grace note(s) — grace notes are not supported (v1).`);
  }
  if (sawRepeats) {
    console.warn(
      "WARNING: this score contains repeat barlines, which are NOT expanded (v1) — " +
        "the score plays through in written order only. Expand repeats in your editor before exporting."
    );
  }

  // beats -> ms via the tempo map (piecewise-constant bpm segments).
  tempoEvents.sort((a, b) => a.beat - b.beat);
  if (tempoEvents.length === 0 || tempoEvents[0].beat > 0) {
    tempoEvents.unshift({ beat: 0, bpm: tempoEvents[0]?.bpm ?? 120 });
  }
  function beatToMs(beat) {
    let ms = 0;
    for (let i = 0; i < tempoEvents.length; i++) {
      const seg = tempoEvents[i];
      const segEnd = tempoEvents[i + 1]?.beat ?? Infinity;
      if (beat <= seg.beat) break;
      const beatsInSeg = Math.min(beat, segEnd) - seg.beat;
      ms += beatsInSeg * (60000 / seg.bpm);
      if (beat <= segEnd) break;
    }
    return ms;
  }

  // Hand assignment: explicit grand-staff <staff> data wins; otherwise
  // per-part (multi-part files), otherwise the pitch-split fallback.
  const hasStaffData = allNotes.some((n) => n.staff !== null && n.staff >= 2);
  if (hasStaffData) {
    for (const n of allNotes) n.hand = (n.staff ?? 1) === 1 ? "R" : "L";
    console.log("Hand assignment: from <staff> elements (1 = right, 2 = left)");
  } else if (parts.length >= 2) {
    const partAvg = parts.map((_, pi) => {
      const ns = allNotes.filter((n) => n.partIndex === pi);
      return ns.length ? ns.reduce((s, n) => s + n.midi, 0) / ns.length : -Infinity;
    });
    const maxAvg = Math.max(...partAvg);
    for (const n of allNotes) n.hand = partAvg[n.partIndex] === maxAvg ? "R" : "L";
    console.log("Hand assignment: by per-part average pitch (no <staff> data)");
  } else {
    console.warn("WARNING: no <staff> data and a single part — assigning hands by a global median pitch split.");
    assignHandsByPitchSplit(allNotes);
  }

  const notes = allNotes
    .map((n) => ({
      time: Math.round(beatToMs(n.beat)),
      durationMs: Math.max(1, Math.round(beatToMs(n.beat + n.durationBeats) - beatToMs(n.beat))),
      midi: n.midi,
      velocity: n.velocity,
      hand: n.hand
    }))
    .sort((a, b) => a.time - b.time || a.midi - b.midi);

  const durationMs = Math.max(...notes.map((n) => n.time + n.durationMs));

  return {
    title,
    bpm: Math.round(tempoEvents[0].bpm),
    durationMs,
    notes
  };
}

// --- main --------------------------------------------------------------------

let parsed;
if (ext === ".mid" || ext === ".midi") {
  parsed = parseMidiFile(readFileSync(inputPath));
} else if (ext === ".musicxml" || ext === ".xml") {
  parsed = parseMusicXmlFile(readFileSync(inputPath, "utf8"));
} else if (ext === ".mxl") {
  console.error(".mxl (compressed MusicXML) is not supported — export uncompressed .musicxml from your editor.");
  process.exit(1);
} else {
  console.error(`Unrecognized sheet format "${ext}" — expected .musicxml, .xml, or .mid`);
  process.exit(1);
}

const score = {
  meta: {
    title: titleArg ?? parsed.title ?? id,
    bpm: parsed.bpm,
    durationMs: parsed.durationMs
  },
  notes: parsed.notes
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(score) + "\n", { encoding: "utf8" });

const perHand = score.notes.reduce((acc, n) => ((acc[n.hand] = (acc[n.hand] ?? 0) + 1), acc), {});
console.log(
  `Wrote ${path.relative(path.join(__dirname, ".."), outputPath)}: ` +
    `${score.notes.length} notes (L: ${perHand.L ?? 0}, R: ${perHand.R ?? 0}), ` +
    `${(score.meta.durationMs / 1000).toFixed(1)}s, bpm ${score.meta.bpm}, ` +
    `title "${score.meta.title}"`
);
