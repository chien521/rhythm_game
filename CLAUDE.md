# rhythm_game

## Project purpose

Deemo-style rhythm game: falling notes across 8 lanes, hit-timing judgment.
Built with Vite + TypeScript + Canvas 2D. Target deployment is an HTC
VIVERSE widget (see `npm run build:viverse`).

Core design principle: **zero audio/gameplay drift**. Timing is anchored to
the Web Audio API's `AudioContext.currentTime` — never `<audio>` element
polling and never `requestAnimationFrame` deltas. Any change touching note
scheduling, playback, or chart timing must preserve this.

## Single-source-of-truth content pipeline

There are **no audio files**. The game itself performs each song: a sampled
piano synth (`src/core/PianoSynth.ts`, Salamander samples in
`public/samples/piano/`) schedules every note of a **score JSON** at exact
`AudioContext` timestamps. The playable **chart JSON** is a thinned subset of
that same score's onsets. Both derive from one sheet file, so audio/chart
drift is impossible by construction — never reintroduce a separately-authored
audio file or a bpm-formula-generated placeholder chart (the original root
cause of this project's sync bugs).

```
sheets/<song>.musicxml|.mid
  │  npm run parse:sheet -- sheets/<file> <id> "<Title>"
  ▼
public/scores/<id>.json        full performance (what the piano plays)
  │  npm run generate:chart -- <id> [--target=2-4] [--report-only]
  ▼
public/charts/<id>.json        playable chart (what the player hits)
```

Then add/point the entry in `public/songs.json` (`scoreUrl` + `charts`).

- `parse-sheet.js` reads MusicXML (primary; real `<staff>` hand data) or MIDI
  (fallback; hand from track names/avg pitch, or a warned median-pitch split
  for single-track files). Repeats/voltas and grace notes are skipped WITH A
  WARNING — never silently.
- `generate-chart.js` thins density in tunable stages (velocity filter →
  per-hand cluster-merge → optional quantize → per-hand min-gap /
  `--target` auto-tune). Thinning only ever REMOVES notes; every chart note
  keeps its exact score onset. `--quantize` breaks that guarantee (stamps
  `meta.quantized`) and is off by default — avoid it.
- Sheet sources live in `sheets/` and are committed — they ARE the source of
  truth. Both current songs came from the Mutopia Project (public domain).

## Lane / hand mapping convention

- Lanes 0-3 = left hand (`Q W E R`) = piano LEFT hand parts
- Lanes 4-7 = right hand (`J K L ;`) = piano RIGHT hand parts

This is intentional, not incidental. Hand data comes from the score
(`hand: "L" | "R"` per note); within a hand, pitch position picks the lane
inside the 4-lane block. Cluster-merge and min-gap run PER HAND on purpose:
a simultaneous L+R hit is a deliberate two-hand chord, not noise to collapse.

## Chart validation

A chart is not "done" until `npm run validate:charts` passes. It checks every
manifest song's chart against its score: length agreement, **every chart note
time is an exact score onset** (i.e. everything you're asked to hit is a note
the piano actually plays), lanes 0-7, sorted times, unique ids. Non-zero exit
on failure — the Stop hook uses it as the auto-push gate.

Target chart density is **~2-4 notes/sec** for Normal difficulty, but respect
the music: Gymnopédie No. 1 is genuinely sparse (~1.1 notes/sec) and forcing
it denser would be wrong. Use `--report-only` to A/B settings.

## Verification standing instruction

Do not report a chart-generation or sync-related task as complete based on a
commit message or code comment alone. Verify against actual output — e.g.
after any chart-generation change, run `validate:charts` AND report actual
before/after note counts. A prior commit's message once claimed filtering
logic that wasn't actually implemented in the diff — treat "looks done" with
suspicion until confirmed with real numbers.

## Key file map

| File | Purpose |
|---|---|
| `scripts/parse-sheet.js` | MusicXML/MIDI sheet -> score JSON (with hands) |
| `scripts/generate-chart.js` | score JSON -> chart JSON, staged density thinning |
| `scripts/validate-charts.js` | chart-vs-score integrity gate (length, exact onsets, structure) |
| `src/core/PianoSynth.ts` | sampled-piano playback scheduled on the audio clock |
| `src/core/AudioManager.ts` | the game clock (`getSongTime()`) + score playback control |
| `sheets/` | committed sheet sources (the single source of truth per song) |

## Known open issues / notes

- `AUDIO_OFFSET_MS` was reset to 0 when playback moved to PianoSynth (the old
  1400 was calibrated for the removed decoded-WAV path). Recalibrate by feel
  if hits consistently judge early/late on a given device.
- Sustain-pedal resonance is not modeled — notes decay naturally until their
  written end plus a release ramp. Acceptable v1; polish item.
- MusicXML support is v1: score-partwise only, no repeats/voltas expansion,
  no grace notes, no `.mxl` (export uncompressed `.musicxml`). All limits
  warn loudly when hit.
- `sheets/chopin_performance.mid` is the old single-track performance MIDI
  (unused; the active source is `sheets/chopin_nocturne_op9_n2.mid`, which
  has real upper/lower staff tracks).

## Multi-machine workflow and Git automation

This repo is worked on from two machines — a personal laptop and an
enterprise desktop — so the working tree needs to stay in sync without
manual `git pull`/`git add`/`git commit`/`git push` on every switch. Two
project hooks (checked into `.claude/settings.json`, so they apply on both
machines) handle this automatically:

### SessionStart — `.claude/hooks/session-start-sync.cjs`

When a Claude Code session starts, it fetches `origin/main` and:
- If there's nothing new upstream, does nothing (silent).
- If upstream has new commits **and** the working tree is clean **and** the
  local branch can fast-forward cleanly, it auto-pulls.
- If the working tree is dirty, or local/remote history has diverged, it
  does **not** auto-pull or auto-merge — it prints a notice
  (`origin/main has N commit(s) not present locally -- resolve manually`)
  and leaves it for manual resolution.

### Stop — `.claude/hooks/stop-auto-sync.cjs`

When a Claude Code turn ends, it checks for uncommitted changes and, if any
exist, runs the project's build/validate gate before syncing:

- `npx tsc -b --noEmit`
- `npm run validate:charts`

If both pass, it auto-commits everything and pushes to `origin main`
**silently, with no confirmation prompt** (this is a solo personal repo, so
that tradeoff is intentional). If either check fails, it does **not**
commit or push — it leaves the working tree exactly as-is and prints a
notice that auto-sync was skipped because the build is currently broken.
This is deliberate: a mid-work broken state should never silently become
what's waiting on the other machine.

Both scripts hard-check that `origin` points at
`github.com/chien521/rhythm_game` before doing anything, so this automation
never fires against the wrong remote if the repo is ever cloned/forked
elsewhere.
