# rhythm_game

## Project purpose

Deemo-style rhythm game: falling notes across 8 lanes, hit-timing judgment.
Built with Vite + TypeScript + Canvas 2D. Target deployment is an HTC
VIVERSE widget (see `npm run build:viverse`).

Core design principle: **zero audio/gameplay drift**. Timing is anchored to
the Web Audio API's `AudioContext.currentTime` — never `<audio>` element
polling and never `requestAnimationFrame` deltas. Any change touching note
scheduling, playback, or chart timing must preserve this.

## Lane / hand mapping convention

- Lanes 0-3 = left hand (`Q W E R`) = piano LEFT hand parts
- Lanes 4-7 = right hand (`J K L ;`) = piano RIGHT hand parts

This is intentional, not incidental. When generating charts from MIDI, route
notes by hand/voice where the source data allows it, not just by proportional
pitch range — a low note played by the right hand should still land in lanes
4-7.

## Chart data philosophy

A chart is not "done" until it's validated against real audio duration:

```
npm run validate:charts
```

Charts must **never** be pure bpm-formula-generated placeholders (evenly
spaced note timestamps). That was the original root cause of audio/chart
sync issues in this project and is easy to reintroduce accidentally by
"simplifying" a chart generator.

Real charts come from one of:
- (a) parsing an actual MIDI file's note timing via `parseMidi.js` or
  `generate-hand-chart.js`
- (b) Recording Mode — tapping along to real audio, with timestamps captured
  live

Target chart density is **~2-4 notes/sec** for Normal difficulty. Raw
flattened MIDI note-on events are not 1:1 with playable "beats" — they need
thinning (velocity filtering, min-gap enforcement, optional beat
quantization) or the chart will feel busier than the music actually sounds.
See the flag documentation at the top of `parseMidi.js` for the tunable
pipeline stages.

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
| `parseMidi.js` | MIDI -> chart JSON, basic version, tunable density pipeline |
| `generate-hand-chart.js` | MIDI -> chart JSON with RH/LH voice separation (current best approach) |
| `scripts/render-midi-audio.js` | MIDI -> WAV synth render, guarantees audio/chart timeline agreement |
| `scripts/validate-charts.js` | Checks every song's chart `songLengthMs` against real audio file duration |

## Known open issues

- Two-hand chart generation is a heuristic (velocity-based hand split), not
  literal sheet transcription — currently being tested for feel, not
  confirmed final.
- `gymnopedie` and `waltz_for_debby` still need real charts via Recording
  Mode. Check `npm run validate:charts` for current PASS/FAIL — as of the
  last check both FAIL (chart length far short of actual audio length).
- `chopin.mp3` (the original real recording) is unused/orphaned on disk —
  the project currently uses `chopin.wav` (synth-rendered from `chopin.mid`)
  instead, for guaranteed zero drift.

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

Note: because `validate:charts` currently fails for `gymnopedie` and
`waltz_for_debby` (see Known open issues above), the Stop hook will keep
skipping auto-push for *any* change — even unrelated ones — until those two
charts are fixed or excluded. That's the gate working as intended, not a
bug; if it's ever too aggressive, narrow the gate to only run
`validate:charts` for songs actually touched in the diff.

Both scripts hard-check that `origin` points at
`github.com/chien521/rhythm_game` before doing anything, so this automation
never fires against the wrong remote if the repo is ever cloned/forked
elsewhere.
